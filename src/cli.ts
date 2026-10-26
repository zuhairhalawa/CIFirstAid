#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { realpathSync, readFileSync } from 'node:fs';
import { analyzeLog } from './analyze.js';
import { localJson, renderLocalText, renderRunText, runJson } from './render.js';
import {
  GitHubClient,
  GitHubError,
  apiBaseFor,
  parseRemoteUrl,
  parseRepoArg,
  repoFromGitRemote,
  resolveToken,
  type RepoRef,
} from './github.js';
import { diagnoseRun } from './run.js';

export function getVersion(): string {
  try {
    const p = new URL('../package.json', import.meta.url);
    return (JSON.parse(readFileSync(p, 'utf8')) as { version: string }).version;
  } catch {
    return '0.0.0';
  }
}

export interface IO {
  out: (s: string) => void;
  err: (s: string) => void;
  readStdin: () => Promise<Buffer>;
  color: boolean;
  env: NodeJS.ProcessEnv;
  /** Test seam: build a client instead of resolving real credentials. */
  makeClient?: (repo: RepoRef) => Promise<GitHubClient> | GitHubClient;
  /** Test seam: replace git remote detection. */
  detectRepo?: () => Promise<RepoRef | null>;
}

const HELP = [
  'ci-first-aid - evidence-first GitHub Actions failure diagnosis',
  '',
  'Usage:',
  '  ci-first-aid analyze <file|->  [--json] [--no-color]',
  '  ci-first-aid run <run-id|run-url> [--repo OWNER/REPO] [options]',
  '',
  'analyze reads a log file (or stdin with "-") and works fully offline.',
  'run fetches the failed jobs of a GitHub Actions run using read-only API calls.',
  '',
  'Options for run:',
  '  -R, --repo <[HOST/]OWNER/REPO>  Repository (default: GH_REPO or the git "origin" remote)',
  '      --attempt <n>               Re-run attempt number (default: latest)',
  '      --job <id>                  Only diagnose this job ID',
  '      --max-jobs <n>              Maximum failed jobs to analyze (default 10)',
  '      --include-cancelled         Also diagnose cancelled jobs when other jobs failed',
  '      --hostname <host>           GitHub Enterprise host (default: github.com or GH_HOST)',
  '',
  'Common options:',
  '      --json                      Machine-readable output',
  '      --no-color                  Disable colors',
  '  -h, --help                      Show help',
  '  -v, --version                   Show version',
  '',
  'Authentication for run: GH_TOKEN / GITHUB_TOKEN, or an existing "gh auth login".',
  'CIFirstAid only reads. It never reruns, cancels, deletes or modifies a run.',
  '',
  'Exit codes: 0 diagnosis produced, 1 runtime error (file, network, auth), 2 usage error.',
  '',
].join('\n');

/** Decode bytes to text, handling UTF-8 (with/without BOM) and UTF-16 (PowerShell redirects). */
export function decodeLog(buf: Buffer): string {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = Buffer.from(buf.subarray(2));
    swapped.swap16();
    return swapped.toString('utf16le');
  }
  return buf.toString('utf8');
}

class UsageError extends Error {}

function parseRunTarget(arg: string): { runId: number; repo?: RepoRef; attempt?: number; jobId?: number } {
  const url = /^https?:[/][/]([^/]+)[/]([^/]+)[/]([^/]+)[/]actions[/]runs[/](\d+)(?:[/]attempts[/](\d+))?(?:[/]job[/](\d+))?/.exec(arg);
  if (url) {
    const out: { runId: number; repo?: RepoRef; attempt?: number; jobId?: number } = {
      runId: Number(url[4]),
      repo: { host: url[1]!, owner: url[2]!, repo: url[3]! },
    };
    if (url[5]) out.attempt = Number(url[5]);
    if (url[6]) out.jobId = Number(url[6]);
    return out;
  }
  if (!/^\d+$/.test(arg) || Number(arg) <= 0 || !Number.isSafeInteger(Number(arg))) {
    throw new UsageError('"' + arg + '" is not a run ID. Use a number such as 1234567890 or a run URL.');
  }
  return { runId: Number(arg) };
}

function positiveInt(v: string | undefined, name: string): number | undefined {
  if (v === undefined) return undefined;
  if (!/^\d+$/.test(v) || Number(v) <= 0) throw new UsageError('--' + name + ' must be a positive integer.');
  return Number(v);
}

async function cmdAnalyze(args: string[], values: Record<string, string | boolean | undefined>, io: IO): Promise<number> {
  if (args.length !== 1) throw new UsageError('analyze needs exactly one argument: a log file path, or "-" for stdin.');
  const target = args[0]!;
  let buf: Buffer;
  if (target === '-') {
    buf = await io.readStdin();
  } else {
    try {
      buf = await readFile(target);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      const why = code === 'ENOENT' ? 'file not found' : code === 'EISDIR' ? 'it is a directory' : code === 'EACCES' ? 'permission denied' : String(e);
      io.err('Cannot read "' + target + '": ' + why + '.\n');
      return 1;
    }
  }
  const text = decodeLog(buf);
  const diagnosis = analyzeLog(text);
  const source = target === '-' ? 'stdin' : target;
  io.out(values['json'] ? localJson(diagnosis, source, getVersion()) : renderLocalText(diagnosis, source, { color: io.color }));
  return 0;
}

async function cmdRun(args: string[], values: Record<string, string | boolean | undefined>, io: IO): Promise<number> {
  if (args.length !== 1) throw new UsageError('run needs exactly one argument: a run ID or run URL.');
  const target = parseRunTarget(args[0]!);
  const hostOpt = (values['hostname'] as string | undefined) ?? io.env['GH_HOST'];
  const repoOpt = (values['repo'] as string | undefined) ?? io.env['GH_REPO'];

  let repo: RepoRef | null | undefined = target.repo;
  if (repoOpt) {
    try {
      repo = parseRepoArg(repoOpt, hostOpt ?? 'github.com');
    } catch (e) {
      throw new UsageError((e as Error).message);
    }
  }
  if (!repo) repo = await (io.detectRepo ?? repoFromGitRemote)();
  if (!repo) throw new UsageError('Could not determine the repository. Pass --repo OWNER/REPO (or run inside a clone with an "origin" remote).');
  if (hostOpt && !repoOpt && !target.repo) repo = { ...repo, host: hostOpt };

  const attempt = positiveInt(values['attempt'] as string | undefined, 'attempt') ?? target.attempt;
  const jobId = positiveInt(values['job'] as string | undefined, 'job') ?? target.jobId;
  const maxJobs = positiveInt(values['max-jobs'] as string | undefined, 'max-jobs');

  let client: GitHubClient;
  if (io.makeClient) {
    client = await io.makeClient(repo);
  } else {
    const { token, source } = await resolveToken(repo.host, io.env);
    if (!token) {
      io.err('Warning: no GitHub credentials found (set GH_TOKEN or run "gh auth login"). Job logs usually require authentication.\n');
    } else if (source === 'gh auth token') {
      // quiet: this is the expected path
    }
    client = new GitHubClient({ baseUrl: apiBaseFor(repo.host), ...(token ? { token } : {}), userAgent: 'ci-first-aid/' + getVersion() });
  }

  try {
    const report = await diagnoseRun(client, {
      repo,
      runId: target.runId,
      ...(attempt !== undefined ? { attempt } : {}),
      ...(jobId !== undefined ? { jobId } : {}),
      ...(maxJobs !== undefined ? { maxJobs } : {}),
      includeCancelled: Boolean(values['include-cancelled']),
    });
    io.out(values['json'] ? runJson(report, getVersion()) : renderRunText(report, { color: io.color }));
    return 0;
  } catch (e) {
    if (e instanceof GitHubError) {
      io.err('Error: ' + e.message + '\n' + (e.hint ? 'Hint: ' + e.hint + '\n' : ''));
      return 1;
    }
    throw e;
  }
}

export async function main(argv: string[], io: IO): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        json: { type: 'boolean' },
        'no-color': { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
        repo: { type: 'string', short: 'R' },
        attempt: { type: 'string' },
        job: { type: 'string' },
        'max-jobs': { type: 'string' },
        'include-cancelled': { type: 'boolean' },
        hostname: { type: 'string' },
      },
    });
  } catch (e) {
    io.err((e as Error).message + '\n\n' + HELP);
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.version) {
    io.out(getVersion() + '\n');
    return 0;
  }
  const [command, ...rest] = positionals;
  if (values.help || !command) {
    (command || values.help ? io.out : io.err)(HELP);
    return command || values.help ? 0 : 2;
  }
  if (values['no-color']) io = { ...io, color: false };
  try {
    if (command === 'analyze') return await cmdAnalyze(rest, values, io);
    if (command === 'run') return await cmdRun(rest, values, io);
    throw new UsageError('Unknown command "' + command + '".');
  } catch (e) {
    if (e instanceof UsageError) {
      io.err('Error: ' + e.message + '\n\nRun "ci-first-aid --help" for usage.\n');
      return 2;
    }
    io.err('Unexpected error: ' + (e instanceof Error ? e.message : String(e)) + '\n');
    return 1;
  }
}

async function readAllStdin(): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c as string));
  return Buffer.concat(chunks);
}

function isEntrypoint(): boolean {
  try {
    const self = fileURLToPath(import.meta.url);
    const arg = process.argv[1];
    return Boolean(arg) && realpathSync(arg!) === realpathSync(self);
  } catch {
    return false;
  }
}

if (isEntrypoint()) {
  const env = process.env;
  const color = Boolean(process.stdout.isTTY) && !env['NO_COLOR'] && env['TERM'] !== 'dumb' ? true : Boolean(env['FORCE_COLOR']) && !env['NO_COLOR'];
  main(process.argv.slice(2), {
    out: (s) => void process.stdout.write(s),
    err: (s) => void process.stderr.write(s),
    readStdin: readAllStdin,
    color,
    env,
  }).then(
    (code) => {
      process.exitCode = code;
    },
    (e: unknown) => {
      process.stderr.write('Fatal: ' + (e instanceof Error ? e.message : String(e)) + '\n');
      process.exitCode = 1;
    },
  );
}

// Referenced to keep the helper exported for programmatic use.
export { parseRemoteUrl };
