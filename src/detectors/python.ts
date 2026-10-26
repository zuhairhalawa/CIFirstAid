import type { Finding, LogLine } from '../types.js';
import { redact } from '../redact.js';
import { toEvidence, patternRule, type Detector } from './rule.js';
import { plural } from './util.js';

const PYTEST_FAILED_RE = /^FAILED (\S+::\S+)(?: - (.*))?$/;
const PYTEST_ERROR_RE = /^ERROR (\S+?)(?: - (.*))?$/;
const PYTEST_SUMMARY_RE = /^=+ (.*\b\d+ (?:failed|errors?)\b.*) =+$/;
const PYTEST_COLLECT_RE = /^(?:_+ ERROR collecting .* _+|ImportError while importing test module)/;
const E_LINE_RE = /^E\s{2,}(.+)$/;

export const pytestDetector: Detector = (ctx) => {
  const failed: LogLine[] = [];
  const errors: LogLine[] = [];
  let summary: LogLine | undefined;
  let collect: LogLine | undefined;
  const eLines: LogLine[] = [];
  for (const l of ctx.body) {
    if (PYTEST_FAILED_RE.test(l.text)) failed.push(l);
    else if (PYTEST_ERROR_RE.test(l.text) && /::|\.py\b/.test(l.text)) errors.push(l);
    const s = PYTEST_SUMMARY_RE.exec(l.text);
    if (s) summary = l;
    if (!collect && PYTEST_COLLECT_RE.test(l.text)) collect = l;
    if (E_LINE_RE.test(l.text) && eLines.length < 40) eLines.push(l);
  }
  if (failed.length === 0 && errors.length === 0 && !collect && !summary) return [];
  // A bare "=== 1 failed ===" can belong to other tools; require pytest-specific signals.
  if (failed.length === 0 && errors.length === 0 && !collect && eLines.length === 0) return [];

  const chosen = new Map<number, LogLine>();
  const add = (l: LogLine | undefined) => {
    if (l) chosen.set(l.n, l);
  };
  const isCollection = Boolean(collect) || (failed.length === 0 && errors.length > 0);
  if (collect) add(collect);
  for (const l of failed.slice(0, 3)) add(l);
  if (failed.length === 0) for (const l of errors.slice(0, 3)) add(l);
  for (const l of eLines.slice(0, 3)) add(l);
  add(summary);
  const evidence = [...chosen.values()].sort((a, b) => a.n - b.n).map(toEvidence);
  const eText = eLines.map((l) => l.text).join('\n');
  const missingModule = /ModuleNotFoundError: No module named ['"]?([\w.]+)/.exec(eText);
  const count = failed.length || errors.length;

  const f: Finding = {
    id: isCollection ? 'pytest-collection-error' : 'pytest-failures',
    category: 'python',
    kind: 'root',
    title: isCollection
      ? 'pytest could not collect tests' + (missingModule ? ': missing module ' + missingModule[1] : '')
      : 'pytest: ' + plural(count, 'test') + ' failed',
    confidence: 'high',
    score: isCollection ? 86 : 80,
    evidence,
    occurrences: count,
    explanation: isCollection
      ? 'pytest failed while importing test modules, so no tests ran. The "E" lines show the import problem.'
      : 'pytest reported failing tests. The "E" lines show the assertion or exception behind the first failure.',
    suggestions: missingModule
      ? [
          'Install the missing package in the CI job (e.g. add it to requirements*.txt and run pip install -r).',
          'Check that the package is installed into the same Python environment that runs pytest.',
        ]
      : [
          'Run the first failing test alone: pytest -x <path>::<test> -vv',
          'If it only fails on CI, compare Python version, installed package versions (pip freeze) and environment variables.',
        ],
  };
  return [f];
};

const TB_START_RE = /^Traceback \(most recent call last\):/;
const FRAME_RE = /^\s+File "(.+)", line (\d+)(?:, in (.+))?$/;
const EXC_RE = /^([A-Za-z_][\w.]*)(?::\s?(.*))?$/;

export const pythonTracebackDetector: Detector = (ctx) => {
  type Block = { frames: LogLine[]; code: LogLine | undefined; exc: LogLine; name: string; msg: string };
  const blocks: Block[] = [];
  const body = ctx.body;
  for (let i = 0; i < body.length; i++) {
    if (!TB_START_RE.test(body[i]!.text)) continue;
    const frames: LogLine[] = [];
    let code: LogLine | undefined;
    let j = i + 1;
    for (; j < body.length; j++) {
      const t = body[j]!.text;
      if (FRAME_RE.test(t)) {
        frames.push(body[j]!);
        code = undefined;
      } else if (/^\s+\S/.test(t)) {
        if (frames.length > 0 && !code && !/^\s+[\^~]+\s*$/.test(t)) code = body[j]!;
      } else break;
    }
    const excLine = body[j];
    if (excLine) {
      const m = EXC_RE.exec(excLine.text);
      if (m && m[1] && /(Error|Exception|Exit|Interrupt|Failure|Timeout|Warning)$|^(KeyError|SystemExit)/.test(m[1])) {
        blocks.push({ frames, code, exc: excLine, name: m[1], msg: m[2] ?? '' });
      }
    }
    i = j;
  }
  if (blocks.length === 0) return [];
  const b = blocks[blocks.length - 1]!;
  const lastFrame = b.frames[b.frames.length - 1];
  const evidence = [lastFrame, b.code, b.exc].filter((x): x is LogLine => Boolean(x)).map(toEvidence);

  const mod = /^No module named ['"]?([\w.]+)/.exec(b.msg);
  const missing = b.name === 'ModuleNotFoundError' || (b.name === 'ImportError' && mod);
  const title = missing && mod
    ? 'Python module not found: ' + mod[1]
    : redact('Python exception: ' + b.name + (b.msg ? ': ' + b.msg : '')).slice(0, 160);
  const f: Finding = {
    id: missing ? 'python-module-not-found' : 'python-traceback',
    category: 'python',
    kind: 'root',
    title,
    confidence: 'high',
    score: missing ? 78 : 70,
    evidence,
    occurrences: blocks.length,
    explanation: missing
      ? 'Python could not import a module. It is either not installed in this environment or not on the import path.'
      : 'An uncaught Python exception ended the program. The last line of the traceback is the exception; the deepest frame shows where it was raised.',
    suggestions: missing
      ? [
          'Add the package to your requirements file and make sure a "pip install" step runs before this step.',
          'If it is your own package, install it (pip install -e .) or set PYTHONPATH.',
        ]
      : ['Start from the deepest frame (the last "File" line above) and the exception message.', 'Reproduce locally with the same Python version as CI.'],
  };
  return [f];
};

export const pipRules = [
  patternRule({
    id: 'pip-no-matching-distribution',
    category: 'python',
    score: 82,
    patterns: [/^ERROR: (?:Could not find a version that satisfies the requirement|No matching distribution found for) (.+)$/],
    title: (m) => 'pip cannot find a matching package version: ' + (m[1] ?? '').split(' ')[0],
    explanation:
      'pip could not find a release matching the requirement: the version does not exist, is not published for this Python/platform, or the package index is unreachable.',
    suggestions: [
      'Check the package name and version pin against PyPI.',
      'Check the Python version used in CI supports that release (python_requires).',
    ],
    maxEvidence: 2,
  }),
  patternRule({
    id: 'pip-resolution-conflict',
    category: 'python',
    score: 84,
    patterns: [/ResolutionImpossible/, /^ERROR: Cannot install .* because these package versions have conflicting dependencies/],
    title: 'pip dependency conflict (cannot resolve versions)',
    explanation: 'Two or more requirements demand incompatible versions of the same package.',
    suggestions: ['Read the "conflict is caused by" lines and loosen or align the conflicting pins.'],
    after: 6,
  }),
  patternRule({
    id: 'pip-build-failure',
    category: 'python',
    score: 70,
    patterns: [/error: subprocess-exited-with-error/, /ERROR: Failed building wheel for (\S+)/, /ERROR: Failed to build installable wheels/],
    title: (m) => 'Python package build failed' + (m[1] ? ': ' + m[1] : ''),
    explanation: 'A package had to be built from source and the build failed, often because system libraries or compilers are missing.',
    suggestions: [
      'Read the compiler/linker error above this line: it usually names a missing header or library.',
      'Install the system packages first (apt-get install ...) or pin a version that ships a prebuilt wheel.',
    ],
    before: 2,
  }),
  patternRule({
    id: 'pip-requirements-missing',
    category: 'python',
    score: 85,
    patterns: [/^ERROR: Could not open requirements file: (.+)$/],
    title: (m) => 'requirements file not found: ' + (m[1] ?? ''),
    explanation: 'pip was pointed at a requirements file that does not exist in the working directory.',
    suggestions: ['Check the file path and the step working-directory; make sure actions/checkout ran first.'],
  }),
  patternRule({
    id: 'python-no-module-named',
    category: 'python',
    score: 76,
    patterns: [/(?:^|: )No module named ['"]?([\w.]+)/],
    exclude: [/^\s*(?:File |E\s)/],
    title: (m) => 'Python module not found: ' + (m[1] ?? ''),
    explanation: 'Python could not import a module. It is not installed in this environment.',
    suggestions: ['Install the package before this step (pip install ...), in the same environment that runs the command.'],
  }),
];
