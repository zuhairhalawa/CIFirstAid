import { describe, expect, it } from 'vitest';
import { GitHubClient, GitHubError, apiBaseFor, parseRemoteUrl, parseRepoArg, resolveToken } from '../src/github.js';
import { diagnoseRun } from '../src/run.js';
import { ghLog } from './helpers.js';

type Handler = (url: URL, init: RequestInit) => Response | Promise<Response>;

function mockFetch(routes: Record<string, Handler>) {
  const calls: { url: string; method: string; headers: Record<string, string> }[] = [];
  const impl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    calls.push({ url: String(input), method: init.method ?? 'GET', headers: { ...(init.headers as Record<string, string>) } });
    const key = url.host + url.pathname;
    const h = routes[key];
    if (!h) return new Response('{"message":"Not Found"}', { status: 404 });
    return h(url, init);
  }) as typeof fetch;
  return { impl, calls };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

function client(routes: Record<string, Handler>, extra: { retries?: number } = {}) {
  const m = mockFetch(routes);
  const c = new GitHubClient({ baseUrl: 'https://api.github.com', token: 'tok_secret', fetchImpl: m.impl, retries: extra.retries ?? 0, retryDelayMs: 0 });
  return { c, calls: m.calls };
}

describe('repo parsing', () => {
  it('parses OWNER/REPO and HOST/OWNER/REPO', () => {
    expect(parseRepoArg('octo/hello')).toEqual({ host: 'github.com', owner: 'octo', repo: 'hello' });
    expect(parseRepoArg('ghe.example.com/octo/hello')).toEqual({ host: 'ghe.example.com', owner: 'octo', repo: 'hello' });
    expect(() => parseRepoArg('nonsense')).toThrow(/Invalid repository/);
  });
  it('parses git remotes', () => {
    expect(parseRemoteUrl('https://github.com/octo/hello.git')).toEqual({ host: 'github.com', owner: 'octo', repo: 'hello' });
    expect(parseRemoteUrl('git@github.com:octo/hello.git')).toEqual({ host: 'github.com', owner: 'octo', repo: 'hello' });
    expect(parseRemoteUrl('ssh://git@ghe.example.com/octo/hello')).toEqual({ host: 'ghe.example.com', owner: 'octo', repo: 'hello' });
    expect(parseRemoteUrl('not a url')).toBeNull();
  });
  it('maps hosts to API bases', () => {
    expect(apiBaseFor('github.com')).toBe('https://api.github.com');
    expect(apiBaseFor('ghe.example.com')).toBe('https://ghe.example.com/api/v3');
  });
  it('prefers environment tokens', async () => {
    expect((await resolveToken('github.com', { GH_TOKEN: 'a', GITHUB_TOKEN: 'b' })).token).toBe('a');
    expect((await resolveToken('github.com', { GITHUB_TOKEN: 'b' })).token).toBe('b');
  });
});

describe('GitHubClient', () => {
  it('sends authenticated GET requests only', async () => {
    const { c, calls } = client({ 'api.github.com/repos/o/r/actions/runs/1': () => json({ id: 1 }) });
    await c.getJson('/repos/o/r/actions/runs/1', 'testing');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('GET');
    expect(calls[0]!.headers['Authorization']).toBe('Bearer tok_secret');
  });

  it('exposes no mutating methods', () => {
    const { c } = client({});
    const names = Object.getOwnPropertyNames(Object.getPrototypeOf(c));
    for (const bad of ['post', 'put', 'patch', 'delete', 'rerun', 'cancel']) expect(names).not.toContain(bad);
  });

  it('follows the log redirect without leaking the token to the storage host', async () => {
    const { c, calls } = client({
      'api.github.com/repos/o/r/actions/jobs/9/logs': () => new Response(null, { status: 302, headers: { location: 'https://blob.example.net/log?sig=abc' } }),
      'blob.example.net/log': () => new Response('hello log', { status: 200 }),
    });
    const r = await c.getJobLog('/repos/o/r/actions/jobs/9/logs', 'x');
    expect(r.text).toBe('hello log');
    expect(calls[0]!.headers['Authorization']).toBeDefined();
    expect(calls[1]!.url).toContain('blob.example.net');
    expect(calls[1]!.headers['Authorization']).toBeUndefined();
    expect(calls.every((x) => x.method === 'GET')).toBe(true);
  });

  it('keeps only the tail of oversized logs', async () => {
    const enc = new TextEncoder();
    const parts = ['first-line\n', 'y'.repeat(60) + '\n', 'z'.repeat(60) + '\n', 'last-line\n'];
    const stream = () =>
      new ReadableStream<Uint8Array>({
        start(ctrl) {
          for (const p of parts) ctrl.enqueue(enc.encode(p));
          ctrl.close();
        },
      });
    const { c } = client({ 'api.github.com/l': () => new Response(stream(), { status: 200 }) });
    const r = await c.getJobLog('/l', 'x', 80);
    expect(r.truncated).toBe(true);
    expect(r.text).toContain('last-line');
    expect(r.text).not.toContain('first-line');
  });

  it('maps HTTP failures to actionable errors', async () => {
    const reset = String(Math.floor(Date.now() / 1000) + 600);
    const cases: [Response, string][] = [
      [json({ message: 'Bad credentials' }, 401), 'auth'],
      [json({ message: 'Resource not accessible' }, 403), 'forbidden'],
      [json({ message: 'API rate limit exceeded' }, 403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': reset }), 'rate-limit'],
      [json({ message: 'slow down' }, 429, { 'retry-after': '30' }), 'rate-limit'],
      [json({ message: 'Not Found' }, 404), 'not-found'],
      [json({ message: 'gone' }, 410), 'gone'],
      [json({ message: 'oops' }, 502), 'server'],
    ];
    for (const [res, kind] of cases) {
      const { c } = client({ 'api.github.com/x': () => res.clone() });
      const err = await c.getJson('/x', 'testing').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(GitHubError);
      expect((err as GitHubError).kind).toBe(kind);
      expect((err as GitHubError).message.length).toBeGreaterThan(10);
    }
  });

  it('reports the rate-limit reset time', async () => {
    const reset = String(Math.floor(Date.now() / 1000) + 600);
    const { c } = client({ 'api.github.com/x': () => json({ message: 'API rate limit exceeded' }, 403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': reset }) });
    const err = (await c.getJson('/x', 't').catch((e: unknown) => e)) as GitHubError;
    expect(err.message).toContain('Resets at');
  });

  it('retries transient 5xx responses then succeeds', async () => {
    let n = 0;
    const { c } = client({ 'api.github.com/x': () => (++n < 3 ? json({}, 503) : json({ ok: true })) }, { retries: 2 });
    expect(await c.getJson('/x', 't')).toEqual({ ok: true });
    expect(n).toBe(3);
  });

  it('turns network failures into a network error', async () => {
    const c = new GitHubClient({
      baseUrl: 'https://api.github.com',
      fetchImpl: (async () => {
        throw new TypeError('fetch failed');
      }) as typeof fetch,
      retries: 1,
      retryDelayMs: 0,
    });
    const err = (await c.getJson('/x', 't').catch((e: unknown) => e)) as GitHubError;
    expect(err.kind).toBe('network');
  });
});

// ---- run orchestration ------------------------------------------------------

const REPO = { host: 'github.com', owner: 'o', repo: 'r' };
const P = 'api.github.com/repos/o/r';

function job(id: number, name: string, conclusion: string, steps: { name: string; conclusion: string }[] = []) {
  return { id, name, status: 'completed', conclusion, html_url: 'https://github.com/o/r/actions/runs/1/job/' + id, steps: steps.map((s, i) => ({ ...s, number: i + 1, status: 'completed' })) };
}

const run = (over: Record<string, unknown> = {}) => ({ id: 1, name: 'CI', display_title: 'fix stuff', status: 'completed', conclusion: 'failure', run_attempt: 1, html_url: 'https://github.com/o/r/actions/runs/1', head_branch: 'main', head_sha: 'abcdef1234', event: 'push', ...over });

describe('diagnoseRun', () => {
  it('diagnoses every failed job and picks the strongest root cause', async () => {
    const m = mockFetch({
      [P + '/actions/runs/1']: () => json(run()),
      [P + '/actions/runs/1/attempts/1/jobs']: () =>
        json({ total_count: 3, jobs: [job(11, 'lint', 'failure', [{ name: 'Run eslint', conclusion: 'failure' }]), job(12, 'test', 'failure', [{ name: 'Run npm test', conclusion: 'failure' }]), job(13, 'build', 'success')] }),
      [P + '/actions/jobs/11/logs']: () => new Response(null, { status: 302, headers: { location: 'https://blob.example.net/l11' } }),
      [P + '/actions/jobs/12/logs']: () => new Response(null, { status: 302, headers: { location: 'https://blob.example.net/l12' } }),
      'blob.example.net/l11': () => new Response(ghLog(['Error: Missing required environment variable: LINT_TOKEN'], { annotation: 'Process completed with exit code 1.' })),
      'blob.example.net/l12': () => new Response(ghLog(["src/a.ts(1,1): error TS2322: bad"], { annotation: 'Process completed with exit code 2.' })),
    });
    const c = new GitHubClient({ baseUrl: 'https://api.github.com', token: 't', fetchImpl: m.impl, retries: 0 });
    const report = await diagnoseRun(c, { repo: REPO, runId: 1 });
    expect(report.jobs.map((j) => j.name)).toEqual(['lint', 'test']);
    expect(report.jobs[0]!.failedSteps).toEqual(['Run eslint']);
    expect(report.jobs[0]!.diagnosis!.primary!.id).toBe('env-var-missing');
    expect(report.jobs[1]!.diagnosis!.primary!.id).toBe('typescript-compile-error');
    expect(report.primary).not.toBeNull();
    expect(m.calls.every((x) => x.method === 'GET')).toBe(true);
    // The token must never be sent to the blob host.
    expect(m.calls.filter((x) => x.url.includes('blob.example.net')).every((x) => x.headers['Authorization'] === undefined)).toBe(true);
  });

  it('uses the requested rerun attempt and notes earlier attempts', async () => {
    const m = mockFetch({
      [P + '/actions/runs/1/attempts/2']: () => json(run({ run_attempt: 3 })),
      [P + '/actions/runs/1/attempts/2/jobs']: () => json({ total_count: 0, jobs: [] }),
    });
    const c = new GitHubClient({ baseUrl: 'https://api.github.com', fetchImpl: m.impl, retries: 0 });
    const report = await diagnoseRun(c, { repo: REPO, runId: 1, attempt: 2 });
    expect(report.attempt).toBe(2);
    expect(report.latestAttempt).toBe(3);
    expect(report.notes.join(' ')).toContain('attempt 2 of 3');
  });

  it('mentions re-run attempts when analyzing the latest one', async () => {
    const m = mockFetch({
      [P + '/actions/runs/1']: () => json(run({ run_attempt: 2 })),
      [P + '/actions/runs/1/attempts/2/jobs']: () => json({ total_count: 1, jobs: [job(5, 'x', 'success')] }),
    });
    const c = new GitHubClient({ baseUrl: 'https://api.github.com', fetchImpl: m.impl, retries: 0 });
    const report = await diagnoseRun(c, { repo: REPO, runId: 1 });
    expect(report.notes.join(' ')).toContain('re-run attempt 2');
  });

  it('falls back to annotations when the log has expired', async () => {
    const m = mockFetch({
      [P + '/actions/runs/1']: () => json(run()),
      [P + '/actions/runs/1/attempts/1/jobs']: () => json({ total_count: 1, jobs: [job(21, 'deploy', 'failure')] }),
      [P + '/actions/jobs/21/logs']: () => json({ message: 'Not Found' }, 404),
      [P + '/check-runs/21/annotations']: () => json([{ annotation_level: 'failure', message: 'Resource not accessible by integration', path: '.github' }]),
    });
    const c = new GitHubClient({ baseUrl: 'https://api.github.com', token: 't', fetchImpl: m.impl, retries: 0 });
    const report = await diagnoseRun(c, { repo: REPO, runId: 1 });
    const j = report.jobs[0]!;
    expect(j.logSource).toBe('annotations');
    expect(j.diagnosis!.primary!.id).toBe('resource-not-accessible');
    expect(j.notes.join(' ')).toMatch(/unavailable/);
  });

  it('reports a job whose log and annotations are both unavailable without crashing', async () => {
    const m = mockFetch({
      [P + '/actions/runs/1']: () => json(run()),
      [P + '/actions/runs/1/attempts/1/jobs']: () => json({ total_count: 1, jobs: [job(31, 'x', 'failure')] }),
      [P + '/actions/jobs/31/logs']: () => json({ message: 'gone' }, 410),
      [P + '/check-runs/31/annotations']: () => json([]),
    });
    const c = new GitHubClient({ baseUrl: 'https://api.github.com', token: 't', fetchImpl: m.impl, retries: 0 });
    const report = await diagnoseRun(c, { repo: REPO, runId: 1 });
    expect(report.jobs[0]!.diagnosis).toBeNull();
    expect(report.jobs[0]!.logSource).toBe('none');
    expect(report.summary).toMatch(/no diagnosis|unavailable/i);
  });

  it('treats a log 403 as non-fatal and falls back', async () => {
    const m = mockFetch({
      [P + '/actions/runs/1']: () => json(run()),
      [P + '/actions/runs/1/attempts/1/jobs']: () => json({ total_count: 1, jobs: [job(41, 'x', 'failure')] }),
      [P + '/actions/jobs/41/logs']: () => json({ message: 'Must have admin rights to Repository.' }, 403),
      [P + '/check-runs/41/annotations']: () => json([{ annotation_level: 'failure', message: 'Process completed with exit code 127.' }]),
    });
    const c = new GitHubClient({ baseUrl: 'https://api.github.com', token: 't', fetchImpl: m.impl, retries: 0 });
    const report = await diagnoseRun(c, { repo: REPO, runId: 1 });
    expect(report.jobs[0]!.logSource).toBe('annotations');
  });

  it('explains runs that failed before any job started', async () => {
    const m = mockFetch({
      [P + '/actions/runs/1']: () => json(run()),
      [P + '/actions/runs/1/attempts/1/jobs']: () => json({ total_count: 0, jobs: [] }),
    });
    const c = new GitHubClient({ baseUrl: 'https://api.github.com', fetchImpl: m.impl, retries: 0 });
    const report = await diagnoseRun(c, { repo: REPO, runId: 1 });
    expect(report.jobs).toHaveLength(0);
    expect(report.summary).toMatch(/before any job started/);
    expect(report.notes.join(' ')).toMatch(/invalid workflow file|startup failure/i);
  });

  it('handles incomplete runs', async () => {
    const m = mockFetch({
      [P + '/actions/runs/1']: () => json(run({ status: 'in_progress', conclusion: null })),
      [P + '/actions/runs/1/attempts/1/jobs']: () =>
        json({ total_count: 2, jobs: [{ ...job(51, 'a', 'failure'), status: 'completed' }, { id: 52, name: 'b', status: 'in_progress', conclusion: null }] }),
      [P + '/actions/jobs/51/logs']: () => new Response(ghLog(['Error: Missing required environment variable: SOME_KEY'], { annotation: 'Process completed with exit code 1.' })),
    });
    const c = new GitHubClient({ baseUrl: 'https://api.github.com', token: 't', fetchImpl: m.impl, retries: 0 });
    const report = await diagnoseRun(c, { repo: REPO, runId: 1 });
    expect(report.notes.join(' ')).toMatch(/still "in_progress"/);
    expect(report.notes.join(' ')).toMatch(/have not finished/);
    expect(report.jobs).toHaveLength(1);
  });

  it('says so when the run succeeded', async () => {
    const m = mockFetch({
      [P + '/actions/runs/1']: () => json(run({ conclusion: 'success' })),
      [P + '/actions/runs/1/attempts/1/jobs']: () => json({ total_count: 1, jobs: [job(61, 'a', 'success')] }),
    });
    const c = new GitHubClient({ baseUrl: 'https://api.github.com', fetchImpl: m.impl, retries: 0 });
    const report = await diagnoseRun(c, { repo: REPO, runId: 1 });
    expect(report.summary).toMatch(/succeeded/);
  });

  it('shows cancelled jobs only when nothing failed and the run was cancelled', async () => {
    const m = mockFetch({
      [P + '/actions/runs/1']: () => json(run({ conclusion: 'cancelled' })),
      [P + '/actions/runs/1/attempts/1/jobs']: () => json({ total_count: 1, jobs: [job(71, 'a', 'cancelled')] }),
      [P + '/actions/jobs/71/logs']: () => new Response(ghLog(['working'], { annotation: 'The run was canceled by @octocat.' })),
    });
    const c = new GitHubClient({ baseUrl: 'https://api.github.com', token: 't', fetchImpl: m.impl, retries: 0 });
    const report = await diagnoseRun(c, { repo: REPO, runId: 1 });
    expect(report.jobs).toHaveLength(1);
    expect(report.jobs[0]!.diagnosis!.primary!.id).toBe('concurrency-cancelled');
  });

  it('paginates job lists', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => job(1000 + i, 'j' + i, 'success'));
    const page2 = [job(2000, 'last', 'failure')];
    const m = mockFetch({
      [P + '/actions/runs/1']: () => json(run()),
      [P + '/actions/runs/1/attempts/1/jobs']: (url) => json({ total_count: 101, jobs: url.searchParams.get('page') === '1' ? page1 : page2 }),
      [P + '/actions/jobs/2000/logs']: () => new Response(ghLog(['Error: Missing required environment variable: PAGED_KEY'], { annotation: 'Process completed with exit code 1.' })),
    });
    const c = new GitHubClient({ baseUrl: 'https://api.github.com', token: 't', fetchImpl: m.impl, retries: 0 });
    const report = await diagnoseRun(c, { repo: REPO, runId: 1 });
    expect(report.jobs.map((j) => j.id)).toEqual([2000]);
  });

  it('propagates authentication failures instead of hiding them', async () => {
    const m = mockFetch({ [P + '/actions/runs/1']: () => json({ message: 'Bad credentials' }, 401) });
    const c = new GitHubClient({ baseUrl: 'https://api.github.com', fetchImpl: m.impl, retries: 0 });
    await expect(diagnoseRun(c, { repo: REPO, runId: 1 })).rejects.toMatchObject({ kind: 'auth' });
  });

  it('stops on rate limits while downloading logs', async () => {
    const m = mockFetch({
      [P + '/actions/runs/1']: () => json(run()),
      [P + '/actions/runs/1/attempts/1/jobs']: () => json({ total_count: 1, jobs: [job(81, 'a', 'failure')] }),
      [P + '/actions/jobs/81/logs']: () => json({ message: 'API rate limit exceeded' }, 403, { 'x-ratelimit-remaining': '0' }),
    });
    const c = new GitHubClient({ baseUrl: 'https://api.github.com', token: 't', fetchImpl: m.impl, retries: 0 });
    await expect(diagnoseRun(c, { repo: REPO, runId: 1 })).rejects.toMatchObject({ kind: 'rate-limit' });
  });

  it('only issues GET requests across the whole flow', async () => {
    const m = mockFetch({
      [P + '/actions/runs/1']: () => json(run()),
      [P + '/actions/runs/1/attempts/1/jobs']: () => json({ total_count: 1, jobs: [job(91, 'a', 'failure')] }),
      [P + '/actions/jobs/91/logs']: () => json({ message: 'Not Found' }, 404),
      [P + '/check-runs/91/annotations']: () => json([]),
    });
    const c = new GitHubClient({ baseUrl: 'https://api.github.com', token: 't', fetchImpl: m.impl, retries: 0 });
    await diagnoseRun(c, { repo: REPO, runId: 1 });
    expect(m.calls.length).toBeGreaterThan(2);
    expect(new Set(m.calls.map((x) => x.method))).toEqual(new Set(['GET']));
  });
});
