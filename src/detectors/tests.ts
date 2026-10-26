import type { Finding, LogLine } from '../types.js';
import { toEvidence, patternRule, type DetectContext, type Detector } from './rule.js';
import { plural } from './util.js';

// Jest / Vitest summary lines, only when they report at least one failure.
const JEST_SUMMARY_RE = /^\s*Tests:\s+.*\b([1-9]\d*) failed\b/;
const VITEST_SUMMARY_RE = /^\s*Tests\s+.*\b([1-9]\d*) failed\b/;
const MOCHA_FAILING_RE = /^\s*([1-9]\d*) failing\b/;
const TAP_FAIL_RE = /^# fail ([1-9]\d*)\b/;
// Jest prints failures as "<black circle> suite > test"; node:test prints a "cross mark" summary.
// Built from code points (not literals) so the source stays ASCII, and deliberately NOT a loose
// "any non-ASCII bullet" class: check marks and dots appear all over normal CI output.
const JEST_BULLET = String.fromCharCode(0x25cf);
const CROSS_MARK = String.fromCharCode(0x2716);
const NODE_TEST_FAIL_RE = new RegExp('^' + CROSS_MARK + ' failing tests:');
// Jest: "FAIL src/a.test.ts"; Vitest: " FAIL  src/a.test.ts > suite > name". Exclude pytest ("::") and Go (tab).
const FAIL_FILE_RE = /^\s*FAIL\s+(\S[^\t]*?)(?:\s+\([\d.]+\s*m?s\))?\s*$/;
const BULLET_RE = new RegExp('^[ ]*' + JEST_BULLET + '[ ]+(.+?)[ ]*$');
const TAP_NOT_OK_RE = /^\s*not ok \d+ - (.+)$/;
const MOCHA_ITEM_RE = /^\s+\d+\) (.+)$/;
const ASSERT_RE = /^\s*(?:expect\(|AssertionError|Error: expect|Expected[:\s]|Received[:\s]|AssertionError \[|\+ expected|- actual|expected .+ to )/;

function detectFramework(ctx: DetectContext): string {
  const text = ctx.body.slice(0, 20000);
  if (text.some((l) => /^\s*Test Files\s/.test(l.text) || /(?:\bvitest\b)/i.test(l.text))) return 'Vitest';
  if (text.some((l) => /^\s*Tests:\s/.test(l.text) || /^\s*Test Suites:\s/.test(l.text) || /(?:\bjest\b)/i.test(l.text))) return 'Jest';
  if (text.some((l) => MOCHA_FAILING_RE.test(l.text) || /^\s*\d+ passing\b/.test(l.text))) return 'Mocha';
  if (text.some((l) => /^TAP version|^# tests \d+/.test(l.text))) return 'node:test';
  return 'Test runner';
}

export const jsTestDetector: Detector = (ctx) => {
  let summary: LogLine | undefined;
  let failedCount = 0;
  for (const l of ctx.body) {
    const m = JEST_SUMMARY_RE.exec(l.text) ?? VITEST_SUMMARY_RE.exec(l.text) ?? MOCHA_FAILING_RE.exec(l.text) ?? TAP_FAIL_RE.exec(l.text);
    if (m) {
      summary = l;
      failedCount = Number(m[1]);
      // keep scanning: later summaries (final totals) win
    }
  }
  const failFiles: LogLine[] = [];
  const bullets: LogLine[] = [];
  const named: LogLine[] = [];
  const seenNames = new Set<string>();
  for (const l of ctx.body) {
    if (l.text.includes('::')) continue;
    const ff = FAIL_FILE_RE.exec(l.text);
    if (ff && !/^(FAIL|PASS)$/.test(ff[1] ?? '')) failFiles.push(l);
    const b = BULLET_RE.exec(l.text);
    if (b && !/^(Console|Test suite failed to run|Multiple|Validation Warning|Deprecation)/.test(b[1] ?? '')) {
      if (!seenNames.has(b[1] ?? '')) {
        seenNames.add(b[1] ?? '');
        bullets.push(l);
      }
    }
    if (TAP_NOT_OK_RE.test(l.text) || (summary && MOCHA_ITEM_RE.test(l.text) && MOCHA_FAILING_RE.test(summary.text))) named.push(l);
  }
  const hasNodeFail = ctx.body.some((l) => NODE_TEST_FAIL_RE.test(l.text));
  if (!summary && !hasNodeFail && !(failFiles.length > 0 && bullets.length > 0)) return [];

  const evidenceLines = new Map<number, LogLine>();
  const add = (l: LogLine | undefined) => {
    if (l) evidenceLines.set(l.n, l);
  };
  const names = bullets.length > 0 ? bullets : named;
  for (const l of names.slice(0, 3)) add(l);
  if (names.length === 0) for (const l of failFiles.slice(0, 3)) add(l);
  // First assertion detail after the first failing test.
  const first = names[0] ?? failFiles[0];
  if (first) {
    const idx = ctx.body.findIndex((l) => l.n === first.n);
    let got = 0;
    for (let i = idx + 1; i < Math.min(ctx.body.length, idx + 25) && got < 3; i++) {
      const l = ctx.body[i]!;
      if (ASSERT_RE.test(l.text)) {
        add(l);
        got++;
      }
    }
  }
  add(summary);
  const evidence = [...evidenceLines.values()].sort((a, b) => a.n - b.n).map(toEvidence);
  const fw = detectFramework(ctx);
  const count = failedCount || names.length || failFiles.length;
  const finding: Finding = {
    id: 'js-test-failure',
    category: 'test',
    kind: 'root',
    title: fw + ': ' + plural(count, 'test') + ' failed',
    confidence: 'high',
    score: 80,
    evidence,
    occurrences: count,
    explanation:
      'The test runner reported failing tests. The assertion details above are the concrete cause; the later "npm ERR!" / exit-code lines are only consequences.',
    suggestions: [
      'Run just the failing test locally to reproduce, e.g. npx ' + (fw === 'Vitest' ? 'vitest run' : 'jest') + ' <file>.',
      'If it passes locally, compare Node version, environment variables, timezone/locale and test ordering with the CI job.',
      'Check whether the failure is timing-dependent (flaky) by re-running only the failed test.',
    ],
  };
  return [finding];
};

export const suiteFailedToRun = patternRule({
  id: 'jest-suite-failed-to-run',
  category: 'test',
  score: 86,
  patterns: [new RegExp('^[ ]*' + JEST_BULLET + '[ ]+Test suite failed to run')],
  title: 'Test suite failed to start (it never ran any test)',
  explanation:
    'The test file could not be loaded: typically an import/module-resolution error, a syntax/transform (Babel/ts-jest) error or a missing dependency. The error printed right below this line is the cause.',
  suggestions: [
    'Read the error immediately below this line: it names the missing module or the syntax problem.',
    'Run "npm ci" and confirm the Jest/Vitest transform config (ts-jest, babel, ESM settings) matches the Node version used in CI.',
  ],
  after: 6,
});

export const testTimeout = patternRule({
  id: 'test-timeout',
  category: 'timeout',
  score: 82,
  patterns: [
    /Exceeded timeout of \d+ ?m?s for a test/,
    /Timeout - Async callback was not invoked within the \d+ ?m?s timeout/,
    /Test timed out in \d+ ?m?s/,
    /Timeout of \d+ ?m?s exceeded/,
    /Test timeout of \d+ ?m?s exceeded/,
  ],
  title: (m) => 'A test exceeded its timeout (' + m[0].slice(0, 80) + ')',
  explanation:
    'A test did not finish within its time limit. This is usually an unresolved promise, a missing await/done callback, an unreachable service, or a slow CI runner.',
  suggestions: [
    'Look for a promise that never resolves or a service the test waits for (database, network, server not started).',
    'If the test is legitimately slow on CI, raise its timeout explicitly rather than globally.',
  ],
  before: 1,
});

export const eslintFailure = patternRule({
  id: 'eslint-errors',
  category: 'lint',
  score: 72,
  patterns: [/(?:^|\s)\d+ problems? \(([1-9]\d*) errors?, \d+ warnings?\)/],
  title: (m) => 'ESLint reported ' + (m[1] ?? '') + ' error(s)',
  explanation: 'ESLint found rule violations at error level, which fails the lint step.',
  suggestions: ['Reproduce locally: npx eslint . (add --fix for auto-fixable rules).', 'Make sure the CI ESLint/plugin versions match your lockfile.'],
  before: 3,
});

export const prettierFailure = patternRule({
  id: 'prettier-check',
  category: 'lint',
  score: 72,
  patterns: [/^\[warn\] Code style issues found in/, /Code style issues found in \d+ files?/],
  title: 'Prettier check failed: files are not formatted',
  explanation: 'prettier --check found files that differ from the formatted output.',
  suggestions: ['Run: npx prettier --write . and commit the result.'],
  before: 3,
});
