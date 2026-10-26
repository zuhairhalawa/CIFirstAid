import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { analyzeLog } from '../src/analyze.js';
import { ghLog } from './helpers.js';

const fixture = (name: string) => readFileSync(new URL('./fixtures/' + name, import.meta.url), 'utf8');
const evidenceText = (d: ReturnType<typeof analyzeLog>) => [d.primary!, ...d.others].flatMap((f) => f.evidence.map((e) => e.text)).join('\n');

/**
 * These fixtures are excerpts of REAL job logs downloaded from public repositories
 * (cli/cli, vercel/next.js, nodejs/node). They are here because the first implementation
 * got each of them wrong in a different way.
 */
describe('real-world logs', () => {
  it('cli/cli: finds the GraphQL server error behind a bare "exit code 1"', () => {
    const d = analyzeLog(fixture('real-github-graphql-error.log'));
    expect(d.primary!.id).toBe('upstream-5xx');
    expect(d.primary!.evidence.map((e) => e.text).join('\n')).toContain('Something went wrong while executing your query');
    // the unrelated line before the match must not be dragged in as "context"
    expect(d.primary!.evidence.map((e) => e.text).join('\n')).not.toContain('Complete job name');
    expect(d.stats.ansiStripped).toBe(true);
    expect(d.stats.timestamped).toBe(true);
  });

  it('vercel/next.js: reports the failing Jest tests, not check marks or bullets', () => {
    const d = analyzeLog(fixture('real-nextjs-jest-failure.log'));
    expect(d.primary!.id).toBe('js-test-failure');
    const ev = d.primary!.evidence.map((e) => e.text).join('\n');
    expect(ev).toContain('tree shakes dependencies of an unused export');
    expect(ev).toContain('Expected: false');
    expect(ev).not.toContain('Packages in scope');
  });

  it('vercel/next.js: demotes a harmless "unbound variable" printed before the failing step', () => {
    const d = analyzeLog(fixture('real-nextjs-jest-failure.log'));
    expect(d.primary!.category).not.toBe('missing-env');
    const env = d.others.find((f) => f.category === 'missing-env');
    if (env) expect(env.score).toBeLessThan(d.primary!.score);
  });

  it('nodejs/node: prefers the runner-flagged crashed test over an unrelated printed error', () => {
    const d = analyzeLog(fixture('real-nodejs-crashed-test.log'));
    expect(d.primary!.id).toBe('annotated-errors');
    const ev = d.primary!.evidence.map((e) => e.text).join('\n');
    expect(ev).toContain('test-inspector-connect-to-main-thread');
    expect(ev).toContain('CRASHED');
    const noise = d.others.find((f) => f.id === 'node-uncaught-error');
    if (noise) expect(noise.score).toBeLessThan(d.primary!.score);
  });
});

describe('ranking behaviour', () => {
  it('a strong signature near a runner-flagged error beats the same signature earlier in the log', () => {
    const log = ghLog(['retrying after ECONNRESET (attempt 1)', 'ok', 'ok', 'Error: Missing required environment variable: DB_PASSWORD'], { annotation: 'Process completed with exit code 1.' });
    expect(analyzeLog(log).primary!.id).toBe('env-var-missing');
  });

  it('noise printed by an earlier, successful step does not outrank the failing step', () => {
    const early = ['ECONNRESET talking to cache, retrying', 'ENOENT: no such file or directory, open \'/tmp/x\''];
    const failing = ["src/a.ts(1,1): error TS2322: bad"];
    const log = ghLog(early, { command: 'step one' }).replace('Cleaning up orphan processes\n', '') + ghLog(failing, { annotation: 'Process completed with exit code 2.', command: 'npm run build' });
    const d = analyzeLog(log);
    expect(d.primary!.id).toBe('typescript-compile-error');
  });

  it('shows runner-flagged error context when no signature is known', () => {
    const log = ghLog(['=== suite alpha ===', 'step 1 ok'], { annotation: 'Command: ./run-suite --fast' });
    const d = analyzeLog(log);
    expect(d.primary!.id).toBe('annotated-errors');
    expect(d.primary!.evidence.map((e) => e.text).join('\n')).toContain('=== suite alpha ===');
  });

  it('keeps the exit-code wrapper out of the primary slot when a cause exists', () => {
    const d = analyzeLog(ghLog(['Error: Missing required environment variable: SECRET_KEY'], { annotation: 'Process completed with exit code 1.' }));
    expect(d.others.find((f) => f.id === 'exit-code')?.score ?? 0).toBeLessThan(d.primary!.score);
  });
});
