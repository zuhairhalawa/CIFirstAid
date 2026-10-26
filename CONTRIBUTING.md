# Contributing

## Setup

```bash
npm ci
npm test
```

Node.js 20+.

## Adding a detector

1. Find a **real** log that shows the failure. Trim it to the relevant excerpt (keep the `##[group]Run ...` line and the final `##[error]` annotation so the failure window works) and save it under `test/fixtures/`. Strip anything private. Fixtures are stored byte-for-byte (`*.log -text` in `.gitattributes`).
2. Add a rule to the matching file in `src/detectors/`:
   - Single-signature failures: `patternRule({ id, category, score, patterns, title, explanation, suggestions })`.
   - Failures that need aggregation or structure (counts, stack frames, test names): write a `Detector` function (see `typescript.ts`, `tests.ts`, `python.ts`).
3. Register it in `src/detectors/index.ts` if you wrote a new export.
4. Add a test: the rule must pick the right `id` for a realistic log **and** you should add a negative test if the signature could appear in harmless output.

### Scoring guidance

- 85-95: an unambiguous signature that names the cause (`Resource not accessible by integration`).
- 65-84: strong but could be a consequence or have several causes.
- below 65: generic signatures (any `Error:` with a stack). These are demoted unless they sit next to a runner-flagged error.
- Use `kind: 'symptom'` for lines that only restate another failure (`ELIFECYCLE`) and `kind: 'wrapper'` for bare exit-code lines.
- `requireLevel: 'error'` restricts a rule to lines the runner marked `##[error]`; use it when the same text is a harmless warning elsewhere.

### Pitfalls

- Patterns run against output only: script echo, `##[group]`, `##[debug]`, `##[warning]` and `env:` dumps are removed first.
- Never use the `g` or `y` flag on a rule pattern.
- Avoid catastrophic backtracking; lines over 4000 characters are skipped, but keep patterns linear anyway.
- `[]]` in a JavaScript regex is an empty class, not a class containing `]`.

## Principles

- **Evidence first.** Every finding must show the log lines that justify it. No evidence, no finding.
- **Never claim more than the log shows.** Prefer a low-confidence "best lead" over a confident guess.
- **Read-only.** The GitHub client must stay GET-only.
