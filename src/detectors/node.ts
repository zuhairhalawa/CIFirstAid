import type { Finding, LogLine } from '../types.js';
import { redact } from '../redact.js';
import { toEvidence, patternRule, type Detector } from './rule.js';

export const nodeRules = [
  patternRule({
    id: 'node-module-not-found',
    category: 'node',
    score: 80,
    patterns: [
      /Error \[ERR_MODULE_NOT_FOUND\]: Cannot find (?:package|module) '([^']+)'/,
      /Error: Cannot find module '([^']+)'/,
      /Cannot find module '([^']+)'\s*$/,
    ],
    exclude: [/error TS\d+/],
    title: (m) => 'Node cannot find module: ' + (m[1] ?? ''),
    explanation:
      'Node could not resolve an import/require. Either the package is not installed (missing or skipped "npm ci"), a build step that creates the file did not run, or an ESM import is missing its file extension.',
    suggestions: [
      'If it is a package: make sure "npm ci" ran in the right directory before this step.',
      'If it is a relative path (./dist/...): run the build step first, and check the path/case (Linux is case-sensitive).',
      'For ESM, relative imports need explicit extensions (./file.js).',
    ],
    before: 1,
    after: 2,
  }),
  patternRule({
    id: 'openssl-unsupported',
    category: 'node',
    score: 90,
    patterns: [/ERR_OSSL_EVP_UNSUPPORTED/, /error:0308010C:digital envelope routines::unsupported/],
    title: 'Node 17+ OpenSSL 3 incompatibility (ERR_OSSL_EVP_UNSUPPORTED)',
    explanation: 'An old build tool (typically webpack 4 / older react-scripts) uses a hash algorithm that OpenSSL 3, bundled with Node 17+, no longer allows.',
    suggestions: [
      'Upgrade the build tool (webpack >= 5 / newer react-scripts).',
      'Or run on Node 16, or set NODE_OPTIONS=--openssl-legacy-provider as a stop-gap.',
    ],
  }),
  patternRule({
    id: 'esm-cjs-mismatch',
    category: 'node',
    score: 80,
    patterns: [
      /SyntaxError: Cannot use import statement outside a module/,
      /Error \[ERR_REQUIRE_ESM\]/,
      /require\(\) of ES Module .* not supported/,
      /ERR_UNKNOWN_FILE_EXTENSION/,
      /SyntaxError: Unexpected token 'export'/,
    ],
    title: 'ES module / CommonJS mismatch',
    explanation: 'Code written as ES modules is being loaded as CommonJS (or the reverse). This depends on "type" in package.json, file extensions and tool configuration.',
    suggestions: [
      'Check "type": "module" in package.json versus .cjs/.mjs extensions.',
      'For Jest, configure the ESM/transform setup or transpile the dependency (transformIgnorePatterns).',
    ],
    before: 1,
  }),
  patternRule({
    id: 'node-enoent',
    category: 'node',
    score: 70,
    patterns: [/ENOENT: no such file or directory, (\w+) '([^']+)'/],
    exclude: [/package\.json/],
    title: (m) => 'File or directory not found: ' + (m[2] ?? ''),
    explanation: 'The program tried to access a path that does not exist on the runner: a generated file that was not built, a wrong working directory, or a path case/OS difference.',
    suggestions: ['Check the path exists at that point in the job (add an "ls" step) and that earlier build/checkout steps ran.', 'On Linux paths are case-sensitive.'],
  }),
  patternRule({
    id: 'node-eaddrinuse',
    category: 'node',
    score: 78,
    patterns: [/EADDRINUSE: address already in use (\S+)/, /EADDRINUSE/],
    title: (m) => 'Port already in use (EADDRINUSE)' + (m[1] ? ': ' + m[1] : ''),
    explanation: 'The program tried to listen on a port another process already holds (a leftover server, parallel tests, or a service container on that port).',
    suggestions: ['Use a different/ephemeral port (0) in tests, or stop the earlier process.', 'Check service containers mapping the same port.'],
  }),
  patternRule({
    id: 'node-reference-error',
    category: 'node',
    score: 62,
    patterns: [/^(?:Uncaught )?(?:ReferenceError|TypeError|RangeError): .+/],
    exclude: [/^\s*at /, /expect\(/],
    title: (m) => 'JavaScript runtime error: ' + m[0].slice(0, 120),
    explanation: 'The program threw an uncaught JavaScript error. The stack trace below shows where.',
    suggestions: ['Follow the first stack frame that points into your own code (not node_modules or node:internal).'],
    after: 3,
  }),
  patternRule({
    id: 'node-unhandled-rejection',
    category: 'node',
    score: 66,
    patterns: [/(?:\[UnhandledPromiseRejection: )/, /UnhandledPromiseRejection/, /^Uncaught Exception/],
    title: 'Unhandled promise rejection crashed the process',
    explanation: 'A promise rejected and nothing handled it; since Node 15 this terminates the process.',
    suggestions: ['Add a catch/try-await around the failing async call; the reason is shown in the message.'],
    after: 3,
  }),
];

const ERR_LINE_RE = /^(?:Uncaught )?([A-Za-z]*Error)(?: \[[A-Z_]+\])?: (.+)$/;
const STACK_RE = /^\s+at /;

/** Generic "Error: message" followed by a Node stack trace. Lower priority than named signatures. */
export const nodeStackDetector: Detector = (ctx) => {
  const body = ctx.body;
  let found: { err: LogLine; frame: LogLine; name: string; msg: string } | undefined;
  for (let i = 0; i < body.length - 1; i++) {
    const m = ERR_LINE_RE.exec(body[i]!.text);
    if (!m) continue;
    // Allow one continuation line between the message and the first "at" frame.
    const next = body[i + 1]!;
    const second = body[i + 2];
    const frame = STACK_RE.test(next.text) ? next : second && STACK_RE.test(second.text) ? second : undefined;
    if (!frame) continue;
    found = { err: body[i]!, frame, name: m[1] ?? 'Error', msg: m[2] ?? '' };
    break;
  }
  if (!found) return [];
  const f: Finding = {
    id: 'node-uncaught-error',
    category: 'node',
    kind: 'root',
    title: redact('Uncaught ' + found.name + ': ' + found.msg).slice(0, 160),
    confidence: 'medium',
    score: 58,
    evidence: [toEvidence(found.err), toEvidence(found.frame)],
    occurrences: 1,
    explanation: 'An error with a stack trace ended the Node.js process. The first stack frame shows where it was thrown.',
    suggestions: ['Follow the first frame that points into your own code, not node_modules or node:internal.'],
  };
  return [f];
};
