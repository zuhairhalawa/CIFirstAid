import type { LogLine, LogStats } from './types.js';

// GitHub timestamps have 7 fractional digits; other CIs use 3-9 or none.
const TS_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z)\s?/;
const GROUP_START_RE = /^##\[group\](.*)$/;
const GROUP_END_RE = /^##\[endgroup\]/;
const LEVEL_RE = /^##\[(error|warning|notice)\]\s?(.*)$/;
const LEGACY_LEVEL_RE = /^::(error|warning|notice)(?:\s[^:]*)?::(.*)$/;
const DEBUG_RE = /^##\[(debug|command|section)\]/;
const BUILDKIT_RE = /^#(\d+) (\d+(?:\.\d+)?) (.*)$/;

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const BS = String.fromCharCode(92);
// CSI sequences, OSC sequences (BEL or ESC-backslash terminated) and lone two-char ESC sequences.
const ANSI_RE = new RegExp(
  [
    ESC + '[[][0-?]*[ -/]*[@-~]',
    // Note: in JS "[]]" is an empty class plus a literal "]", so the bracket is escaped instead.
    ESC + BS + '][^' + BEL + ESC + ']*(?:' + BEL + '|' + ESC + BS + BS + ')',
    ESC + '[@-Z' + BS + BS + '-_]',
  ].join('|'),
  'g',
);
// The runner colours the echoed script source with SGR "36;1".
const SCRIPT_ECHO_RE = new RegExp('^' + ESC + '[[]36;1m');

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

export interface NormalizeOptions {
  /** Hard cap on lines kept (the last ones), to bound memory on pathological inputs. */
  maxLines?: number;
}

export interface NormalizedLog {
  lines: LogLine[];
  stats: LogStats;
}

const CR = String.fromCharCode(13);
const LF = String.fromCharCode(10);
const LINE_SPLIT_RE = new RegExp(CR + LF + '|' + LF + '|' + CR);

export function normalizeLog(input: string, opts: NormalizeOptions = {}): NormalizedLog {
  const maxLines = opts.maxLines ?? 2_000_000;
  let text = input;
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const crlf = text.includes(CR + LF);
  // Split on CRLF, LF, and bare CR (progress bars rewrite lines with CR).
  const rawLines = text.split(LINE_SPLIT_RE);
  if (rawLines.length > 0 && rawLines[rawLines.length - 1] === '') rawLines.pop();

  const lines: LogLine[] = [];
  let ansiStripped = false;
  let timestamped = false;
  let githubFormat = false;
  let errorAnnotations = 0;
  let group: string | undefined;
  let inRunBlock = false;
  let truncated = false;

  // Failures are reported at the end of a log, so when the input is too large keep the tail
  // (line numbers stay those of the original input).
  const start = Math.max(0, rawLines.length - maxLines);
  if (start > 0) truncated = true;
  for (let i = start; i < rawLines.length; i++) {
    const raw = rawLines[i] ?? '';
    let rest = raw;
    let timestamp: string | undefined;
    const tm = TS_RE.exec(rest);
    if (tm) {
      timestamp = tm[1];
      rest = rest.slice(tm[0].length);
      timestamped = true;
    }
    const echo = SCRIPT_ECHO_RE.test(rest);
    const clean = stripAnsi(rest);
    if (clean.length !== rest.length) ansiStripped = true;

    const line: LogLine = { n: i + 1, text: clean, raw };
    if (timestamp) line.timestamp = timestamp;

    // Docker BuildKit prefixes step output with "#<id> <seconds> ". Strip it so the
    // tool's own error signatures (npm, pip, tsc...) stay detectable, but remember the step.
    const bk = BUILDKIT_RE.exec(clean);
    if (bk) {
      line.text = bk[3] ?? '';
      line.buildkit = bk[1] ?? '';
    }

    const gs = GROUP_START_RE.exec(clean);
    if (gs) {
      githubFormat = true;
      group = (gs[1] ?? '').trim();
      inRunBlock = group.startsWith('Run ');
      line.group = group;
      line.echo = true;
      lines.push(line);
      continue;
    }
    if (GROUP_END_RE.test(clean)) {
      githubFormat = true;
      if (group !== undefined) line.group = group;
      line.echo = true;
      group = undefined;
      inRunBlock = false;
      lines.push(line);
      continue;
    }

    const lv = LEVEL_RE.exec(clean) ?? LEGACY_LEVEL_RE.exec(clean);
    if (lv) {
      githubFormat = true;
      line.level = lv[1] as 'error' | 'warning' | 'notice';
      line.text = (lv[2] ?? '').trim();
      if (line.level === 'error') errorAnnotations++;
    } else if (DEBUG_RE.test(clean)) {
      githubFormat = true;
      line.echo = true;
    }

    if (group !== undefined) line.group = group;
    // Inside a "Run ..." group the runner prints the script source, then
    // "shell:" and "env:" metadata. None of that is program output.
    if (echo) line.echo = true;
    if (inRunBlock && /^(shell:|env:|\s{2}[A-Za-z_][A-Za-z0-9_]*: )/.test(clean)) line.echo = true;
    lines.push(line);
  }

  return {
    lines,
    stats: {
      lines: lines.length,
      ansiStripped,
      timestamped,
      githubFormat,
      crlf,
      errorAnnotations,
      truncated,
    },
  };
}
