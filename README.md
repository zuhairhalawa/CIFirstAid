# CIFirstAid

**Evidence-first diagnosis of failed GitHub Actions runs.** Point it at a huge log (or a run ID) and get the most likely root cause, the exact log lines that prove it, and what to try next.

```text
$ ci-first-aid analyze failed.log        # abridged output from a real vercel/next.js failure

ROOT CAUSE [high confidence, test]
Jest: 2 tests failed
Evidence:
  L2619    * server-reference-tree-shaking > tree shakes dependencies of an unused export...
  L2621      expect(received).toBe(expected) // Object.is equality
  L2623      Expected: false
  L2624      Received: true
  L2932  Tests:       2 failed, 2 passed, 4 total
Why: The test runner reported failing tests. The assertion details above are the concrete cause...
Try:
  1. Run just the failing test locally to reproduce, e.g. npx jest <file>.
  ...
Also found (lower priority; may be consequences of the above):
  - [low] A step failed with exit code 1  (L2957)
```

## Why not just `gh run view --log-failed`?

`gh run view --log-failed` is great, and CIFirstAid uses the same credentials. But it **prints the log lines of failed steps**; you still have to read them. Its own help text also warns that logs cannot always be associated with steps (`UNKNOWN STEP`) and that its per-job fallback is slow.

The real cause of a CI failure is usually *not* the last line. GitHub's final annotation is typically `Process completed with exit code 1.`, and the actual error is hundreds of lines earlier. For example, in a real `cli/cli` run (kept as a test fixture) the last lines are:

```text
GraphQL: Something went wrong while executing your query ... 
##[error]Process completed with exit code 1.
```

CIFirstAid adds:

- **Root-cause ranking.** Specific signatures (`npm ci` lockfile drift, `TS2307`, `Resource not accessible by integration`...) outrank generic wrappers (`exit code 1`, `ELIFECYCLE`). Consequences are demoted.
- **Failure-window awareness.** Output printed by earlier, successful steps (retried network blips, harmless warnings) is demoted; lines near runner-flagged `##[error]` annotations are promoted.
- **Evidence with line numbers**, secrets redacted.
- **No-false-trail parsing.** Script source echoed by the runner (`echo "Permission denied"`), `##[warning]` lines and `env:` dumps never count as evidence.
- **Offline analysis** of any saved log; **read-only** API access for runs.
- **Machine-readable output** (`--json`).

## Install

```bash
npm install -g @zuhairhalawa/ci-first-aid
# or run without installing
npx @zuhairhalawa/ci-first-aid analyze failed.log
```

Requires Node.js 20 or newer. No runtime dependencies.

## Usage

### Analyze a log (fully offline)

```bash
ci-first-aid analyze path/to/failed.log
ci-first-aid analyze path/to/failed.log --json
some-command | ci-first-aid analyze -
```

Handles ordinary logs and GitHub Actions logs: `##[group]`/`##[error]` markers, 7-digit timestamps, ANSI escape codes, BOMs, CRLF/LF/bare-CR line endings, Docker BuildKit `#12 3.4` prefixes and UTF-16 files (e.g. produced by PowerShell `>` redirection). `analyze` never touches the network.

### Diagnose a run

```bash
ci-first-aid run 1234567890 --repo owner/repo
ci-first-aid run https://github.com/owner/repo/actions/runs/1234567890
ci-first-aid run 1234567890 --repo owner/repo --attempt 2 --json
```

| Option | Meaning |
| --- | --- |
| `-R, --repo [HOST/]OWNER/REPO` | Repository. Default: `GH_REPO`, else the `origin` git remote. |
| `--attempt N` | Re-run attempt to inspect (default: latest). |
| `--job ID` | Only diagnose one job. |
| `--max-jobs N` | Cap on failed jobs analyzed (default 10). |
| `--include-cancelled` | Also show cancelled jobs when other jobs failed. |
| `--hostname HOST` | GitHub Enterprise Server host (`GH_HOST` also works). |
| `--json`, `--no-color` | Output control. |

**Authentication:** `GH_TOKEN` / `GITHUB_TOKEN`, otherwise the token from your existing `gh auth login` (via `gh auth token`). The token needs read access to Actions (classic `repo` scope, or fine-grained *Actions: Read*).

**What it calls** (all `GET`): the run (`/actions/runs/{id}` or `/attempts/{n}`), its jobs (`/actions/runs/{id}/attempts/{n}/jobs`, paginated), each failed job's log (`/actions/jobs/{id}/logs`, which answers with a redirect to a signed storage URL that is followed *without* your token), and, only when a log is unavailable, check-run annotations. It never reruns, cancels, deletes or modifies anything; the client class has no non-GET code path and the test suite asserts it.

**Handled situations:** multiple failed jobs (analyzed concurrently, strongest cause summarized); re-run attempts; expired/deleted logs (falls back to annotations); `403`/`404`/`410` on logs; rate limits (reports the reset time); `401`; transient `5xx` (retried); network failures; runs still in progress; cancelled runs; runs that failed with **no jobs at all** (invalid workflow / startup failure; GitHub exposes no log for these, and the tool says so instead of guessing); very large logs (only the tail is kept past 64 MiB).

### Exit codes

| Code | Meaning |
| --- | --- |
| 0 | A diagnosis was produced (including "nothing found"). |
| 1 | Runtime problem: unreadable file, network, authentication, API error. |
| 2 | Usage error. |

## What it recognises

| Area | Examples |
| --- | --- |
| TypeScript | `error TS2322`, `TS2307`, config errors, grouped by file |
| npm / pnpm / yarn | `npm ci` lockfile drift, `ERESOLVE`, `ETARGET`, `E404`, `E401/E403`, `EINTEGRITY`, frozen-lockfile, engines mismatch, missing script, node-gyp builds |
| Node.js | module not found, ESM/CJS mismatch, OpenSSL 3 (`ERR_OSSL_EVP_UNSUPPORTED`), `EADDRINUSE`, `ENOENT`, unhandled rejections, uncaught errors with stacks |
| Tests | Jest, Vitest, Mocha, `node:test`/TAP failures with names and assertion details; "suite failed to run"; test timeouts; ESLint and Prettier |
| Python | tracebacks (deepest frame + exception), `ModuleNotFoundError`, pytest failures and collection errors, pip resolution/build failures |
| Missing tools / env | `command not found`, `not recognized`, `spawn x ENOENT`, missing environment variables, `unbound variable` |
| Permissions & auth | `Resource not accessible by integration`, OIDC `id-token`, git push denied, SSH, registry `denied`, 401/403, `Permission denied`, `EACCES`, dubious ownership |
| Actions configuration | unresolvable actions, invalid workflow expressions, missing required inputs, retired artifact actions, missing `action.yml`, artifact not found, missing checkout |
| Docker | failing `RUN` step (shows that step's last output), `COPY` source missing, Dockerfile problems, image pull failures, daemon unreachable, `exec format error` |
| Network | rate limits (GitHub API, Docker Hub, 429), DNS, TLS, resets/timeouts, connection refused to local services, upstream 5xx |
| Resources | job/step timeouts, cancellations (by user or concurrency), runner lost/shutdown, JS heap OOM, JVM/native OOM, `Killed`, disk full |
| Anything else | runner-flagged `##[error]` lines with their surrounding output; then the last error-like lines, clearly marked low confidence |

## JSON output

`--json` prints one document. `schemaVersion` is bumped on breaking changes.

```jsonc
{
  "schemaVersion": 1,
  "tool": { "name": "ci-first-aid", "version": "0.1.0" },
  "mode": "analyze",                       // or "run"
  "source": "failed.log",
  "diagnosis": {
    "summary": "TypeScript compilation failed: 2 errors in 2 files",
    "primary": {
      "id": "typescript-compile-error", "category": "typescript", "kind": "root",
      "title": "...", "confidence": "high", "score": 100,
      "evidence": [{ "line": 12, "text": "src/a.ts(10,5): error TS2322: ..." }],
      "occurrences": 2, "explanation": "...", "suggestions": ["..."]
    },
    "others": [],
    "stats": { "lines": 52, "ansiStripped": true, "timestamped": true, "githubFormat": true, "crlf": false, "errorAnnotations": 1, "truncated": false }
  }
}
```

`score` is an internal 0-100 ranking value used to order findings; it is **not** a probability. Use `confidence` (`high` / `medium` / `low`) to judge how much to trust a finding.

For `run`, the document has `run` with `jobs[]` (each with `failedSteps`, `logSource`, `notes` and a `diagnosis`) and an overall `primary`.

## Honest limitations

- Detection is pattern-based. Confidence reflects how specific the evidence is; `low` means "best lead", not "cause". If a failure type is unknown, you get the runner-flagged lines and surrounding output, not an invented answer.
- Evidence line numbers refer to the log as downloaded (including GitHub's setup lines).
- Logs are retained by GitHub for a limited time; expired logs fall back to annotations, which are much less detailed.
- Workflows that fail before any job starts have no log in the API.
- Redaction is best-effort pattern matching for common token formats on top of GitHub's own `***` masking.

## Development

```bash
npm ci
npm run typecheck
npm test
npm run build
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for how to add a detector.

## License

MIT
