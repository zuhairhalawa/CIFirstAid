import { analyzeLog } from './analyze.js';
import { GitHubError, type GitHubClient, type RepoRef } from './github.js';
import type { Diagnosis, Finding } from './types.js';

interface ApiRun {
  id: number;
  name?: string | null;
  display_title?: string;
  status: string | null;
  conclusion: string | null;
  run_attempt?: number;
  html_url?: string;
  head_branch?: string | null;
  head_sha?: string;
  event?: string;
}

interface ApiStep {
  name: string;
  number: number;
  status: string;
  conclusion: string | null;
}

interface ApiJob {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  html_url?: string | null;
  run_attempt?: number;
  steps?: ApiStep[];
}

interface ApiAnnotation {
  annotation_level?: string;
  message?: string;
  title?: string | null;
  path?: string;
  start_line?: number;
}

export interface RunOptions {
  repo: RepoRef;
  runId: number;
  attempt?: number;
  jobId?: number;
  maxJobs?: number;
  includeCancelled?: boolean;
  maxLogBytes?: number;
  concurrency?: number;
}

export interface JobReport {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  url?: string;
  failedSteps: string[];
  logSource: 'job-log' | 'annotations' | 'none';
  logTruncated: boolean;
  diagnosis: Diagnosis | null;
  notes: string[];
}

export interface RunReport {
  repo: string;
  runId: number;
  attempt: number;
  latestAttempt: number;
  workflowName: string;
  title?: string;
  event?: string;
  branch?: string;
  sha?: string;
  status: string;
  conclusion: string | null;
  url?: string;
  jobs: JobReport[];
  notes: string[];
  summary: string;
  primary: { jobName: string; finding: Finding } | null;
}

const FAILED = new Set(['failure', 'timed_out', 'startup_failure']);

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return out;
}

async function listJobs(client: GitHubClient, base: string, runId: number, attempt: number): Promise<ApiJob[]> {
  const jobs: ApiJob[] = [];
  for (let page = 1; page <= 30; page++) {
    const res = await client.getJson<{ total_count: number; jobs: ApiJob[] }>(
      base + '/actions/runs/' + runId + '/attempts/' + attempt + '/jobs',
      'listing jobs of run ' + runId,
      { per_page: 100, page },
    );
    jobs.push(...res.jobs);
    if (res.jobs.length < 100 || jobs.length >= res.total_count) break;
  }
  return jobs;
}

function annotationsToLog(anns: ApiAnnotation[]): string {
  return anns
    .filter((a) => a.annotation_level === 'failure' || a.annotation_level === 'error' || !a.annotation_level)
    .map((a) => {
      const where = a.path ? a.path + (a.start_line ? ':' + a.start_line : '') + ' ' : '';
      return '##[error]' + where + String(a.message ?? a.title ?? '').split('\n').join(' ');
    })
    .join('\n');
}

export async function diagnoseRun(client: GitHubClient, opts: RunOptions): Promise<RunReport> {
  const { repo, runId } = opts;
  const base = '/repos/' + repo.owner + '/' + repo.repo;
  const notes: string[] = [];

  const runPath = base + '/actions/runs/' + runId + (opts.attempt ? '/attempts/' + opts.attempt : '');
  const run = await client.getJson<ApiRun>(runPath, 'fetching run ' + runId);
  const attempt = opts.attempt ?? run.run_attempt ?? 1;
  const latest = run.run_attempt ?? attempt;

  if (run.status !== 'completed') {
    notes.push('The run is still "' + run.status + '": only jobs that have already finished can be diagnosed, and logs of running jobs may be incomplete.');
  }
  if (attempt > 1 && !opts.attempt) {
    notes.push('This is re-run attempt ' + attempt + '. Earlier attempts can be inspected with --attempt N.');
  }
  if (opts.attempt && opts.attempt < latest) {
    notes.push('Showing attempt ' + opts.attempt + ' of ' + latest + '.');
  }

  let jobs = await listJobs(client, base, runId, attempt);
  if (opts.jobId !== undefined) {
    jobs = jobs.filter((j) => j.id === opts.jobId);
    if (jobs.length === 0) notes.push('Job ' + opts.jobId + ' was not found in attempt ' + attempt + ' of this run.');
  }

  const report: RunReport = {
    repo: repo.owner + '/' + repo.repo,
    runId,
    attempt,
    latestAttempt: latest,
    workflowName: run.name ?? 'workflow',
    status: run.status ?? 'unknown',
    conclusion: run.conclusion,
    jobs: [],
    notes,
    summary: '',
    primary: null,
  };
  if (run.display_title) report.title = run.display_title;
  if (run.event) report.event = run.event;
  if (run.head_branch) report.branch = run.head_branch;
  if (run.head_sha) report.sha = run.head_sha;
  if (run.html_url) report.url = run.html_url;

  if (jobs.length === 0 && opts.jobId === undefined) {
    if (run.conclusion === 'failure' || run.conclusion === 'startup_failure') {
      notes.push(
        'The run failed but has no jobs. This happens when the workflow never started: an invalid workflow file, a startup failure (policy, billing or permission limits), or a failed reusable-workflow call. GitHub exposes no log for this through the API: open the run page for the annotation' +
          (run.html_url ? ': ' + run.html_url : '.'),
      );
      report.summary = 'The run failed before any job started (no logs exist).';
    } else {
      report.summary = 'The run has no jobs yet.';
    }
    return report;
  }

  const failed = jobs.filter((j) => j.conclusion !== null && FAILED.has(j.conclusion));
  let selected = failed;
  if (opts.jobId !== undefined) selected = jobs;
  else if (failed.length === 0) {
    const cancelled = jobs.filter((j) => j.conclusion === 'cancelled');
    if (cancelled.length > 0 && (run.conclusion === 'cancelled' || opts.includeCancelled)) {
      selected = cancelled;
      notes.push('No job failed; showing the cancelled jobs.');
    } else if (cancelled.length > 0) {
      notes.push(cancelled.length + ' job(s) were cancelled but none failed.');
    }
  }
  const running = jobs.filter((j) => j.status !== 'completed');
  if (running.length > 0 && run.status !== 'completed') {
    notes.push(running.length + ' job(s) have not finished: ' + running.slice(0, 5).map((j) => j.name).join(', ') + '.');
  }

  if (selected.length === 0) {
    report.summary =
      run.conclusion === 'success'
        ? 'The run succeeded; there is nothing to diagnose.'
        : 'No failed jobs were found (run conclusion: ' + (run.conclusion ?? run.status) + ').';
    return report;
  }

  const max = opts.maxJobs ?? 10;
  if (selected.length > max) {
    notes.push(selected.length + ' jobs failed; only the first ' + max + ' were analyzed (raise --max-jobs).');
    selected = selected.slice(0, max);
  }

  let fatal: GitHubError | undefined;
  report.jobs = await mapLimit(selected, opts.concurrency ?? 3, async (job): Promise<JobReport> => {
    const jr: JobReport = {
      id: job.id,
      name: job.name,
      status: job.status,
      conclusion: job.conclusion,
      failedSteps: (job.steps ?? []).filter((s) => s.conclusion !== null && FAILED.has(s.conclusion)).map((s) => s.name),
      logSource: 'none',
      logTruncated: false,
      diagnosis: null,
      notes: [],
    };
    if (job.html_url) jr.url = job.html_url;
    if (fatal) return jr;

    let text: string | undefined;
    try {
      const log = await client.getJobLog(base + '/actions/jobs/' + job.id + '/logs', 'downloading the log of job ' + job.id, opts.maxLogBytes);
      text = log.text;
      jr.logSource = 'job-log';
      jr.logTruncated = log.truncated;
      if (log.truncated) jr.notes.push('The log was very large; only its last part was analyzed.');
    } catch (e) {
      if (e instanceof GitHubError && (e.kind === 'auth' || e.kind === 'rate-limit' || e.kind === 'network')) {
        fatal = e;
        return jr;
      }
      const why = e instanceof GitHubError ? e.message + (e.hint ? ' ' + e.hint : '') : String(e);
      jr.notes.push('The job log is unavailable (' + why + ') Falling back to check-run annotations.');
    }

    if (text === undefined) {
      try {
        const anns = await client.getJson<ApiAnnotation[]>(base + '/check-runs/' + job.id + '/annotations', 'fetching annotations of job ' + job.id, { per_page: 50 });
        const synth = annotationsToLog(anns);
        if (synth) {
          text = synth;
          jr.logSource = 'annotations';
          jr.notes.push('Diagnosis is based on annotations only, so it is less detailed than a full log.');
        } else {
          jr.notes.push('No annotations are available either: open the job page.');
        }
      } catch (e) {
        if (e instanceof GitHubError && (e.kind === 'auth' || e.kind === 'rate-limit' || e.kind === 'network')) {
          fatal = e;
          return jr;
        }
        jr.notes.push('Annotations could not be fetched' + (e instanceof GitHubError ? ': ' + e.message : '.'));
      }
    }
    if (text !== undefined) jr.diagnosis = analyzeLog(text);
    return jr;
  });
  if (fatal) throw fatal;

  let best: { jobName: string; finding: Finding } | null = null;
  for (const j of report.jobs) {
    const p = j.diagnosis?.primary;
    if (p && (!best || p.score > best.finding.score)) best = { jobName: j.name, finding: p };
  }
  report.primary = best;
  report.summary = best
    ? (report.jobs.length > 1 ? best.jobName + ': ' : '') + best.finding.title
    : 'Failed jobs were found but no diagnosis could be produced (logs unavailable).';
  return report;
}
