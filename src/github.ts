import { execFile } from 'node:child_process';

export type GitHubErrorKind = 'auth' | 'forbidden' | 'not-found' | 'gone' | 'rate-limit' | 'server' | 'network' | 'too-large' | 'other';

export class GitHubError extends Error {
  constructor(
    message: string,
    public readonly kind: GitHubErrorKind,
    public readonly status?: number,
    public readonly hint?: string,
  ) {
    super(message);
    this.name = 'GitHubError';
  }
}

export interface RepoRef {
  host: string;
  owner: string;
  repo: string;
}

export function apiBaseFor(host: string): string {
  return host === 'github.com' ? 'https://api.github.com' : 'https://' + host + '/api/v3';
}

/** Accepts OWNER/REPO or HOST/OWNER/REPO (the gh convention). */
export function parseRepoArg(value: string, defaultHost = 'github.com'): RepoRef {
  const parts = value.trim().replace(/[.]git$/, '').split('/').filter(Boolean);
  if (parts.length === 2 && parts[0] && parts[1]) return { host: defaultHost, owner: parts[0], repo: parts[1] };
  if (parts.length === 3 && parts[0] && parts[1] && parts[2]) return { host: parts[0], owner: parts[1], repo: parts[2] };
  throw new Error('Invalid repository "' + value + '". Use OWNER/REPO (or HOST/OWNER/REPO).');
}

/** Parses https://host/owner/repo(.git), ssh://git@host/owner/repo and git@host:owner/repo remotes. */
export function parseRemoteUrl(url: string): RepoRef | null {
  const u = url.trim();
  let m = /^(?:https?|ssh|git):[/][/](?:[^@/]+@)?([^/:]+)(?::\d+)?[/]([^/]+)[/]([^/]+?)(?:[.]git)?[/]?$/.exec(u);
  if (!m) m = /^(?:[^@/]+@)?([^:/]+):([^/]+)[/]([^/]+?)(?:[.]git)?$/.exec(u);
  if (!m || !m[1] || !m[2] || !m[3]) return null;
  return { host: m[1], owner: m[2], repo: m[3] };
}

function exec(cmd: string, args: string[], timeoutMs = 10000): Promise<{ ok: boolean; stdout: string }> {
  return new Promise((resolve) => {
    try {
      // execFile: no shell, so arguments are never interpreted.
      execFile(cmd, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout) => {
        resolve({ ok: !err, stdout: String(stdout ?? '') });
      });
    } catch {
      resolve({ ok: false, stdout: '' });
    }
  });
}

export async function repoFromGitRemote(): Promise<RepoRef | null> {
  const r = await exec('git', ['remote', 'get-url', 'origin']);
  return r.ok ? parseRemoteUrl(r.stdout) : null;
}

/** A bare DNS name or IPv4 address with an optional port. Rejects anything that could alter the URL or look like a CLI flag. */
export function isValidHost(host: string): boolean {
  return /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?(?::\d{1,5})?$/.test(host);
}

/** Looks up a token for a validated host in the gh credential store. Injectable so tests never spawn a real gh process. */
export type GhTokenLookup = (host: string) => Promise<string | undefined>;

/** Production lookup: `gh auth token --hostname HOST` (execFile, no shell). */
export async function ghAuthToken(host: string): Promise<string | undefined> {
  const r = await exec('gh', ['auth', 'token', '--hostname', host]);
  return r.ok ? r.stdout : undefined;
}

/**
 * Token precedence mirrors gh: GH_TOKEN / GITHUB_TOKEN for github.com only; GH_ENTERPRISE_TOKEN /
 * GITHUB_ENTERPRISE_TOKEN for any other host; then the gh CLI credential store.
 * A github.com token is never offered to another host (a run URL or --hostname may be attacker-chosen).
 */
export async function resolveToken(
  host: string,
  env: NodeJS.ProcessEnv = process.env,
  lookup: GhTokenLookup = ghAuthToken,
): Promise<{ token?: string; source: string }> {
  if (!isValidHost(host)) return { source: 'none' };
  const fromEnv = host === 'github.com' ? env['GH_TOKEN'] || env['GITHUB_TOKEN'] : env['GH_ENTERPRISE_TOKEN'] || env['GITHUB_ENTERPRISE_TOKEN'];
  if (fromEnv) return { token: fromEnv, source: 'environment' };
  const t = (await lookup(host))?.trim();
  if (t) return { token: t, source: 'gh auth token' };
  return { source: 'none' };
}

export interface ClientOptions {
  baseUrl: string;
  token?: string;
  fetchImpl?: typeof fetch;
  /** Retries for network errors and 5xx. Default 2. */
  retries?: number;
  retryDelayMs?: number;
  timeoutMs?: number;
  userAgent?: string;
}

function rateLimitInfo(res: Response): { remaining?: number; resetAt?: Date; retryAfter?: number } {
  const remaining = res.headers.get('x-ratelimit-remaining');
  const reset = res.headers.get('x-ratelimit-reset');
  const retry = res.headers.get('retry-after');
  const out: { remaining?: number; resetAt?: Date; retryAfter?: number } = {};
  if (remaining !== null) out.remaining = Number(remaining);
  if (reset !== null && Number(reset) > 0) out.resetAt = new Date(Number(reset) * 1000);
  if (retry !== null && Number(retry) >= 0) out.retryAfter = Number(retry);
  return out;
}

/**
 * Read-only GitHub REST client. It deliberately exposes GET requests only:
 * CIFirstAid never reruns, cancels, deletes or edits anything.
 */
export class GitHubClient {
  private readonly fetchImpl: typeof fetch;
  private readonly retries: number;
  private readonly retryDelayMs: number;
  private readonly timeoutMs: number;

  constructor(private readonly opts: ClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.retries = opts.retries ?? 2;
    this.retryDelayMs = opts.retryDelayMs ?? 500;
    this.timeoutMs = opts.timeoutMs ?? 30000;
  }

  private headers(withAuth: boolean, accept: string): Record<string, string> {
    const h: Record<string, string> = {
      Accept: accept,
      'User-Agent': this.opts.userAgent ?? 'ci-first-aid',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (withAuth && this.opts.token) h['Authorization'] = 'Bearer ' + this.opts.token;
    return h;
  }

  private async send(url: string, withAuth: boolean, accept: string, redirect: 'follow' | 'manual'): Promise<Response> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      try {
        const res = await this.fetchImpl(url, {
          method: 'GET',
          headers: this.headers(withAuth, accept),
          redirect,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (res.status >= 500 && attempt < this.retries) {
          await res.body?.cancel();
          await sleep(this.retryDelayMs * (attempt + 1));
          continue;
        }
        return res;
      } catch (e) {
        lastErr = e;
        if (attempt < this.retries) await sleep(this.retryDelayMs * (attempt + 1));
      }
    }
    const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
    throw new GitHubError('Network error talking to GitHub: ' + msg, 'network', undefined, 'Check your connection, proxy settings and that the GitHub host is reachable.');
  }

  private async toError(res: Response, what: string): Promise<GitHubError> {
    let detail = '';
    try {
      const body = (await res.json()) as { message?: string };
      detail = body.message ?? '';
    } catch {
      /* body is not JSON */
    }
    const rl = rateLimitInfo(res);
    const lower = detail.toLowerCase();
    if (res.status === 429 || (res.status === 403 && (rl.remaining === 0 || lower.includes('rate limit')))) {
      const when = rl.resetAt ? ' Resets at ' + rl.resetAt.toISOString() + '.' : rl.retryAfter !== undefined ? ' Retry after ' + rl.retryAfter + 's.' : '';
      return new GitHubError('GitHub API rate limit reached.' + when, 'rate-limit', res.status, 'Authenticate (gh auth login or GH_TOKEN) for a higher limit, or wait and retry.');
    }
    if (res.status === 401) {
      return new GitHubError('GitHub rejected the credentials (401) while ' + what + '.', 'auth', 401, 'Run "gh auth login" or set GH_TOKEN/GITHUB_TOKEN with read access to Actions.');
    }
    if (res.status === 403) {
      return new GitHubError(
        'Access denied (403) while ' + what + (detail ? ': ' + detail : '') + '.',
        'forbidden',
        403,
        'The token needs read access to the repository and Actions (classic: "repo" scope; fine-grained: "Actions: Read"). For SAML-protected organisations authorize the token for SSO.',
      );
    }
    if (res.status === 404) {
      return new GitHubError('Not found (404) while ' + what + '.', 'not-found', 404, 'Check the repository and ID. GitHub also returns 404 when a private repository is not accessible to your token.');
    }
    if (res.status === 410) {
      return new GitHubError('Gone (410) while ' + what + '.', 'gone', 410, 'The data has been deleted or has expired.');
    }
    if (res.status >= 500) {
      return new GitHubError('GitHub returned a server error (' + res.status + ') while ' + what + '.', 'server', res.status, 'Check githubstatus.com and retry.');
    }
    return new GitHubError('Unexpected response (' + res.status + ') while ' + what + (detail ? ': ' + detail : '') + '.', 'other', res.status);
  }

  async getJson<T>(path: string, what: string, query?: Record<string, string | number>): Promise<T> {
    const qs = query ? '?' + new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)])).toString() : '';
    const res = await this.send(this.opts.baseUrl + path + qs, true, 'application/vnd.github+json', 'follow');
    if (!res.ok) throw await this.toError(res, what);
    try {
      return (await res.json()) as T;
    } catch {
      throw new GitHubError('GitHub returned an unreadable response while ' + what + '.', 'other', res.status);
    }
  }

  /**
   * Downloads a job log. The API answers 302 to a short-lived signed storage URL; we follow it
   * ourselves so the Authorization header is never sent to the storage host.
   * If the log exceeds maxBytes only the tail is kept (failures are at the end).
   */
  async getJobLog(path: string, what: string, maxBytes = 64 * 1024 * 1024): Promise<{ text: string; truncated: boolean }> {
    let res = await this.send(this.opts.baseUrl + path, true, 'application/vnd.github+json', 'manual');
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      await res.body?.cancel();
      if (!loc) throw new GitHubError('GitHub redirected the log request without a location while ' + what + '.', 'other', res.status);
      res = await this.send(loc, false, '*/*', 'follow');
    }
    if (!res.ok) throw await this.toError(res, what);

    const chunks: Uint8Array[] = [];
    let total = 0;
    let truncated = false;
    const reader = res.body?.getReader();
    if (!reader) return { text: await res.text(), truncated: false };
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      chunks.push(value);
      total += value.byteLength;
      while (total > maxBytes && chunks.length > 1) {
        total -= chunks.shift()!.byteLength;
        truncated = true;
      }
    }
    const buf = Buffer.concat(chunks);
    let text = new TextDecoder('utf-8').decode(buf);
    if (truncated) {
      const nl = text.indexOf('\n');
      if (nl >= 0) text = text.slice(nl + 1); // drop the partial first line
    }
    return { text, truncated };
  }
}

function sleep(ms: number): Promise<void> {
  return ms <= 0 ? Promise.resolve() : new Promise((r) => setTimeout(r, ms));
}
