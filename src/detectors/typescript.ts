import type { Finding } from '../types.js';
import { redact } from '../redact.js';
import { toEvidence, type Detector } from './rule.js';
import { plural } from './util.js';

// file(10,5): error TS2322: msg   |   file:10:5 - error TS2322: msg
const TS_ERR_RE = /^(.+?)(?:\((\d+),(\d+)\)|:(\d+):(\d+))\s*(?:-\s*)?error\s+(TS\d+):\s*(.+)$/;
// Config-level errors have no position: "error TS5083: Cannot read file ..."
const TS_CONFIG_ERR_RE = /^(?:\S+\s+)?error\s+(TS\d+):\s*(.+)$/;

const HINTS: Record<string, string> = {
  TS2307: 'A module could not be resolved: check the dependency is installed (npm ci), the import path/extension, and that @types/* packages exist.',
  TS2304: 'A name is used but not declared: check imports and the "lib"/"types" settings in tsconfig.json.',
  TS2322: 'A value does not match the declared type.',
  TS2339: 'A property does not exist on the type: check for a typo or a dependency version whose types changed.',
  TS2345: 'An argument does not match the parameter type.',
  TS7006: 'Implicit "any" under strict mode: add a type annotation.',
  TS2688: 'A type definition package listed in tsconfig "types" is missing: install the matching @types/* package.',
  TS5083: 'tsconfig.json could not be read: check the path and the working directory of the step.',
  TS6059: 'A file is outside "rootDir": check tsconfig "rootDir"/"include".',
};

export const typescriptDetector: Detector = (ctx) => {
  const errors: { n: number; text: string; file: string; code: string }[] = [];
  for (const line of ctx.body) {
    if (line.text.length > 2000) continue;
    const m = TS_ERR_RE.exec(line.text);
    if (m) {
      errors.push({ n: line.n, text: line.text, file: m[1] ?? '', code: m[6] ?? '' });
      continue;
    }
    const c = TS_CONFIG_ERR_RE.exec(line.text);
    if (c) errors.push({ n: line.n, text: line.text, file: '', code: c[1] ?? '' });
  }
  if (errors.length === 0) return [];

  // The same diagnostic is often printed twice (once by the tool, once as an ##[error] annotation).
  const unique = new Map<string, (typeof errors)[number]>();
  for (const e of errors) if (!unique.has(e.text.trim())) unique.set(e.text.trim(), e);
  const list = [...unique.values()];
  const files = new Set(list.map((e) => e.file).filter(Boolean));
  const codes = [...new Set(list.map((e) => e.code))];

  const byLine = new Map(ctx.body.map((l) => [l.n, l]));
  const evidence = list.slice(0, 4).map((e) => toEvidence(byLine.get(e.n)!));

  const hint = codes.map((c) => HINTS[c]).find(Boolean);
  const where = files.size ? ' in ' + plural(files.size, 'file') : '';
  const f: Finding = {
    id: 'typescript-compile-error',
    category: 'typescript',
    kind: 'root',
    title: redact('TypeScript compilation failed: ' + plural(list.length, 'error') + where),
    confidence: 'high',
    score: 84,
    evidence,
    occurrences: list.length,
    explanation:
      'The TypeScript compiler reported ' + list.length + ' error(s) (' + codes.slice(0, 5).join(', ') +
      (codes.length > 5 ? ', ...' : '') + '). ' +
      'The first error is usually the cause; later ones often cascade from it.' +
      (hint ? ' ' + hint : ''),
    suggestions: [
      'Reproduce locally: npx tsc --noEmit',
      'Fix the first reported error first, then re-run; many later errors disappear.',
      ...(codes.includes('TS2307') ? ['If the module is a dependency, run "npm ci" in the same working directory as CI.'] : []),
    ],
  };
  return [f];
};
