import { afterEach, describe, expect, it, vi } from 'vitest';

// child_process is replaced, so nothing in this file can ever spawn a real gh or git process.
const execFileMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ execFile: execFileMock }));

import { ghAuthToken, resolveToken } from '../src/github.js';

type Cb = (err: Error | null, stdout: string) => void;
function respond(err: Error | null, stdout: string) {
  execFileMock.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Cb) => {
    cb(err, stdout);
  });
}

afterEach(() => {
  execFileMock.mockReset();
  vi.restoreAllMocks();
});

describe('gh credential store (production path, subprocess mocked)', () => {
  it('runs `gh auth token --hostname HOST` without a shell and uses its output', async () => {
    respond(null, 'tok-123\n');
    expect(await resolveToken('ghe.example.com', {})).toEqual({ token: 'tok-123', source: 'gh auth token' });
    expect(execFileMock).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = execFileMock.mock.calls[0] as [string, string[], Record<string, unknown>];
    expect(cmd).toBe('gh');
    expect(args).toEqual(['auth', 'token', '--hostname', 'ghe.example.com']);
    expect(opts['shell']).toBeUndefined();
    expect(typeof opts['timeout']).toBe('number');
  });

  it('returns no credentials when gh fails or is missing', async () => {
    respond(new Error('spawn gh ENOENT'), '');
    expect(await resolveToken('ghe.example.com', {})).toEqual({ source: 'none' });
    expect(await ghAuthToken('ghe.example.com')).toBeUndefined();
  });

  it('returns no credentials when execFile throws synchronously', async () => {
    execFileMock.mockImplementation(() => {
      throw new Error('boom');
    });
    expect(await resolveToken('ghe.example.com', {})).toEqual({ source: 'none' });
  });

  it('does not spawn gh when an environment token applies or the host is invalid', async () => {
    expect((await resolveToken('github.com', { GH_TOKEN: 'a' })).token).toBe('a');
    expect((await resolveToken('ghe.example.com', { GH_ENTERPRISE_TOKEN: 'e' })).token).toBe('e');
    expect((await resolveToken('-x', {})).token).toBeUndefined();
    expect((await resolveToken('a@evil.com', { GH_TOKEN: 'a' })).token).toBeUndefined();
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('asks gh only for the requested host and never forwards a github.com env token', async () => {
    respond(new Error('not logged in'), '');
    const r = await resolveToken('ghe.example.com', { GH_TOKEN: 'ghcom-secret', GITHUB_TOKEN: 'ghcom-secret2' });
    expect(r.token).toBeUndefined();
    expect(execFileMock).toHaveBeenCalledTimes(1);
    const call = execFileMock.mock.calls[0] as [string, string[], { env?: unknown }];
    expect(JSON.stringify(call)).not.toContain('ghcom-secret');
    expect(call[2].env).toBeUndefined();
  });

  it('does not print credentials', async () => {
    const spies = [
      vi.spyOn(process.stdout, 'write').mockImplementation(() => true),
      vi.spyOn(process.stderr, 'write').mockImplementation(() => true),
      vi.spyOn(console, 'log').mockImplementation(() => {}),
      vi.spyOn(console, 'warn').mockImplementation(() => {}),
      vi.spyOn(console, 'error').mockImplementation(() => {}),
    ];
    respond(null, 'stored-secret\n');
    await resolveToken('ghe.example.com', { GH_TOKEN: 'ghcom-secret' });
    await resolveToken('github.com', { GH_TOKEN: 'env-secret' });
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});
