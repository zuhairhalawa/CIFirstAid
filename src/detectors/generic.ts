import { patternRule } from './rule.js';

const CODE_MEANING: Record<string, string> = {
  '124': 'a command wrapped in timeout(1) hit its limit',
  '126': 'a command was found but is not executable (permissions)',
  '127': 'a command was not found (not installed or not on PATH)',
  '134': 'the process aborted (SIGABRT), often an assertion or native crash',
  '137': 'the process was killed (SIGKILL), most often by the out-of-memory killer or a cancel',
  '139': 'the process crashed with a segmentation fault (SIGSEGV)',
  '143': 'the process was terminated (SIGTERM), typically by a cancel or timeout',
};

export const genericRules = [
  patternRule({
    id: 'exit-code-special',
    category: 'unknown',
    kind: 'wrapper',
    score: 42,
    patterns: [/Process completed with exit code (124|126|127|134|137|139|143)\b/, /failed with exit code (124|126|127|134|137|139|143)\b/],
    title: (m) => 'A step exited with code ' + (m[1] ?? '') + ': ' + (CODE_MEANING[m[1] ?? ''] ?? 'abnormal exit'),
    explanation: 'The runner only reports the exit status. This code has a well-known meaning, but the exact cause is not printed in the log.',
    suggestions: [
      'Look at the output directly above this line for the last thing the step did.',
      'Code 137/143 often means out-of-memory, a timeout or a cancellation: check job duration and memory use.',
    ],
    before: 3,
    pick: 'last',
  }),
  patternRule({
    id: 'exit-code',
    category: 'unknown',
    kind: 'wrapper',
    score: 8,
    patterns: [/Process completed with exit code (\d+)/],
    title: (m) => 'A step failed with exit code ' + (m[1] ?? ''),
    explanation: 'This line only says that a command returned non-zero: it names no cause. The cause is in the output above it.',
    suggestions: ['Read the output directly above this line; the failing command printed its own error there.'],
    before: 3,
    pick: 'last',
  }),
];
