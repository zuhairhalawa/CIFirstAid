import { describe, expect, it } from 'vitest';
import { normalizeLog, stripAnsi } from '../src/normalize.js';
import { redact } from '../src/redact.js';
import { decodeLog } from '../src/cli.js';
import { ESC } from './helpers.js';

describe('normalizeLog', () => {
  it('strips a BOM and timestamps', () => {
    const bom = String.fromCharCode(0xfeff);
    const { lines, stats } = normalizeLog(bom + '2026-10-23T17:18:13.7987888Z hello\n2026-10-23T17:18:14.0000000Z world\n');
    expect(lines.map((l) => l.text)).toEqual(['hello', 'world']);
    expect(lines[0]!.timestamp).toBe('2026-10-23T17:18:13.7987888Z');
    expect(stats.timestamped).toBe(true);
  });

  it('splits CRLF, LF and bare CR (progress bars) without producing blank lines', () => {
    const { lines } = normalizeLog('a\r\nb\nc\rd\r\n');
    expect(lines.map((l) => l.text)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('keeps original 1-based line numbers', () => {
    const { lines } = normalizeLog('one\ntwo\nthree');
    expect(lines.map((l) => l.n)).toEqual([1, 2, 3]);
  });

  it('removes CSI and OSC escape sequences', () => {
    const s = ESC + '[31;1mred' + ESC + '[0m ' + ESC + ']8;;http://x' + String.fromCharCode(7) + 'link' + ESC + ']8;;' + String.fromCharCode(7) + ESC + '[2K';
    expect(stripAnsi(s)).toBe('red link');
  });

  it('tracks groups, error annotations and script echo', () => {
    const log = ['##[group]Run npm test', ESC + '[36;1mnpm test' + ESC + '[0m', 'shell: /usr/bin/bash -e {0}', '##[endgroup]', 'real output', '##[error]boom', '::error file=a.ts::legacy'].join('\n');
    const { lines, stats } = normalizeLog(log);
    expect(lines[1]!.echo).toBe(true);
    expect(lines[2]!.echo).toBe(true);
    expect(lines[4]!.echo).toBeUndefined();
    expect(lines[5]!.level).toBe('error');
    expect(lines[5]!.text).toBe('boom');
    expect(lines[6]!.level).toBe('error');
    expect(stats.errorAnnotations).toBe(2);
    expect(stats.githubFormat).toBe(true);
  });

  it('strips BuildKit step prefixes but remembers the step', () => {
    const { lines } = normalizeLog('#12 5.231 npm error code ERESOLVE\n#12 DONE 6.0s\n');
    expect(lines[0]!.text).toBe('npm error code ERESOLVE');
    expect(lines[0]!.buildkit).toBe('12');
    expect(lines[1]!.buildkit).toBeUndefined();
  });

  it('caps the number of lines kept, keeping the tail with original line numbers', () => {
    const { lines, stats } = normalizeLog('a\nb\nc\nd\n', { maxLines: 2 });
    expect(lines.map((l) => [l.n, l.text])).toEqual([[3, 'c'], [4, 'd']]);
    expect(stats.truncated).toBe(true);
  });});

describe('decodeLog', () => {
  it('decodes UTF-16LE with BOM (PowerShell redirection)', () => {
    const buf = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('error TS2322: bad\n', 'utf16le')]);
    expect(decodeLog(buf)).toBe('error TS2322: bad\n');
  });
  it('decodes UTF-16BE with BOM', () => {
    const le = Buffer.from('hi\n', 'utf16le');
    le.swap16();
    expect(decodeLog(Buffer.concat([Buffer.from([0xfe, 0xff]), le]))).toBe('hi\n');
  });
  it('decodes UTF-8', () => {
    expect(decodeLog(Buffer.from('plain', 'utf8'))).toBe('plain');
  });
});

describe('redact', () => {
  it('redacts common token formats', () => {
    const cases = [
      'ghp_' + 'A'.repeat(36),
      'github_pat_' + 'B'.repeat(30),
      'npm_' + 'c'.repeat(36),
      'AKIA' + 'D'.repeat(16),
      'Authorization: Bearer ' + 'e'.repeat(40),
      'https://user:hunter2hunter2@example.com/repo.git',
      'password=supersecret123',
    ];
    for (const c of cases) {
      const r = redact('x ' + c + ' y');
      expect(r).toContain('REDACTED');
      expect(r).not.toContain('hunter2hunter2');
      expect(r).not.toContain('supersecret123');
      expect(r).not.toContain('A'.repeat(20));
    }
  });
  it('leaves normal text and already-masked values alone', () => {
    expect(redact('GH_TOKEN: ***')).toBe('GH_TOKEN: ***');
    expect(redact('npm error code ERESOLVE')).toBe('npm error code ERESOLVE');
  });
});
