import type { Diagnosis, Finding } from './types.js';
import type { JobReport, RunReport } from './run.js';
import { redact } from './redact.js';

export const SCHEMA_VERSION = 1;

const ESC = String.fromCharCode(27);

export interface RenderOptions {
  color: boolean;
}

function paint(on: boolean, code: string, s: string): string {
  return on ? ESC + '[' + code + 'm' + s + ESC + '[0m' : s;
}

function confColor(c: Finding['confidence']): string {
  return c === 'high' ? '32' : c === 'medium' ? '33' : '31';
}

function renderFinding(f: Finding, o: RenderOptions, indent = ''): string[] {
  const out: string[] = [];
  const width = String(Math.max(...f.evidence.map((e) => e.line), 0)).length;
  out.push(indent + paint(o.color, '1', f.title));
  if (f.evidence.length > 0) {
    out.push(indent + paint(o.color, '2', 'Evidence:'));
    for (const e of f.evidence) {
      out.push(indent + '  ' + paint(o.color, '2', 'L' + String(e.line).padStart(width, ' ')) + '  ' + e.text);
    }
  }
  out.push(indent + paint(o.color, '2', 'Why:') + ' ' + f.explanation);
  if (f.suggestions.length > 0) {
    out.push(indent + paint(o.color, '2', 'Try:'));
    f.suggestions.forEach((s, i) => out.push(indent + '  ' + (i + 1) + '. ' + s));
  }
  return out;
}

export function renderDiagnosisBlock(d: Diagnosis, o: RenderOptions, indent = ''): string[] {
  const out: string[] = [];
  if (!d.primary) {
    out.push(indent + 'No known failure signature was found in this log.');
    out.push(indent + 'If the log is from a failed run, it may be truncated, or the failure is of a kind this tool does not know yet.');
    return out;
  }
  const p = d.primary;
  out.push(
    indent + paint(o.color, confColor(p.confidence), 'ROOT CAUSE') + ' [' + p.confidence + ' confidence, ' + p.category + ']',
  );
  out.push(...renderFinding(p, o, indent));
  if (d.others.length > 0) {
    out.push('');
    out.push(indent + paint(o.color, '1', 'Also found') + ' (lower priority; may be consequences of the above):');
    for (const f of d.others) {
      const first = f.evidence[0];
      out.push(indent + '  - [' + f.confidence + '] ' + f.title + (first ? '  (L' + first.line + ')' : ''));
    }
  }
  return out;
}

function statsLine(d: Diagnosis): string {
  const s = d.stats;
  const bits = [s.lines.toLocaleString('en-US') + ' lines'];
  if (s.githubFormat) bits.push('GitHub Actions format');
  if (s.timestamped) bits.push('timestamps removed');
  if (s.ansiStripped) bits.push('ANSI stripped');
  if (s.errorAnnotations > 0) bits.push(s.errorAnnotations + ' error annotation(s)');
  if (s.truncated) bits.push('input truncated');
  return bits.join(' | ');
}

export function renderLocalText(d: Diagnosis, source: string, o: RenderOptions): string {
  const out: string[] = [];
  out.push(paint(o.color, '1', 'CIFirstAid') + ' - ' + source);
  out.push('');
  out.push(...renderDiagnosisBlock(d, o));
  out.push('');
  out.push(paint(o.color, '2', 'Log: ' + statsLine(d)));
  return out.join('\n') + '\n';
}

function renderJob(j: JobReport, o: RenderOptions): string[] {
  const out: string[] = [];
  out.push(paint(o.color, '1', 'Job: ' + j.name) + ' (' + (j.conclusion ?? j.status) + ')' + (j.url ? '  ' + j.url : ''));
  if (j.failedSteps.length > 0) out.push('Failed step: ' + j.failedSteps.join(', '));
  for (const n of j.notes) out.push(paint(o.color, '33', 'Note: ') + n);
  out.push('');
  if (j.diagnosis) out.push(...renderDiagnosisBlock(j.diagnosis, o, '  '));
  else out.push('  No diagnosis available for this job.');
  return out;
}

export function renderRunText(r: RunReport, o: RenderOptions): string {
  const out: string[] = [];
  out.push(paint(o.color, '1', 'CIFirstAid') + ' - ' + r.repo + ' run ' + r.runId + ' (attempt ' + r.attempt + ')');
  out.push(r.workflowName + (r.title ? ': ' + r.title : '') + ' | ' + (r.conclusion ?? r.status) + (r.branch ? ' | ' + r.branch : '') + (r.sha ? ' @ ' + r.sha.slice(0, 7) : ''));
  if (r.url) out.push(r.url);
  for (const n of r.notes) out.push(paint(o.color, '33', 'Note: ') + n);
  out.push('');
  out.push(paint(o.color, '1', 'Summary: ') + r.summary);
  for (const j of r.jobs) {
    out.push('');
    out.push('-'.repeat(60));
    out.push(...renderJob(j, o));
  }
  return out.join('\n') + '\n';
}

function cleanFinding(f: Finding): Finding {
  return { ...f, title: redact(f.title), evidence: f.evidence.map((e) => ({ line: e.line, text: redact(e.text) })) };
}

function cleanDiagnosis(d: Diagnosis): Diagnosis {
  return { ...d, summary: redact(d.summary), primary: d.primary ? cleanFinding(d.primary) : null, others: d.others.map(cleanFinding) };
}

export function localJson(d: Diagnosis, source: string, version: string): string {
  return JSON.stringify({ schemaVersion: SCHEMA_VERSION, tool: { name: 'ci-first-aid', version }, mode: 'analyze', source, diagnosis: cleanDiagnosis(d) }, null, 2) + '\n';
}

export function runJson(r: RunReport, version: string): string {
  const jobs = r.jobs.map((j) => ({ ...j, diagnosis: j.diagnosis ? cleanDiagnosis(j.diagnosis) : null }));
  const primary = r.primary ? { jobName: r.primary.jobName, finding: cleanFinding(r.primary.finding) } : null;
  return JSON.stringify({ schemaVersion: SCHEMA_VERSION, tool: { name: 'ci-first-aid', version }, mode: 'run', run: { ...r, jobs, primary } }, null, 2) + '\n';
}
