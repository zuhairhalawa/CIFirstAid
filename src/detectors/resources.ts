import { patternRule } from './rule.js';

export const resourceRules = [
  patternRule({
    id: 'job-timeout',
    category: 'timeout',
    score: 95,
    patterns: [
      /The job running on runner .* has exceeded the maximum execution time of (\d+) minutes/,
      /The action '?(.+?)'? has timed out after (\d+) minutes/,
      /The job was canceled because it exceeded the maximum execution time/,
      /exceeded the maximum execution time/,
    ],
    title: (m) => 'Job or step exceeded its time limit' + (m[0].match(/(\d+) minutes/) ? ' (' + (m[0].match(/(\d+) minutes/)?.[1] ?? '') + ' min)' : ''),
    explanation:
      'The job (or step) hit its timeout and was cancelled. This usually means something hangs (a prompt waiting for input, a server that never exits, a deadlock) or the work is simply slower than the limit.',
    suggestions: [
      'Find the last log line before the cancel: whatever ran then is the hanging step.',
      'Make sure commands never wait for interactive input (use -y / --no-input / CI=true) and background servers are stopped.',
      'If the work is legitimately long, raise timeout-minutes on the job/step (default job limit: 360 minutes).',
    ],
  }),
  patternRule({
    id: 'js-heap-oom',
    category: 'out-of-memory',
    score: 94,
    patterns: [
      /JavaScript heap out of memory/,
      /FATAL ERROR: .*(?:Allocation failed|Reached heap limit)/,
      /Worker terminated due to reaching memory limit/,
      /ERR_WORKER_OUT_OF_MEMORY/,
    ],
    title: 'Node.js ran out of memory (JavaScript heap out of memory)',
    explanation: 'The Node.js process exceeded its heap limit. Large builds, bundlers, TypeScript on big projects, or a test leak commonly cause this.',
    suggestions: [
      'Raise the limit: NODE_OPTIONS=--max-old-space-size=4096 for the failing step.',
      'Reduce parallelism (e.g. jest --maxWorkers=2, fewer concurrent builds) or split the work.',
      'Investigate memory leaks if usage grows across tests.',
    ],
  }),
  patternRule({
    id: 'generic-oom',
    category: 'out-of-memory',
    score: 90,
    patterns: [
      /java[.]lang[.]OutOfMemoryError/,
      /^MemoryError\b/,
      /OOMKilled/,
      /std::bad_alloc/,
      /fatal error: runtime: out of memory/,
      /Cannot allocate memory/,
      /(?:\bENOMEM\b)/,
      /Out of memory: Killed process/,
      /Killed process \d+ \(.*\) total-vm/,
    ],
    title: 'The process ran out of memory',
    explanation: 'The program (or the kernel OOM killer) ended a process because memory ran out. Standard GitHub-hosted runners have limited RAM.',
    suggestions: [
      'Reduce memory use or parallelism for the failing step (fewer workers/threads).',
      'Use a larger runner, or raise the language heap limit (Java: -Xmx, Node: --max-old-space-size).',
    ],
  }),
  patternRule({
    id: 'killed',
    category: 'out-of-memory',
    score: 68,
    patterns: [/^(?:[^\s:]+: )?(?:line \d+: )?(?:\d+ )?Killed(?: +.*)?$/, /signal: killed$/],
    title: 'A process was killed (SIGKILL), most likely by the out-of-memory killer',
    explanation: 'The shell reported "Killed": the process received SIGKILL. On CI runners this is most often the kernel OOM killer; it can also be a manual kill or a timeout.',
    suggestions: ['Check memory use of the step (reduce parallelism, raise limits, bigger runner).', 'If memory is fine, check for a timeout or an explicit kill in the scripts.'],
    before: 1,
  }),
  patternRule({
    id: 'step-timeout-generic',
    category: 'timeout',
    score: 45,
    patterns: [/(?:operation|request|command|connection|process|step|job) (?:has )?timed out/i, /Timeout (?:waiting|while waiting|exceeded)/i],
    title: (m) => 'Something timed out: ' + m[0].slice(0, 80),
    explanation: 'A wait or request exceeded its time limit. The line shows which operation.',
    suggestions: ['Check the service the step was waiting for, and whether its startup completes within the limit.'],
    before: 1,
  }),
];
