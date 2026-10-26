import { normalizeLog } from './normalize.js';
import { ALL_DETECTORS } from './detectors/index.js';
import { toEvidence, type DetectContext } from './detectors/rule.js';
import type { Confidence, Diagnosis, Finding, LogLine } from './types.js';

export interface AnalyzeOptions {
  /** Maximum number of secondary findings reported. Default 5. */
  maxOthers?: number;
}

const CONF_RANK: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };

// Score adjustments (see rankFindings).
const SYMPTOM_PENALTY = 35;
const IN_WINDOW_BONUS = 12;
const OUT_OF_WINDOW_PENALTY = 30;
const NEAR_ANCHOR_BONUS = 15;
const WEAK_UNANCHORED_PENALTY = 15;
const WEAK_BASE_SCORE = 65;
const ANCHOR_DISTANCE = 8;
const MIN_OTHER_SCORE = 25;

// "\w*error" also catches class names such as FooError / SyntaxError / ValueError.
const ERRORISH_RE = /(?:\b(?:\w*error|\w*exception|errors|failed|failure|fatal|panic|denied|cannot|can't|unable to|not found|invalid|refused|aborted|traceback)\b)/i;
const NOT_ERROR_RE = /(?:\b0 (?:errors?|failed|failures?)\b|\bno errors?\b|0 failing|Process completed with exit code|^##\[)/i;
/** Runner annotations that only restate an exit status: they carry no cause. */
const WRAPPER_ANNOTATION_RE = /^(?:Process completed with exit code \d+|The process '.*' failed with exit code \d+)/;

/** Line number where the step that raised the last ##[error] annotation begins. */
function failureWindowStart(lines: LogLine[]): number | undefined {
  let lastErr = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i]!.level === 'error') {
      lastErr = i;
      break;
    }
  }
  if (lastErr < 0) return undefined;
  for (let i = lastErr; i >= 0; i--) {
    if (/^##\[group\]Run /.test(lines[i]!.text)) return lines[i]!.n;
  }
  return lines[0]?.n;
}

/** Sorted line numbers of runner-flagged errors that say more than "exit code N". */
function anchorLines(lines: LogLine[]): number[] {
  return lines.filter((l) => l.level === 'error' && !WRAPPER_ANNOTATION_RE.test(l.text) && l.text.trim() !== '').map((l) => l.n);
}

function nearAnchor(anchors: number[], line: number): boolean {
  let lo = 0;
  let hi = anchors.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const v = anchors[mid]!;
    if (Math.abs(v - line) <= ANCHOR_DISTANCE) return true;
    if (v < line) lo = mid + 1;
    else hi = mid - 1;
  }
  return false;
}

function derivedConfidence(f: Finding): Confidence {
  const byScore: Confidence = f.score >= 80 ? 'high' : f.score >= 55 ? 'medium' : 'low';
  return CONF_RANK[byScore] <= CONF_RANK[f.confidence] ? byScore : f.confidence;
}

/**
 * The runner (or the tool, via ::error::) explicitly flagged these lines as errors, so they are
 * worth showing even when no named signature matches, together with the output around them.
 */
function annotatedErrorsFinding(ctx: DetectContext, windowStart: number | undefined): Finding | null {
  const inScope = (l: LogLine) => windowStart === undefined || l.n >= windowStart;
  const first = ctx.body.findIndex((l) => l.level === 'error' && !WRAPPER_ANNOTATION_RE.test(l.text) && inScope(l));
  if (first < 0) return null;
  const MAX_GAP = 2;
  const picked: LogLine[] = [ctx.body[first]!];
  for (let k = 1, prev = picked[0]!.n; k <= 3; k++) {
    const l = ctx.body[first - k];
    if (!l || prev - l.n > MAX_GAP) break;
    picked.unshift(l);
    prev = l.n;
  }
  for (let k = 1, prev = ctx.body[first]!.n; k <= 6; k++) {
    const l = ctx.body[first + k];
    if (!l || l.n - prev > MAX_GAP) break;
    if (!WRAPPER_ANNOTATION_RE.test(l.text)) picked.push(l);
    prev = l.n;
  }
  const head = ctx.body[first]!;
  const total = ctx.body.filter((l) => l.level === 'error' && !WRAPPER_ANNOTATION_RE.test(l.text) && inScope(l)).length;
  return {
    id: 'annotated-errors',
    category: 'unknown',
    kind: 'root',
    title: 'The failing step reported: ' + head.text.slice(0, 120),
    confidence: 'medium',
    score: 62,
    evidence: picked.map(toEvidence),
    occurrences: total,
    explanation:
      'No built-in pattern recognised this failure, but the runner flagged these lines as errors, and the surrounding output is shown with them. This is the best lead, not a confirmed root cause.',
    suggestions: ['Read the flagged line together with the output just before and after it.', 'Reproduce the failing command locally with the same inputs.'],
  };
}

function fallbackFinding(ctx: DetectContext, windowStart: number | undefined): Finding | null {
  const pool = windowStart !== undefined ? ctx.body.filter((l) => l.n >= windowStart) : ctx.body;
  const hits = pool.filter((l) => ERRORISH_RE.test(l.text) && !NOT_ERROR_RE.test(l.text) && l.text.length < 400);
  const chosen: LogLine[] = [];
  const seen = new Set<string>();
  for (let i = hits.length - 1; i >= 0 && chosen.length < 4; i--) {
    const l = hits[i]!;
    const key = l.text.trim();
    if (seen.has(key)) continue;
    seen.add(key);
    chosen.unshift(l);
  }
  if (chosen.length === 0) return null;
  return {
    id: 'unclassified-errors',
    category: 'unknown',
    kind: 'root',
    title: 'Failure detected, but no known signature matched: last error-like output shown',
    confidence: 'low',
    score: 20,
    evidence: chosen.map(toEvidence),
    occurrences: hits.length,
    explanation:
      'No built-in pattern recognised this failure. These are the last lines that look like errors, which are the best starting point; they are not a confirmed root cause.',
    suggestions: ['Read these lines in context in the full log, working backwards from the first one.', 'If this failure type is common, a detector can be added (see CONTRIBUTING).'],
  };
}

/**
 * Adjusts raw rule scores using where the evidence sits relative to the failure:
 *  - inside the failing step vs. earlier output (earlier noise is demoted),
 *  - near a runner-flagged error line (promoted),
 *  - weak generic signatures far from any flagged error are demoted,
 *  - consequences of another failure (symptoms) are demoted.
 */
function rankFindings(findings: Finding[], lines: LogLine[], windowStart: number | undefined, anchors: number[]): void {
  const total = Math.max(lines.length, 1);
  for (const f of findings) {
    const line = f.evidence[0]?.line ?? 0;
    const base = f.score;
    let s = base;
    if (f.kind === 'symptom') s -= SYMPTOM_PENALTY;
    if (windowStart !== undefined) s += line >= windowStart ? IN_WINDOW_BONUS : -OUT_OF_WINDOW_PENALTY;
    if (anchors.length > 0 && f.kind !== 'wrapper') {
      const near = f.evidence.some((e) => nearAnchor(anchors, e.line));
      if (near) s += NEAR_ANCHOR_BONUS;
      else if (base < WEAK_BASE_SCORE && f.kind === 'root') s -= WEAK_UNANCHORED_PENALTY;
    }
    s += Math.round((6 * line) / total);
    f.score = Math.max(0, Math.min(100, s));
  }
}

export function analyzeLog(input: string, opts: AnalyzeOptions = {}): Diagnosis {
  const { lines, stats } = normalizeLog(input);
  const body = lines.filter((l) => !l.echo && l.level !== 'warning' && l.level !== 'notice' && l.text.trim() !== '');
  const ctx: DetectContext = { lines, body };

  let findings: Finding[] = [];
  for (const d of ALL_DETECTORS) {
    try {
      findings.push(...d(ctx));
    } catch {
      // A broken detector must never take the whole diagnosis down.
    }
  }

  const windowStart = failureWindowStart(lines);
  const anchors = anchorLines(lines);
  const annotated = annotatedErrorsFinding(ctx, windowStart);
  if (annotated) findings.push(annotated);
  rankFindings(findings, lines, windowStart, anchors);

  // Drop lower-scoring findings that point at exactly the same evidence within one category.
  findings.sort((a, b) => b.score - a.score);
  const kept: Finding[] = [];
  for (const f of findings) {
    const evLines = new Set(f.evidence.map((e) => e.line));
    const dup = kept.some((k) => k.category === f.category && k.evidence.some((e) => evLines.has(e.line)));
    if (!dup) kept.push(f);
  }
  findings = kept;

  // When the best we have is a bare exit-code line, prefer concrete error-like output near the end.
  const best = findings[0];
  if (!best || best.kind === 'wrapper' || best.score < 40) {
    const fb = fallbackFinding(ctx, windowStart);
    if (fb) {
      fb.score = (best?.score ?? 0) + 5;
      findings.unshift(fb);
    }
  }

  for (const f of findings) f.confidence = derivedConfidence(f);

  const firstRoot = findings.find((f) => f.kind === 'root' && f.score >= 40);
  const primary = firstRoot ?? findings[0] ?? null;
  const others = findings
    .filter((f) => f !== primary && f.score >= MIN_OTHER_SCORE)
    .slice(0, opts.maxOthers ?? 5);
  for (const o of others) o.secondary = true;

  return {
    summary: primary ? primary.title : 'No failure signature found in this log',
    primary,
    others,
    stats,
  };
}
