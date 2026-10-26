export type Confidence = 'high' | 'medium' | 'low';

export type Category =
  | 'typescript'
  | 'npm'
  | 'node'
  | 'test'
  | 'lint'
  | 'python'
  | 'missing-executable'
  | 'missing-env'
  | 'permission'
  | 'actions-config'
  | 'docker'
  | 'network'
  | 'rate-limit'
  | 'timeout'
  | 'cancelled'
  | 'out-of-memory'
  | 'disk'
  | 'unknown';

/** How a rule relates to the underlying cause. */
export type RuleKind =
  | 'root' // directly names the cause
  | 'symptom' // consequence of something else (e.g. ELIFECYCLE after a test failure)
  | 'wrapper'; // generic exit-code style line; only used when nothing better exists

export interface LogLine {
  /** 1-based line number in the original input. */
  n: number;
  /** Cleaned text: no ANSI, no timestamp, no BOM, no trailing CR. */
  text: string;
  /** Original line with only the trailing line ending removed. */
  raw: string;
  /** ISO timestamp prefix if present. */
  timestamp?: string;
  /** Name of the enclosing ##[group], if any. */
  group?: string;
  /** Workflow-command severity (##[error] / ##[warning] / ::error::). */
  level?: 'error' | 'warning' | 'notice';
  /** True for lines that are a command echo or runner metadata, not program output. */
  echo?: boolean;
  /** Docker BuildKit step id when the line was prefixed like "#12 5.2 ...". */
  buildkit?: string;
}

export interface Evidence {
  line: number;
  text: string;
}

export interface Finding {
  id: string;
  category: Category;
  kind: RuleKind;
  title: string;
  confidence: Confidence;
  /** Ranking score, higher is more likely the root cause. */
  score: number;
  evidence: Evidence[];
  /** Number of matching occurrences, when aggregated. */
  occurrences: number;
  explanation: string;
  suggestions: string[];
  /** True if this finding is a consequence of another finding in the same log. */
  secondary?: boolean;
}

export interface Diagnosis {
  summary: string;
  primary: Finding | null;
  others: Finding[];
  stats: LogStats;
}

export interface LogStats {
  lines: number;
  ansiStripped: boolean;
  timestamped: boolean;
  githubFormat: boolean;
  crlf: boolean;
  errorAnnotations: number;
  truncated: boolean;
}
