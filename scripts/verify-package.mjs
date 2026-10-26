#!/usr/bin/env node
// Verifies the artifact users actually receive: packs the project, checks the tarball
// contents, installs it into a throwaway project outside the repository, and runs the
// installed `ci-first-aid` executable (the .cmd shim on Windows, the symlink elsewhere).
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(fileURLToPath(new URL('..', import.meta.url)));
const isWin = process.platform === 'win32';
const tmp = mkdtempSync(join(tmpdir(), 'cifa-verify-'));
const proj = join(tmp, 'proj');
let failures = 0;

const q = (s) => '"' + String(s).replace(/"/g, '\\"') + '"';

function sh(cmd, cwd) {
  const r = spawnSync(cmd, { shell: true, cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function check(name, ok, detail) {
  if (!ok) failures++;
  console.log((ok ? 'PASS' : 'FAIL') + ' | ' + name + (detail ? ' | ' + detail : ''));
}

try {
  // 1. Pack and inspect the tarball.
  const pack = sh('npm pack --json --pack-destination ' + q(tmp), repo);
  if (pack.status !== 0) throw new Error('npm pack failed: ' + pack.stderr);
  const info = JSON.parse(pack.stdout)[0];
  const paths = info.files.map((f) => f.path);
  console.log('Tarball: ' + info.filename + ' (' + paths.length + ' files, ' + info.size + ' bytes)');
  const allowed = (p) => p === 'package.json' || p === 'README.md' || p === 'LICENSE' || p.startsWith('dist/');
  check('tarball contains only dist/, README, LICENSE, package.json', paths.every(allowed), paths.filter((p) => !allowed(p)).join(', '));
  check('tarball has no source maps', !paths.some((p) => p.endsWith('.map')));
  check('tarball has no test fixtures or sources', !paths.some((p) => /^(test|src|scripts|\.github)\//.test(p) || p.endsWith('.log')));
  check('tarball has the CLI entry', paths.includes('dist/cli.js'));

  // 2. Install into a fresh project outside the repository.
  mkdirSync(proj);
  writeFileSync(join(proj, 'package.json'), JSON.stringify({ name: 'verify', version: '1.0.0', private: true }));
  const inst = sh('npm install ' + q(join(tmp, info.filename)) + ' --no-audit --no-fund', proj);
  check('npm install of the tarball succeeds', inst.status === 0, inst.status === 0 ? '' : inst.stderr);
  if (inst.status !== 0) throw new Error('install failed');

  // 3. Run the installed executable.
  const bin = join(proj, 'node_modules', '.bin', isWin ? 'ci-first-aid.cmd' : 'ci-first-aid');
  const expectedVersion = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).version;
  const failedLog = join(tmp, 'failed.log');
  const cleanLog = join(tmp, 'clean.log');
  writeFileSync(
    failedLog,
    [
      '2026-10-27T10:00:00.0000000Z ##[group]Run npm run build',
      "2026-10-27T10:00:00.1000000Z src/a.ts(10,5): error TS2322: Type 'string' is not assignable to type 'number'.",
      "2026-10-27T10:00:00.2000000Z src/b.ts(3,1): error TS2307: Cannot find module './nope' or its corresponding type declarations.",
      '2026-10-27T10:00:00.3000000Z ##[error]Process completed with exit code 2.',
      '',
    ].join('\n'),
  );
  writeFileSync(cleanLog, '2026-10-27T10:00:00.0000000Z hello\n2026-10-27T10:00:01.0000000Z all good\n');

  const run = (args) => sh(q(bin) + ' ' + args.map(q).join(' '), proj);
  let r = run(['--version']);
  check('--version prints ' + expectedVersion + ', exit 0', r.status === 0 && r.stdout.trim() === expectedVersion, 'exit=' + r.status + ' out=' + JSON.stringify(r.stdout.trim()));
  r = run(['--help']);
  check('--help exit 0', r.status === 0 && r.stdout.includes('ci-first-aid analyze'), 'exit=' + r.status);
  r = run(['analyze', failedLog]);
  check('analyze finds the TypeScript root cause, exit 0', r.status === 0 && r.stdout.includes('ROOT CAUSE') && r.stdout.includes('TS2307'), 'exit=' + r.status);
  r = run(['analyze', failedLog, '--json']);
  let doc;
  try {
    doc = JSON.parse(r.stdout);
  } catch {
    doc = null;
  }
  check(
    'analyze --json emits valid, stable JSON, exit 0',
    r.status === 0 &&
      doc !== null &&
      doc.schemaVersion === 1 &&
      doc.tool.name === 'ci-first-aid' &&
      doc.tool.version === expectedVersion &&
      doc.diagnosis.primary.id === 'typescript-compile-error' &&
      doc.diagnosis.primary.evidence[0].line === 2,
    'exit=' + r.status,
  );
  r = run(['analyze', cleanLog]);
  check('analyze of a log with no failure says so, exit 0', r.status === 0 && /No known failure signature/.test(r.stdout), 'exit=' + r.status);
  r = run(['analyze', join(tmp, 'does-not-exist.log')]);
  check('missing file exits 1', r.status === 1 && /Cannot read/.test(r.stderr), 'exit=' + r.status);
  r = run([]);
  check('no command exits 2', r.status === 2, 'exit=' + r.status);
  r = run(['frobnicate']);
  check('unknown command exits 2', r.status === 2 && /Unknown command/.test(r.stderr), 'exit=' + r.status);
  r = run(['run', 'not-a-number']);
  check('invalid run id exits 2', r.status === 2, 'exit=' + r.status);
} catch (e) {
  failures++;
  console.log('FAIL | ' + (e instanceof Error ? e.message : String(e)));
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(failures === 0 ? 'PACKAGE VERIFICATION PASSED' : 'PACKAGE VERIFICATION FAILED (' + failures + ')');
process.exitCode = failures === 0 ? 0 : 1;
