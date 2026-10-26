import type { Finding, LogLine } from '../types.js';
import { toEvidence, patternRule, type Detector } from './rule.js';

// BuildKit: "#12 ERROR: process "/bin/sh -c npm ci" did not complete successfully: exit code: 1"
const BK_ERROR_RE = /^#(\d+) ERROR: (.*)$/;
const FAILED_SOLVE_RE = /ERROR: failed to solve: (.*)$/;
const PROCESS_FAIL_RE = /process "(.+)" did not complete successfully: exit code: (\d+)/;

/**
 * The BuildKit "failed to solve" line only repeats the RUN command and its exit code.
 * The reason is in the output of that step: collect the last lines carrying the same "#N" id.
 */
export const dockerBuildDetector: Detector = (ctx) => {
  let errLine: LogLine | undefined;
  let stepId: string | undefined;
  let msg = '';
  for (const l of ctx.body) {
    const m = BK_ERROR_RE.exec(l.text);
    if (m) {
      errLine = l;
      stepId = m[1];
      msg = m[2] ?? '';
      break;
    }
  }
  if (!errLine) {
    const solve = ctx.body.find((l) => FAILED_SOLVE_RE.test(l.text) || /^(?:ERROR|Error): buildx failed with: /.test(l.text));
    if (!solve) return [];
    const m = FAILED_SOLVE_RE.exec(solve.text);
    const f: Finding = {
      id: 'docker-build-failed',
      category: 'docker',
      kind: 'wrapper',
      title: 'Docker build failed' + (m ? ': ' + (m[1] ?? '').slice(0, 120) : ''),
      confidence: 'medium',
      score: 45,
      evidence: [toEvidence(solve)],
      occurrences: 1,
      explanation: 'The Docker build did not complete. The message above names the failing instruction.',
      suggestions: ['Reproduce locally with the same Dockerfile and build context: docker build .'],
    };
    return [f];
  }

  const errN = errLine.n;
  const stepLines = ctx.body.filter((l) => l.buildkit === stepId && l.n < errN && l.text.trim() !== '');
  const tail = stepLines.slice(-6);
  const pf = PROCESS_FAIL_RE.exec(msg);
  const cmd = pf ? pf[1] : undefined;
  const evidence = [...tail.map(toEvidence), toEvidence(errLine)];
  const hasOutput = tail.length > 0;
  const f: Finding = {
    id: 'docker-build-step-failed',
    category: 'docker',
    kind: hasOutput ? 'root' : 'wrapper',
    title: 'Docker build failed' + (cmd ? ' while running: ' + cmd.slice(0, 100) : ': ' + msg.slice(0, 100)),
    confidence: hasOutput ? 'medium' : 'low',
    score: hasOutput ? 60 : 45,
    evidence,
    occurrences: 1,
    explanation:
      'A RUN instruction in the Dockerfile exited non-zero. The lines above it are the last output of that step: the tool error there is the real cause.',
    suggestions: [
      'Reproduce locally: docker build --progress=plain . and read the output of that step.',
      'Remember the build context: files missing from the image are often excluded by .dockerignore.',
    ],
  };
  return [f];
};

export const dockerRules = [
  patternRule({
    id: 'docker-copy-missing',
    category: 'docker',
    score: 88,
    patterns: [
      /failed to compute cache key: .*"([^"]+)": not found/,
      /COPY failed: file not found in build context/,
      /COPY failed: stat .*: no such file or directory/,
      /failed to calculate checksum of ref .*: "([^"]+)": not found/,
    ],
    title: (m) => 'Docker COPY/ADD source not found' + (m[1] ? ': ' + m[1] : ''),
    explanation: 'The file or directory named in a COPY/ADD instruction is not in the build context: wrong path, not checked out/built yet, or excluded by .dockerignore.',
    suggestions: ['Check the path is relative to the build context (not the Dockerfile folder) and not listed in .dockerignore.', 'Make sure earlier build steps that create it ran before docker build.'],
  }),
  patternRule({
    id: 'dockerfile-missing',
    category: 'docker',
    score: 90,
    patterns: [
      /failed to read dockerfile: .*no such file or directory/,
      /unable to prepare context: (?:path|unable to evaluate symlinks).*(?:not found|no such file)/,
      /^unable to prepare context/,
      /Dockerfile parse error|dockerfile parse error/,
      /unknown instruction: /i,
    ],
    title: 'Dockerfile or build context problem',
    explanation: 'Docker could not find or parse the Dockerfile / context path given to the build.',
    suggestions: ['Check the context: and file: inputs of the build step and that the repository is checked out.', 'Fix the Dockerfile syntax at the reported line.'],
  }),
  patternRule({
    id: 'docker-image-pull',
    category: 'docker',
    score: 86,
    patterns: [
      /pull access denied for (\S+?),? repository does not exist or may require/,
      /manifest for (\S+) not found/,
      /manifest unknown/,
      /failed to resolve source metadata for (\S+)/,
      /Error response from daemon: (?:pull access denied|manifest .* not found)/,
      /no matching manifest for linux[/](\w+)/,
    ],
    title: (m) => 'Docker cannot pull an image' + (m[1] ? ': ' + m[1] : ''),
    explanation: 'The image/tag does not exist, is private (needs docker login), or has no variant for this CPU architecture.',
    suggestions: ['Check the image name and tag exist; log in for private registries.', 'For architecture errors build/pull for the runner platform (--platform).'],
  }),
  patternRule({
    id: 'docker-daemon',
    category: 'docker',
    score: 88,
    patterns: [/Cannot connect to the Docker daemon at/, /Is the docker daemon running/, /error during connect: .*docker/],
    title: 'Docker daemon is not reachable',
    explanation: 'The docker client could not talk to a daemon: it is not running or the job cannot access the socket (e.g. inside a container job).',
    suggestions: ['Use a runner image with Docker, or mount the docker socket / use docker-in-docker as required.'],
  }),
  patternRule({
    id: 'exec-format-error',
    category: 'docker',
    score: 86,
    patterns: [/exec format error/],
    title: 'Architecture mismatch: "exec format error"',
    explanation: 'A binary or image built for another CPU architecture (e.g. arm64 vs amd64) was run on this runner.',
    suggestions: ['Build and run for the same platform, or set up QEMU/buildx for multi-arch builds.'],
  }),
  patternRule({
    id: 'docker-run-error',
    category: 'docker',
    kind: 'wrapper',
    score: 40,
    patterns: [/^docker: Error response from daemon: (.+)/],
    title: (m) => 'docker run failed: ' + (m[1] ?? '').slice(0, 120),
    explanation: 'The Docker daemon rejected the request; the message is the reason.',
    suggestions: ['Fix the condition named in the message (image, port, mount, name conflict).'],
  }),
];
