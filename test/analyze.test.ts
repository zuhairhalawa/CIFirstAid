import { describe, expect, it } from 'vitest';
import { analyzeLog } from '../src/analyze.js';
import { ESC, ghLog } from './helpers.js';

const BULLET = String.fromCharCode(0x25cf);

interface Case {
  name: string;
  lines: string[];
  annotation?: string;
  id: string;
  category: string;
  /** Substring expected somewhere in the primary evidence. */
  evidence: string;
}

const cases: Case[] = [
  {
    name: 'TypeScript errors',
    lines: [
      "src/a.ts(10,5): error TS2322: Type 'string' is not assignable to type 'number'.",
      "src/b.ts(3,1): error TS2307: Cannot find module './nope' or its corresponding type declarations.",
      'Found 2 errors in 2 files.',
    ],
    annotation: 'Process completed with exit code 2.',
    id: 'typescript-compile-error',
    category: 'typescript',
    evidence: 'src/a.ts(10,5)',
  },
  {
    name: 'TypeScript pretty format',
    lines: ["src/x.ts:4:7 - error TS2304: Cannot find name 'foo'."],
    annotation: 'Process completed with exit code 1.',
    id: 'typescript-compile-error',
    category: 'typescript',
    evidence: 'TS2304',
  },
  {
    name: 'npm ci lockfile out of sync',
    lines: [
      'npm error code EUSAGE',
      'npm error',
      'npm error `npm ci` can only install packages when your package.json and package-lock.json or npm-shrinkwrap.json are in sync. Please update your lock file with `npm install` before continuing.',
      'npm error',
      'npm error Missing: foo@1.0.0 from lock file',
    ],
    annotation: 'Process completed with exit code 1.',
    id: 'npm-lockfile-out-of-sync',
    category: 'npm',
    evidence: 'Missing: foo@1.0.0',
  },
  {
    name: 'npm ERESOLVE',
    lines: [
      'npm ERR! code ERESOLVE',
      'npm ERR! ERESOLVE could not resolve',
      'npm ERR! Found: react@17.0.2',
      'npm ERR! Could not resolve dependency:',
      'npm ERR! peer react@"^18.0.0" from some-lib@2.0.0',
    ],
    annotation: 'Process completed with exit code 1.',
    id: 'npm-eresolve',
    category: 'npm',
    evidence: 'ERESOLVE',
  },
  {
    name: 'Node cannot find module',
    lines: [
      "node:internal/modules/cjs/loader:1228",
      "Error: Cannot find module '/work/dist/index.js'",
      "    at Module._resolveFilename (node:internal/modules/cjs/loader:1225:15)",
      "  code: 'MODULE_NOT_FOUND',",
    ],
    annotation: 'Process completed with exit code 1.',
    id: 'node-module-not-found',
    category: 'node',
    evidence: '/work/dist/index.js',
  },
  {
    name: 'Jest failure followed by npm ELIFECYCLE',
    lines: [
      'FAIL src/sum.test.ts',
      '  ' + BULLET + ' sum > adds numbers',
      '',
      '    expect(received).toBe(expected) // Object.is equality',
      '',
      '    Expected: 3',
      '    Received: 4',
      '',
      'Test Suites: 1 failed, 2 passed, 3 total',
      'Tests:       1 failed, 4 passed, 5 total',
      'npm error code ELIFECYCLE',
      'npm error errno 1',
    ],
    annotation: 'Process completed with exit code 1.',
    id: 'js-test-failure',
    category: 'test',
    evidence: 'Expected: 3',
  },
  {
    name: 'Vitest failure',
    lines: [
      ' FAIL  src/math.test.ts > math > adds',
      'AssertionError: expected 2 to be 3 // Object.is equality',
      ' Test Files  1 failed | 2 passed (3)',
      '      Tests  1 failed | 5 passed (6)',
    ],
    annotation: 'Process completed with exit code 1.',
    id: 'js-test-failure',
    category: 'test',
    evidence: 'AssertionError',
  },
  {
    name: 'Python ModuleNotFoundError traceback',
    lines: [
      'Traceback (most recent call last):',
      '  File "app.py", line 1, in <module>',
      '    import requests',
      "ModuleNotFoundError: No module named 'requests'",
    ],
    annotation: 'Process completed with exit code 1.',
    id: 'python-module-not-found',
    category: 'python',
    evidence: "No module named 'requests'",
  },
  {
    name: 'pytest failures',
    lines: [
      '=========================== short test summary info ============================',
      'FAILED tests/test_api.py::test_login - AssertionError: assert 401 == 200',
      '========================= 1 failed, 4 passed in 0.52s ==========================',
    ],
    annotation: 'Process completed with exit code 1.',
    id: 'pytest-failures',
    category: 'python',
    evidence: 'tests/test_api.py::test_login',
  },
  {
    name: 'command not found',
    lines: ['./deploy.sh: line 3: jq: command not found'],
    annotation: 'Process completed with exit code 127.',
    id: 'command-not-found',
    category: 'missing-executable',
    evidence: 'jq: command not found',
  },
  {
    name: 'missing environment variable',
    lines: ['Error: Missing required environment variable: DATABASE_URL'],
    annotation: 'Process completed with exit code 1.',
    id: 'env-var-missing',
    category: 'missing-env',
    evidence: 'DATABASE_URL',
  },
  {
    name: 'GITHUB_TOKEN permissions',
    lines: ['HttpError: Resource not accessible by integration'],
    annotation: 'Resource not accessible by integration',
    id: 'resource-not-accessible',
    category: 'permission',
    evidence: 'Resource not accessible by integration',
  },
  {
    name: 'git push permission',
    lines: ['remote: Permission to octo/repo.git denied to github-actions[bot].', 'fatal: unable to access https://github.com/octo/repo.git/: The requested URL returned error: 403'],
    annotation: 'Process completed with exit code 128.',
    id: 'git-push-denied',
    category: 'permission',
    evidence: 'Permission to octo/repo.git denied',
  },
  {
    name: 'unresolvable action',
    lines: ["Error: Unable to resolve action `actions/checkout@v99`, unable to find version `v99`"],
    annotation: "Unable to resolve action `actions/checkout@v99`, unable to find version `v99`",
    id: 'unable-to-resolve-action',
    category: 'actions-config',
    evidence: 'actions/checkout@v99',
  },
  {
    name: 'retired artifact action',
    lines: [],
    annotation: 'This request has been automatically failed because it uses a deprecated version of `actions/upload-artifact: v3`. Learn more: https://github.blog/changelog',
    id: 'deprecated-artifact-action',
    category: 'actions-config',
    evidence: 'deprecated version',
  },
  {
    name: 'required action input missing',
    lines: ['Error: Input required and not supplied: token'],
    annotation: 'Input required and not supplied: token',
    id: 'input-required',
    category: 'actions-config',
    evidence: 'token',
  },
  {
    name: 'Docker COPY of a missing file',
    lines: ['ERROR: failed to solve: failed to compute cache key: failed to calculate checksum of ref abc: "/dist": not found'],
    annotation: 'buildx failed with: ERROR: failed to solve',
    id: 'docker-copy-missing',
    category: 'docker',
    evidence: '/dist',
  },
  {
    name: 'registry pull rate limit',
    lines: ['toomanyrequests: You have reached your pull rate limit. You may increase the limit by authenticating.'],
    annotation: 'Process completed with exit code 1.',
    id: 'rate-limit',
    category: 'rate-limit',
    evidence: 'pull rate limit',
  },
  {
    name: 'GitHub API rate limit',
    lines: ['HttpError: API rate limit exceeded for user ID 12345.'],
    annotation: 'API rate limit exceeded for user ID 12345.',
    id: 'rate-limit',
    category: 'rate-limit',
    evidence: 'API rate limit exceeded',
  },
  {
    name: 'network reset during npm install',
    lines: ['npm error code ECONNRESET', 'npm error network request to https://registry.npmjs.org/left-pad failed, reason: read ECONNRESET'],
    annotation: 'Process completed with exit code 1.',
    id: 'connection-error',
    category: 'network',
    evidence: 'ECONNRESET',
  },
  {
    name: 'DNS failure',
    lines: ['curl: (6) Could not resolve host: artifacts.internal.example'],
    annotation: 'Process completed with exit code 6.',
    id: 'dns-failure',
    category: 'network',
    evidence: 'artifacts.internal.example',
  },
  {
    name: 'job timeout',
    lines: ['Running slow tests...'],
    annotation: 'The job running on runner GitHub Actions 5 has exceeded the maximum execution time of 360 minutes.',
    id: 'job-timeout',
    category: 'timeout',
    evidence: '360 minutes',
  },
  {
    name: 'cancelled by a person',
    lines: ['Running...'],
    annotation: 'The run was canceled by @octocat.',
    id: 'concurrency-cancelled',
    category: 'cancelled',
    evidence: 'canceled by @octocat',
  },
  {
    name: 'Node heap out of memory',
    lines: ['<--- Last few GCs --->', 'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory'],
    annotation: 'Process completed with exit code 134.',
    id: 'js-heap-oom',
    category: 'out-of-memory',
    evidence: 'JavaScript heap out of memory',
  },
  {
    name: 'disk full',
    lines: ['ENOSPC: no space left on device, write', 'No space left on device'],
    annotation: 'Process completed with exit code 1.',
    id: 'disk-full',
    category: 'disk',
    evidence: 'No space left on device',
  },
  {
    name: 'OpenSSL 3 / webpack 4',
    lines: ["Error: error:0308010C:digital envelope routines::unsupported", "  opensslErrorStack: [ 'error:03000086' ], code: 'ERR_OSSL_EVP_UNSUPPORTED'"],
    annotation: 'Process completed with exit code 1.',
    id: 'openssl-unsupported',
    category: 'node',
    evidence: 'digital envelope',
  },
];

describe('error detection', () => {
  for (const c of cases) {
    it(c.name, () => {
      const d = analyzeLog(ghLog(c.lines, c.annotation ? { annotation: c.annotation } : {}));
      expect(d.primary, 'a primary finding').not.toBeNull();
      expect(d.primary!.id).toBe(c.id);
      expect(d.primary!.category).toBe(c.category);
      const text = d.primary!.evidence.map((e) => e.text).join('\n');
      expect(text).toContain(c.evidence);
      expect(d.primary!.evidence.length).toBeGreaterThan(0);
      expect(d.primary!.suggestions.length).toBeGreaterThan(0);
    });
  }
});

describe('prioritisation of root cause over generic wrappers', () => {
  it('does not report "exit code 1" when a specific cause exists', () => {
    const d = analyzeLog(ghLog(['Error: Missing required environment variable: API_KEY'], { annotation: 'Process completed with exit code 1.' }));
    expect(d.primary!.id).toBe('env-var-missing');
    expect(d.primary!.id).not.toBe('exit-code');
  });

  it('ranks the test failure above the npm ELIFECYCLE symptom', () => {
    const d = analyzeLog(
      ghLog(['FAIL src/a.test.ts', '  ' + BULLET + ' a > b', 'Tests:       1 failed, 1 total', 'npm ERR! code ELIFECYCLE', 'npm ERR! Test failed.  See above for more details.'], {
        annotation: 'Process completed with exit code 1.',
      }),
    );
    expect(d.primary!.id).toBe('js-test-failure');
    const lifecycle = d.others.find((f) => f.id === 'npm-lifecycle');
    if (lifecycle) expect(lifecycle.score).toBeLessThan(d.primary!.score);
  });

  it('shows the inner tool error for a failed Docker build step', () => {
    const d = analyzeLog(
      ghLog([
        '#8 [4/6] RUN npm ci',
        '#8 1.2 npm error code EUSAGE',
        '#8 1.2 npm error `npm ci` can only install packages when your package.json and package-lock.json or npm-shrinkwrap.json are in sync.',
        '#8 ERROR: process "/bin/sh -c npm ci" did not complete successfully: exit code: 1',
        'ERROR: failed to solve: process "/bin/sh -c npm ci" did not complete successfully: exit code: 1',
      ]),
    );
    expect(d.primary!.id).toBe('npm-lockfile-out-of-sync');
    expect(d.others.some((f) => f.category === 'docker')).toBe(true);
  });

  it('surfaces the last output of a failing BuildKit step when no known signature matches', () => {
    const d = analyzeLog(
      ghLog([
        '#9 [5/6] RUN make all',
        '#9 0.311 cc -o app main.c',
        '#9 0.402 main.c:4:10: fatal error: missing.h: No such file or directory',
        '#9 0.410 make: *** [Makefile:3: all] Error 1',
        '#9 ERROR: process "/bin/sh -c make all" did not complete successfully: exit code: 2',
      ]),
    );
    expect(d.primary).not.toBeNull();
    const text = [d.primary!, ...d.others].flatMap((f) => f.evidence.map((e) => e.text)).join('\n');
    expect(text).toContain('missing.h');
  });

  it('explains special exit codes when nothing else is known', () => {
    const d = analyzeLog(ghLog(['building...'], { annotation: 'Process completed with exit code 137.' }));
    expect(d.primary!.title).toContain('137');
    expect(d.primary!.title.toLowerCase()).toContain('killed');
  });

  it('falls back to error-like lines for unknown failures, with low confidence', () => {
    const d = analyzeLog(ghLog(['starting', 'FooError: the frobnicator exploded', 'cleanup done'], { annotation: 'Process completed with exit code 1.' }));
    expect(d.primary!.id).toBe('unclassified-errors');
    expect(d.primary!.confidence).toBe('low');
    expect(d.primary!.evidence.map((e) => e.text).join('\n')).toContain('frobnicator');
  });
});

describe('false positive guards', () => {
  it('ignores text inside the echoed script and run metadata', () => {
    const log = ghLog(['all good', 'done'], { command: 'echo "Permission denied: command not found"' });
    const d = analyzeLog(log);
    expect(d.primary).toBeNull();
  });

  it('ignores warnings', () => {
    const log = ghLog(['ok']).replace('Cleaning up', '##[warning]Unable to resolve action x, unable to find version\nCleaning up');
    expect(analyzeLog(log).primary).toBeNull();
  });

  it('returns no finding for a clean log', () => {
    const d = analyzeLog('Installing...\nAll 12 tests passed\nDone in 3.2s\n');
    expect(d.primary).toBeNull();
    expect(d.summary).toMatch(/no failure/i);
  });

  it('does not treat "0 errors" as an error', () => {
    const d = analyzeLog('tsc finished: 0 errors\nlint: 0 errors, 2 warnings\n');
    expect(d.primary).toBeNull();
  });

  it('only flags upload-artifact "no files" when the runner marks it as an error', () => {
    const warn = ghLog(['##[warning]No files were found with the provided path: dist/. No artifacts will be uploaded.']);
    expect(analyzeLog(warn).primary).toBeNull();
    const err = ghLog([], { annotation: 'No files were found with the provided path: dist/. No artifacts will be uploaded.' });
    expect(analyzeLog(err).primary!.id).toBe('upload-no-files');
  });
});

describe('input formats', () => {
  const lines = ["src/a.ts(10,5): error TS2322: Type 'string' is not assignable to type 'number'."];

  it('handles Windows line endings and a BOM', () => {
    const d = analyzeLog(ghLog(lines, { crlf: true, bom: true, annotation: 'Process completed with exit code 2.' }));
    expect(d.primary!.id).toBe('typescript-compile-error');
    expect(d.stats.crlf).toBe(true);
  });

  it('handles ANSI colour codes around the error text', () => {
    const colored = ghLog(['  ' + ESC + '[31merror' + ESC + '[0m: Missing required environment variable: TOKEN']);
    expect(analyzeLog(colored).primary!.id).toBe('env-var-missing');
  });

  it('handles plain local logs with no GitHub formatting', () => {
    const d = analyzeLog(lines.join('\n') + '\nnpm ERR! code ELIFECYCLE\n');
    expect(d.primary!.id).toBe('typescript-compile-error');
    expect(d.stats.githubFormat).toBe(false);
    expect(d.stats.timestamped).toBe(false);
  });

  it('survives an empty input', () => {
    const d = analyzeLog('');
    expect(d.primary).toBeNull();
  });

  it('survives a huge single line without hanging', () => {
    const start = Date.now();
    const d = analyzeLog('x'.repeat(2_000_000) + '\nError: Cannot find module \'foo\'\n');
    expect(d.primary).not.toBeNull();
    expect(Date.now() - start).toBeLessThan(5000);
  });

  it('is fast on large logs', () => {
    const noise = Array.from({ length: 200_000 }, (_, i) => 'line ' + i + ' building module ok');
    const start = Date.now();
    const d = analyzeLog(ghLog([...noise, 'Error: Missing required environment variable: BUILD_TOKEN'], { annotation: 'Process completed with exit code 1.' }));
    expect(d.primary!.id).toBe('env-var-missing');
    expect(Date.now() - start).toBeLessThan(8000);
  });
});

describe('evidence quality', () => {
  it('reports original line numbers', () => {
    const log = ghLog(['a', 'b', 'Error: Missing required environment variable: ZETA_KEY']);
    const d = analyzeLog(log);
    const ev = d.primary!.evidence.find((e) => e.text.includes('ZETA_KEY'))!;
    expect(log.split('\n')[ev.line - 1]).toContain('Missing required environment variable: ZETA_KEY');
  });

  it('redacts secrets that appear in evidence', () => {
    const token = 'ghp_' + 'a'.repeat(36);
    const d = analyzeLog(ghLog(['Error: Missing required environment variable: TOKEN', 'token=' + token + ' failed Error: Bad credentials']));
    const all = JSON.stringify(d);
    expect(all).not.toContain(token);
  });
});
