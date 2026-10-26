import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main, type IO } from '../src/cli.js';
import { GitHubClient } from '../src/github.js';
import { ghLog } from './helpers.js';

function makeIO(over: Partial<IO> = {}, stdin = '') {
  const out: string[] = [];
  const err: string[] = [];
  const io: IO = {
    out: (s) => void out.push(s),
    err: (s) => void err.push(s),
    readStdin: async () => Buffer.from(stdin, 'utf8'),
    color: false,
    env: {},
    ...over,
  };
  return { io, out: () => out.join(''), err: () => err.join('') };
}

function tmpFile(name: string, data: string | Buffer): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'cifa-'));
  const path = join(dir, name);
  writeFileSync(path, data);
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const TS_LOG = ghLog(["src/a.ts(10,5): error TS2322: Type 'string' is not assignable to type 'number'."], { annotation: 'Process completed with exit code 2.' });

describe('analyze', () => {
  it('analyzes a file', async () => {
    const f = tmpFile('failed.log', TS_LOG);
    const t = makeIO();
    expect(await main(['analyze', f.path], t.io)).toBe(0);
    expect(t.out()).toContain('ROOT CAUSE');
    expect(t.out()).toContain('TypeScript compilation failed');
    expect(t.out()).toContain('src/a.ts(10,5)');
    expect(t.out()).not.toContain(String.fromCharCode(27)); // no colour when disabled
    f.cleanup();
  });

  it('analyzes stdin with "-"', async () => {
    const t = makeIO({}, TS_LOG);
    expect(await main(['analyze', '-'], t.io)).toBe(0);
    expect(t.out()).toContain('stdin');
    expect(t.out()).toContain('TypeScript');
  });

  it('emits valid, stable JSON with --json', async () => {
    const f = tmpFile('failed.log', TS_LOG);
    const t = makeIO();
    expect(await main(['analyze', f.path, '--json'], t.io)).toBe(0);
    const j = JSON.parse(t.out());
    expect(j.schemaVersion).toBe(1);
    expect(j.mode).toBe('analyze');
    expect(j.diagnosis.primary.id).toBe('typescript-compile-error');
    expect(j.diagnosis.primary.evidence[0].line).toBeGreaterThan(0);
    expect(j.diagnosis.stats.githubFormat).toBe(true);
    f.cleanup();
  });

  it('reads UTF-16 logs produced by PowerShell redirection', async () => {
    const f = tmpFile('ps.log', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(TS_LOG, 'utf16le')]));
    const t = makeIO();
    expect(await main(['analyze', f.path, '--json'], t.io)).toBe(0);
    expect(JSON.parse(t.out()).diagnosis.primary.id).toBe('typescript-compile-error');
    f.cleanup();
  });

  it('reports a missing file with exit code 1', async () => {
    const t = makeIO();
    expect(await main(['analyze', join(tmpdir(), 'definitely-missing.log')], t.io)).toBe(1);
    expect(t.err()).toContain('file not found');
  });

  it('reports a directory with exit code 1', async () => {
    const f = tmpFile('x.log', 'x');
    const t = makeIO();
    expect(await main(['analyze', join(f.path, '..')], t.io)).toBe(1);
    f.cleanup();
  });

  it('says so cleanly when nothing is found', async () => {
    const t = makeIO({}, 'all good\n');
    expect(await main(['analyze', '-'], t.io)).toBe(0);
    expect(t.out()).toContain('No known failure signature');
  });

  it('never makes a network call', async () => {
    const orig = globalThis.fetch;
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      throw new Error('network is forbidden in analyze');
    }) as typeof fetch;
    try {
      const t = makeIO({}, TS_LOG);
      expect(await main(['analyze', '-'], t.io)).toBe(0);
      expect(called).toBe(false);
    } finally {
      globalThis.fetch = orig;
    }
  });
});

describe('usage', () => {
  it('prints help and exits 0 with --help', async () => {
    const t = makeIO();
    expect(await main(['--help'], t.io)).toBe(0);
    expect(t.out()).toContain('ci-first-aid analyze');
    expect(t.out()).toContain('never reruns, cancels, deletes or modifies');
  });
  it('prints the version', async () => {
    const t = makeIO();
    expect(await main(['--version'], t.io)).toBe(0);
    expect(t.out().trim()).toMatch(/^\d+\.\d+\.\d+/);
  });
  it('exits 2 with no command', async () => {
    const t = makeIO();
    expect(await main([], t.io)).toBe(2);
  });
  it('exits 2 for unknown commands and options', async () => {
    expect(await main(['frobnicate'], makeIO().io)).toBe(2);
    expect(await main(['analyze', 'x', '--nope'], makeIO().io)).toBe(2);
  });
  it('exits 2 when analyze has no file', async () => {
    expect(await main(['analyze'], makeIO().io)).toBe(2);
  });
  it('rejects bad run ids and options', async () => {
    expect(await main(['run', 'abc', '--repo', 'o/r'], makeIO().io)).toBe(2);
    expect(await main(['run', '12', '--repo', 'nonsense'], makeIO().io)).toBe(2);
    expect(await main(['run', '12', '--repo', 'o/r', '--attempt', '0'], makeIO().io)).toBe(2);
  });
});

describe('run', () => {
  const P = 'api.github.com/repos/o/r';
  function fakeClient(routes: Record<string, () => Response>): GitHubClient {
    const impl = (async (input: string | URL | Request) => {
      const u = new URL(String(input));
      const h = routes[u.host + u.pathname];
      return h ? h() : new Response('{"message":"Not Found"}', { status: 404 });
    }) as typeof fetch;
    return new GitHubClient({ baseUrl: 'https://api.github.com', token: 't', fetchImpl: impl, retries: 0 });
  }
  const j = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s });
  const routes = {
    [P + '/actions/runs/77']: () => j({ id: 77, name: 'CI', status: 'completed', conclusion: 'failure', run_attempt: 1, html_url: 'https://github.com/o/r/actions/runs/77', head_branch: 'main', head_sha: 'abcdef123' }),
    [P + '/actions/runs/77/attempts/1/jobs']: () => j({ total_count: 1, jobs: [{ id: 5, name: 'build', status: 'completed', conclusion: 'failure', steps: [{ name: 'Run npm ci', number: 1, status: 'completed', conclusion: 'failure' }] }] }),
    [P + '/actions/jobs/5/logs']: () => new Response(ghLog(['Error: Missing required environment variable: DATABASE_URL'], { annotation: 'Process completed with exit code 1.' })),
  };

  it('prints a run diagnosis', async () => {
    const t = makeIO({ makeClient: () => fakeClient(routes) });
    expect(await main(['run', '77', '--repo', 'o/r'], t.io)).toBe(0);
    expect(t.out()).toContain('o/r run 77');
    expect(t.out()).toContain('Failed step: Run npm ci');
    expect(t.out()).toContain('Missing environment variable: DATABASE_URL');
  });

  it('prints JSON for runs', async () => {
    const t = makeIO({ makeClient: () => fakeClient(routes) });
    expect(await main(['run', '77', '-R', 'o/r', '--json'], t.io)).toBe(0);
    const out = JSON.parse(t.out());
    expect(out.mode).toBe('run');
    expect(out.run.jobs[0].diagnosis.primary.id).toBe('env-var-missing');
  });

  it('accepts a run URL and needs no --repo', async () => {
    const t = makeIO({ makeClient: () => fakeClient(routes) });
    expect(await main(['run', 'https://github.com/o/r/actions/runs/77'], t.io)).toBe(0);
    expect(t.out()).toContain('o/r run 77');
  });

  it('uses the git remote when --repo is omitted', async () => {
    const t = makeIO({ makeClient: () => fakeClient(routes), detectRepo: async () => ({ host: 'github.com', owner: 'o', repo: 'r' }) });
    expect(await main(['run', '77'], t.io)).toBe(0);
  });

  it('fails with usage error when the repo cannot be determined', async () => {
    const t = makeIO({ detectRepo: async () => null });
    expect(await main(['run', '77'], t.io)).toBe(2);
    expect(t.err()).toContain('--repo');
  });

  it('turns GitHub errors into a readable message and exit code 1', async () => {
    const t = makeIO({ makeClient: () => fakeClient({ [P + '/actions/runs/77']: () => j({ message: 'Bad credentials' }, 401) }) });
    expect(await main(['run', '77', '--repo', 'o/r'], t.io)).toBe(1);
    expect(t.err()).toContain('credentials');
    expect(t.err()).toContain('gh auth login');
  });

  it('rejects a malformed host in a run URL as a usage error', async () => {
    const t = makeIO({ makeClient: () => fakeClient(routes) });
    expect(await main(['run', 'https://a@evil.example/o/r/actions/runs/77'], t.io)).toBe(2);
    expect(t.err()).toContain('Invalid GitHub host');
  });

  it('reports a missing run', async () => {
    const t = makeIO({ makeClient: () => fakeClient({}) });
    expect(await main(['run', '99', '--repo', 'o/r'], t.io)).toBe(1);
    expect(t.err()).toContain('Not found');
  });
});
