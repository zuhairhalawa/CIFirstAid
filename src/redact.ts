/**
 * Best-effort secret redaction for anything we print or emit as JSON.
 * GitHub already masks registered secrets as *** in logs, but tokens that were
 * never registered (or local logs from other CIs) can still leak into evidence.
 */
const PATTERNS: [RegExp, string][] = [
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '[REDACTED_GITHUB_TOKEN]'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '[REDACTED_GITHUB_TOKEN]'],
  [/\bnpm_[A-Za-z0-9]{30,}\b/g, '[REDACTED_NPM_TOKEN]'],
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, '[REDACTED_AWS_KEY]'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, '[REDACTED_SLACK_TOKEN]'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[REDACTED_JWT]'],
  [/(Bearer|Basic|token)\s+[A-Za-z0-9._~+/=-]{20,}/gi, '$1 [REDACTED]'],
  // user:password@host in URLs
  [/(:[/][/][^\s:/@]+:)[^\s@/]+(@)/g, '$1[REDACTED]$2'],
  [
    /((?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token)\s*[=:]\s*)(?!\*\*\*)[^\s'",;]{6,}/gi,
    '$1[REDACTED]',
  ],
];

export function redact(s: string): string {
  let out = s;
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
  return out;
}
