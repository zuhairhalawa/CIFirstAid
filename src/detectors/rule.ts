import type { Category, Confidence, Evidence, Finding, LogLine, RuleKind } from '../types.js';
import { redact } from '../redact.js';

export interface DetectContext {
  /** Every normalized line. */
  lines: LogLine[];
  /** Lines that are real program output (no script echo, group markers or debug). */
  body: LogLine[];
}

export type Detector = (ctx: DetectContext) => Finding[];

type Dyn<T> = T | ((m: RegExpExecArray, line: LogLine) => T);

export interface PatternRule {
  id: string;
  category: Category;
  kind?: RuleKind;
  /** Base score 0-100. Specific, unambiguous signatures score higher. */
  score: number;
  confidence?: Confidence;
  /** Patterns must NOT use the g or y flags. */
  patterns: RegExp[];
  /** If a line matches any of these it is ignored (false-positive guard). */
  exclude?: RegExp[];
  title: Dyn<string>;
  explanation: Dyn<string>;
  suggestions: Dyn<string[]>;
  /** Extra non-echo lines to include after / before the primary match. */
  after?: number;
  before?: number;
  /** Only match lines the runner flagged at this level (e.g. ##[error]). */
  requireLevel?: 'error';
  /** Which occurrence is the primary one. Default: first. */
  pick?: 'first' | 'last';
  maxEvidence?: number;
}

const MAX_EVIDENCE_CHARS = 300;

export function toEvidence(line: LogLine): Evidence {
  let text = redact(line.text.trimEnd());
  if (text.length > MAX_EVIDENCE_CHARS) text = text.slice(0, MAX_EVIDENCE_CHARS - 3) + '...';
  return { line: line.n, text };
}

function resolve<T>(v: Dyn<T>, m: RegExpExecArray, line: LogLine): T {
  return typeof v === 'function' ? (v as (m: RegExpExecArray, l: LogLine) => T)(m, line) : v;
}

export function patternRule(rule: PatternRule): Detector {
  return (ctx) => {
    const hits: { idx: number; m: RegExpExecArray }[] = [];
    for (let i = 0; i < ctx.body.length; i++) {
      const line = ctx.body[i]!;
      if (line.text.length > 4000) continue; // minified blobs; avoid pathological regex cost
      if (rule.requireLevel && line.level !== rule.requireLevel) continue;
      if (rule.exclude?.some((x) => x.test(line.text))) continue;
      for (const p of rule.patterns) {
        const m = p.exec(line.text);
        if (m) {
          hits.push({ idx: i, m });
          break;
        }
      }
    }
    if (hits.length === 0) return [];
    const primary = rule.pick === 'last' ? hits[hits.length - 1]! : hits[0]!;
    const pLine = ctx.body[primary.idx]!;

    const chosen = new Map<number, LogLine>();
    const add = (l: LogLine | undefined) => {
      if (l && l.text.trim() !== '') chosen.set(l.n, l);
    };
    // Context lines must be genuinely adjacent in the original log (gaps of more than a
    // couple of lines mean we crossed a filtered region such as a group header).
    const MAX_GAP = 2;
    const ctxBefore: LogLine[] = [];
    for (let k = 1, prev = pLine.n; k <= (rule.before ?? 0); k++) {
      const l = ctx.body[primary.idx - k];
      if (!l || prev - l.n > MAX_GAP) break;
      ctxBefore.unshift(l);
      prev = l.n;
    }
    ctxBefore.forEach(add);
    add(pLine);
    for (let k = 1, prev = pLine.n; k <= (rule.after ?? 0); k++) {
      const l = ctx.body[primary.idx + k];
      if (!l || l.n - prev > MAX_GAP) break;
      add(l);
      prev = l.n;
    }
    const max = rule.maxEvidence ?? 3;
    // Additional distinct matching lines (the same message repeated adds nothing).
    const seen = new Set<string>([pLine.text.trim()]);
    for (const h of hits) {
      if (chosen.size >= max + (rule.before ?? 0) + (rule.after ?? 0)) break;
      const l = ctx.body[h.idx]!;
      if (seen.has(l.text.trim())) continue;
      seen.add(l.text.trim());
      add(l);
    }
    const evidence = [...chosen.values()].sort((a, b) => a.n - b.n).map(toEvidence);
    // Repeated identical lines (e.g. the line and its ##[error] annotation) count once.
    const occurrences = new Set(hits.map((h) => ctx.body[h.idx]!.text.trim())).size;

    const finding: Finding = {
      id: rule.id,
      category: rule.category,
      kind: rule.kind ?? 'root',
      title: redact(resolve(rule.title, primary.m, pLine)),
      confidence: rule.confidence ?? 'medium',
      score: rule.score,
      evidence,
      occurrences,
      explanation: resolve(rule.explanation, primary.m, pLine),
      suggestions: resolve(rule.suggestions, primary.m, pLine),
    };
    return [finding];
  };
}
