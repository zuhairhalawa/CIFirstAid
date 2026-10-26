export const ESC = String.fromCharCode(27);

export interface GhLogOptions {
  /** Text of the final ##[error] annotation. Omit for none. */
  annotation?: string;
  crlf?: boolean;
  /** Prefix a BOM like the real GitHub log download. */
  bom?: boolean;
  command?: string;
}

/** Builds a log shaped like a real GitHub Actions job log around the given step output. */
export function ghLog(stepLines: string[], opts: GhLogOptions = {}): string {
  let sec = 0;
  const ts = () => '2026-10-23T17:18:' + String(10 + Math.floor(sec / 1000000)).padStart(2, '0') + '.' + String(sec++ % 10000000).padStart(7, '0') + 'Z ';
  const cmd = opts.command ?? 'npm test';
  const out: string[] = [
    "Current runner version: '2.338.0'",
    '##[group]Runner Image',
    'Image: ubuntu-24.04',
    '##[endgroup]',
    'Complete job name: build',
    '##[group]Run ' + cmd,
    ESC + '[36;1m' + cmd + ESC + '[0m',
    'shell: /usr/bin/bash -e {0}',
    'env:',
    '  CI: true',
    '##[endgroup]',
    ...stepLines,
  ];
  if (opts.annotation) out.push('##[error]' + opts.annotation);
  out.push('Cleaning up orphan processes');
  const eol = opts.crlf ? '\r\n' : '\n';
  return (opts.bom ? String.fromCharCode(0xfeff) : '') + out.map((l) => ts() + l).join(eol) + eol;
}
