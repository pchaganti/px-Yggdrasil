import { describe, it, expect } from 'vitest';
import { spawnSync, execSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  rmSync,
  cpSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  mkdirSync,
  symlinkSync,
  linkSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'e2e-lifecycle');

const distExists = existsSync(BIN_PATH);

// ---------------------------------------------------------------------------
// HERMETICITY
//
// Every scenario here is LLM-independent and network-free. The approve/check
// cases run on `deterministicFixture` (the LLM aspect `has-doc-comment` is
// stripped from the service type, so `yg approve` records only deterministic
// verdicts and never contacts a reviewer endpoint). The log add/read and
// merge-resolve cases never invoke the reviewer at all. No real host/port is
// dialed; no wall clock or random source is read in assertions (log-entry
// timestamps are produced by the binary and read back, never compared to the
// current time). Each test works inside a fresh mkdtemp dir and removes it in
// a finally block; the committed fixture bytes are never mutated.
//
// SCOPE — this suite covers the REMAINING log-domain error paths NOT already
// asserted by cli-log-integrity.test.ts. Cases SKIPPED here because they are
// already covered there:
//   - mandatory-log gate refusal + the log-add-then-approve pass that clears it
//   - level-2 heading in a --reason rejected / level-3 accepted
//   - log read --top 2 (newest-first bound) and --top 0 (non-positive reject)
//   - merge-resolve happy path, non-merge HEAD, tampered ancestor prefix
// cli-lifecycle.test.ts additionally covers the basic log add / read / read
// --all / read --top 1 / reason-file happy path / missing --node / missing
// --reason / nonexistent-node smoke cases — not duplicated here.
// ---------------------------------------------------------------------------

function run(
  args: string[],
  cwd: string,
): {
  stdout: string;
  stderr: string;
  status: number | null;
  all: string;
} {
  const result = spawnSync('node', [BIN_PATH, ...args], {
    cwd,
    encoding: 'utf-8',
  });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  return { stdout, stderr, status: result.status, all: stdout + stderr };
}

/** Copy the e2e-lifecycle fixture into a fresh temp dir for mutation. */
function copyFixture(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-logintx-${label}-`));
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

/**
 * Copy the fixture and strip the LLM aspect (`has-doc-comment`) so the node's
 * effective aspects are purely deterministic. This makes the approve/check
 * lifecycle hermetic: no network, no LLM verdict, fully reproducible.
 */
function deterministicFixture(label: string): string {
  const dir = copyFixture(label);
  const archPath = path.join(dir, '.yggdrasil', 'yg-architecture.yaml');
  const arch = readFileSync(archPath, 'utf-8')
    .split('\n')
    .filter((line) => line.trim() !== '- has-doc-comment')
    .join('\n');
  writeFileSync(archPath, arch, 'utf-8');
  rmSync(path.join(dir, '.yggdrasil', 'aspects', 'has-doc-comment'), {
    recursive: true,
    force: true,
  });
  return dir;
}

const ordersLogPath = (dir: string) =>
  path.join(dir, '.yggdrasil', 'model', 'services', 'orders', 'log.md');

/**
 * Seed services/orders with one approved log baseline. After this the node's
 * drift-state carries a `log` baseline (last_entry_datetime + prefix_hash), so
 * the append-only integrity check engages on any later log.md mutation. The
 * single deterministic-aspect approve is hermetic (no reviewer call).
 */
function approveWithLogBaseline(dir: string, reason: string): void {
  expect(run(['log', 'add', '--node', 'services/orders', '--reason', reason], dir).status).toBe(0);
  expect(run(['approve', '--node', 'services/orders'], dir).status).toBe(0);
}

// ---------------------------------------------------------------------------
// merge-resolve git-repo builder. Mirrors cli-log-integrity.test.ts: drives the
// REAL binary against a copy of the e2e-lifecycle graph. git stdio is piped (not
// inherited) so conflict notices never leak into test output; the conflicting
// `git merge` returns non-zero, which is tolerated (the conflict is then
// hand-resolved with `resolvedLog`).
// ---------------------------------------------------------------------------

const ANCESTOR_LOG = '## [2026-05-11T10:00:00.000Z]\nbase.\n';
const P1_NEW = '## [2026-05-11T11:00:00.000Z]\nfeat1.\n';
const P2_NEW = '## [2026-05-11T12:00:00.000Z]\nfeat2.\n';

/** Run a git command in the repo with stdio piped (silent). */
function git(repo: string, cmd: string): void {
  execSync(`git ${cmd}`, { cwd: repo, stdio: 'pipe' });
}

/**
 * Build a throwaway git repo in mkdtemp seeded with the e2e-lifecycle graph, an
 * ancestor log entry on services/orders, then two divergent branches each
 * adding one entry, merged with a conflict left for the caller to resolve by
 * writing `resolvedLog` into log.md and committing the merge.
 */
function buildMergeRepo(label: string, resolvedLog: string): string {
  const repo = mkdtempSync(path.join(tmpdir(), `yg-logmrx-${label}-`));
  cpSync(FIXTURE, repo, { recursive: true });
  const logPath = ordersLogPath(repo);
  mkdirSync(path.dirname(logPath), { recursive: true });

  git(repo, 'init -q -b main');
  git(repo, 'config user.email t@t.test');
  git(repo, 'config user.name Test');

  writeFileSync(logPath, ANCESTOR_LOG, 'utf-8');
  git(repo, 'add -A');
  git(repo, 'commit -qm ancestor');

  git(repo, 'checkout -qb feat1');
  writeFileSync(logPath, ANCESTOR_LOG + P1_NEW, 'utf-8');
  git(repo, 'add -A');
  git(repo, 'commit -qm feat1');

  git(repo, 'checkout -q main');
  git(repo, 'checkout -qb feat2 main');
  writeFileSync(logPath, ANCESTOR_LOG + P2_NEW, 'utf-8');
  git(repo, 'add -A');
  git(repo, 'commit -qm feat2');

  try {
    git(repo, 'merge --no-commit --no-ff feat1 -q');
  } catch {
    /* expected conflict — resolved by hand below */
  }
  writeFileSync(logPath, resolvedLog, 'utf-8');
  git(repo, 'add -A');
  git(repo, 'commit -qm "merge feat1 into feat2"');

  return repo;
}

describe.skipIf(!distExists)('CLI E2E — log integrity (append-only), format validation, add/read error paths', () => {
  // =========================================================================
  // APPEND-ONLY INTEGRITY — modifying pre-baseline log content
  // =========================================================================

  // A node is approved with a log baseline (two entries; the boundary is the
  // SECOND entry). Editing the FIRST (pre-baseline) entry's body changes the
  // hashed prefix → validateAppendOnly returns `prefix_modified`. Both approve
  // and check must surface the integrity error with restore-from-git guidance.

  it('1a: approve refuses (exit 1) when pre-baseline log content is modified — prefix_modified', () => {
    const dir = deterministicFixture('appendonly-approve');
    try {
      // Two entries so the integrity boundary is the SECOND; the FIRST is
      // pre-baseline (inside the hashed prefix).
      expect(run(['log', 'add', '--node', 'services/orders', '--reason', 'first entry body'], dir).status).toBe(0);
      expect(run(['log', 'add', '--node', 'services/orders', '--reason', 'second entry body'], dir).status).toBe(0);
      expect(run(['approve', '--node', 'services/orders'], dir).status).toBe(0);

      // Tamper an EARLIER (pre-baseline) line in place.
      const log = readFileSync(ordersLogPath(dir), 'utf-8');
      expect(log).toContain('first entry body');
      writeFileSync(ordersLogPath(dir), log.replace('first entry body', 'TAMPERED HISTORY'), 'utf-8');

      const { status, all } = run(['approve', '--node', 'services/orders'], dir);
      expect(status).toBe(1);
      expect(all).toContain('Log integrity broken (prefix_modified)');
      expect(all).toContain('Historical (pre-baseline) log content was modified — append-only violated.');
      // Restore-from-git guidance names both the log.md and the drift-state file.
      expect(all).toContain('git checkout HEAD -- .yggdrasil/model/services/orders/log.md');
      expect(all).toContain('.yggdrasil/.drift-state/services/orders.json');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('1b: check surfaces the same prefix_modified integrity error (exit 1, code log-integrity)', () => {
    const dir = deterministicFixture('appendonly-check');
    try {
      approveWithLogBaseline(dir, 'baseline entry one');
      // Add a second entry + approve so the boundary advances; then tamper the
      // first entry which now lives strictly inside the hashed prefix.
      expect(run(['log', 'add', '--node', 'services/orders', '--reason', 'baseline entry two'], dir).status).toBe(0);
      expect(run(['approve', '--node', 'services/orders'], dir).status).toBe(0);

      const log = readFileSync(ordersLogPath(dir), 'utf-8');
      writeFileSync(ordersLogPath(dir), log.replace('baseline entry one', 'EDITED'), 'utf-8');

      const { status, stdout, all } = run(['check'], dir);
      expect(status).toBe(1);
      // check renders the validation code plus the offending node path.
      expect(stdout).toContain('log-integrity');
      expect(stdout).toContain('services/orders');
      expect(all).toContain('Log integrity broken (prefix_modified)');
      expect(all).toContain('append-only violated');
      expect(all).toContain('git checkout HEAD --');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('1c: deleting log.md after a log baseline exists is detected as boundary_missing (exit 1)', () => {
    const dir = deterministicFixture('appendonly-deleted');
    try {
      approveWithLogBaseline(dir, 'only entry');
      // Remove the file entirely — the baseline boundary entry can no longer be
      // found, which validateAppendOnly reports as boundary_missing.
      rmSync(ordersLogPath(dir), { force: true });

      const { status, all } = run(['check'], dir);
      expect(status).toBe(1);
      expect(all).toContain('Log integrity broken (boundary_missing)');
      expect(all).toContain('(file missing)');
      expect(all).toContain('log was deleted or reset');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // =========================================================================
  // LOG FORMAT VALIDATION (beyond the level-2-heading case the base suite owns)
  //
  // Each violation is APPENDED after the integrity boundary (post-baseline) so
  // the append-only check passes and the FORMAT validator is the gate that
  // fires. A pre-baseline format corruption would instead trip the integrity
  // check first (it runs before the format check and any pre-baseline byte
  // change alters the prefix hash), so the format validator's own
  // "pre-baseline" classification is shadowed for in-prefix edits and is not
  // asserted here.
  // =========================================================================

  it('2a: an out-of-order (older) appended entry is rejected as out_of_order (exit 1, post-baseline)', () => {
    const dir = deterministicFixture('fmt-out-of-order');
    try {
      approveWithLogBaseline(dir, 'base entry');
      // Append an entry whose datetime is OLDER than the existing one.
      appendFileSync(ordersLogPath(dir), '## [2020-01-01T00:00:00.000Z]\nolder than base\n');

      const { status, all } = run(['approve', '--node', 'services/orders'], dir);
      expect(status).toBe(1);
      expect(all).toContain('Log format invalid');
      expect(all).toContain('out_of_order');
      expect(all).toContain('is not strictly greater than previous');
      expect(all).toContain('Post-baseline violation (editable)');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('2b: an entry whose datetime is parseable but non-strict is rejected as invalid_datetime (exit 1)', () => {
    const dir = deterministicFixture('fmt-invalid-datetime');
    try {
      approveWithLogBaseline(dir, 'base entry');
      // 2027-06-01T10:00:00Z is parseable by Date.parse but lacks the required
      // milliseconds, so the strict ISO check rejects it as invalid_datetime
      // (distinct from invalid_header, which is for entirely unparseable text).
      appendFileSync(ordersLogPath(dir), '## [2027-06-01T10:00:00Z]\nbody\n');

      const { status, all } = run(['approve', '--node', 'services/orders'], dir);
      expect(status).toBe(1);
      expect(all).toContain('Log format invalid');
      expect(all).toContain('invalid_datetime');
      expect(all).toContain('ISO 8601 UTC with milliseconds and Z suffix');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('2c: an entry header with entirely unparseable datetime is rejected as invalid_header (exit 1)', () => {
    const dir = deterministicFixture('fmt-invalid-header');
    try {
      approveWithLogBaseline(dir, 'base entry');
      appendFileSync(ordersLogPath(dir), '## [2026-13-99 not-a-date]\nbody\n');

      const { status, all } = run(['approve', '--node', 'services/orders'], dir);
      expect(status).toBe(1);
      expect(all).toContain('Log format invalid');
      expect(all).toContain('invalid_header');
      expect(all).toContain('is not parseable');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('2d: an unclosed code fence is rejected as unclosed_code_fence (exit 1)', () => {
    const dir = deterministicFixture('fmt-unclosed-fence');
    try {
      approveWithLogBaseline(dir, 'base entry');
      // Open a fence in a new entry's body and never close it before EOF.
      appendFileSync(
        ordersLogPath(dir),
        '## [2027-01-01T00:00:00.000Z]\nbody\n```\nopen fence never closed\n',
      );

      const { status, all } = run(['approve', '--node', 'services/orders'], dir);
      expect(status).toBe(1);
      expect(all).toContain('Log format invalid');
      expect(all).toContain('unclosed_code_fence');
      expect(all).toContain('opened but never closed');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('2e: a stray level-2 heading inside an entry body is rejected as level2_header_in_body (exit 1)', () => {
    const dir = deterministicFixture('fmt-stray-h2');
    try {
      approveWithLogBaseline(dir, 'base entry');
      // A level-2 heading written directly into log.md body (cannot be produced
      // via `yg log add`, which rejects it up front — the base suite covers that
      // path; here it is hand-written into the file to drive the FILE validator).
      appendFileSync(
        ordersLogPath(dir),
        '## [2027-02-01T00:00:00.000Z]\nbody line\n## Stray top-level heading\nmore\n',
      );

      const { status, all } = run(['approve', '--node', 'services/orders'], dir);
      expect(status).toBe(1);
      expect(all).toContain('Log format invalid');
      expect(all).toContain('level2_header_in_body');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('2f: check surfaces the format violation as code log-format (exit 1)', () => {
    const dir = deterministicFixture('fmt-via-check');
    try {
      approveWithLogBaseline(dir, 'base entry');
      // Approve payments too so the ONLY remaining error is the log-format one.
      expect(run(['approve', '--node', 'services/payments'], dir).status).toBe(0);
      appendFileSync(ordersLogPath(dir), '## [2020-01-01T00:00:00.000Z]\nolder\n');

      const { status, stdout } = run(['check'], dir);
      expect(status).toBe(1);
      // check renders the validation code, the offending node path, and the
      // first line of the `what` block (the per-line reason detail lives in the
      // full message data but check shows only the summary line + Why/Fix).
      expect(stdout).toContain('log-format');
      expect(stdout).toContain('services/orders');
      expect(stdout).toContain('Log format invalid at .yggdrasil/model/services/orders/log.md');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // =========================================================================
  // LOG ADD — error/guard paths
  // =========================================================================

  it('3a: log add refuses a symlinked log.md with the symlink message (exit 1)', () => {
    const dir = copyFixture('add-symlink');
    try {
      const logPath = ordersLogPath(dir);
      mkdirSync(path.dirname(logPath), { recursive: true });
      const target = path.join(dir, 'symlink-target.md');
      writeFileSync(target, '## [2026-01-01T00:00:00.000Z]\nbody\n', 'utf-8');
      symlinkSync(target, logPath);
      // Guard: the test setup really created a symlink.
      expect(statSync(logPath, { throwIfNoEntry: true }).isFile()).toBe(true);

      const { status, all } = run(
        ['log', 'add', '--node', 'services/orders', '--reason', 'x'],
        dir,
      );
      expect(status).toBe(1);
      expect(all).toContain('log.md is a symbolic link');
      expect(all).toContain('Symlinks bypass append-only guarantees');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('3b: log add refuses a hard-linked log.md with the hardlink message (exit 1)', () => {
    const dir = copyFixture('add-hardlink');
    try {
      const logPath = ordersLogPath(dir);
      mkdirSync(path.dirname(logPath), { recursive: true });
      const other = path.join(dir, 'hardlink-other.md');
      writeFileSync(other, '## [2026-01-01T00:00:00.000Z]\nbody\n', 'utf-8');
      linkSync(other, logPath);
      // Guard: st_nlink is now 2.
      expect(statSync(logPath).nlink).toBeGreaterThan(1);

      const { status, all } = run(
        ['log', 'add', '--node', 'services/orders', '--reason', 'x'],
        dir,
      );
      expect(status).toBe(1);
      expect(all).toContain('log.md has multiple hard links');
      expect(all).toContain('st_nlink > 1');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('3c: log add with a whitespace-only --reason is rejected as empty (exit 1)', () => {
    const dir = copyFixture('add-empty');
    try {
      const { status, all } = run(
        ['log', 'add', '--node', 'services/orders', '--reason', '   '],
        dir,
      );
      expect(status).toBe(1);
      expect(all).toContain('Reason cannot be empty after trim');
      // Nothing was written for the rejected entry.
      expect(existsSync(ordersLogPath(dir))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('3d: log add --reason-file with a missing file is rejected (exit 1)', () => {
    const dir = copyFixture('add-rf-missing');
    try {
      const missing = path.join(dir, 'no-such-reason.txt');
      const { status, all } = run(
        ['log', 'add', '--node', 'services/orders', '--reason-file', missing],
        dir,
      );
      expect(status).toBe(1);
      expect(all).toContain('Cannot stat --reason-file');
      expect(existsSync(ordersLogPath(dir))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('3e: log add --reason-file pointing at a directory is rejected as not-a-regular-file (exit 1)', () => {
    const dir = copyFixture('add-rf-dir');
    try {
      const aDir = path.join(dir, 'reason-dir');
      mkdirSync(aDir, { recursive: true });
      const { status, all } = run(
        ['log', 'add', '--node', 'services/orders', '--reason-file', aDir],
        dir,
      );
      expect(status).toBe(1);
      expect(all).toContain('--reason-file is not a regular file');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('3f: log add --reason-file with multi-line content writes the full body (exit 0)', () => {
    const dir = copyFixture('add-rf-multiline');
    try {
      const reasonFile = path.join(dir, 'reason.txt');
      // Multi-line body with a level-3 sub-heading (level-3 is allowed).
      writeFileSync(reasonFile, 'first line of rationale\n### context\nsecond line of rationale\n', 'utf-8');
      const { status, stdout } = run(
        ['log', 'add', '--node', 'services/orders', '--reason-file', reasonFile],
        dir,
      );
      expect(status).toBe(0);
      expect(stdout).toContain('Added log entry');

      const written = readFileSync(ordersLogPath(dir), 'utf-8');
      expect(written).toContain('first line of rationale');
      expect(written).toContain('### context');
      expect(written).toContain('second line of rationale');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('3g: log add with both --reason and --reason-file is rejected (exit 1)', () => {
    const dir = copyFixture('add-both');
    try {
      const reasonFile = path.join(dir, 'reason.txt');
      writeFileSync(reasonFile, 'body\n', 'utf-8');
      const { status, all } = run(
        ['log', 'add', '--node', 'services/orders', '--reason', 'x', '--reason-file', reasonFile],
        dir,
      );
      expect(status).toBe(1);
      expect(all).toContain('Exactly one of --reason or --reason-file is required');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // =========================================================================
  // LOG READ — error/guard paths and full-history
  // =========================================================================

  it('4a: read --all returns the full history newest-first (exit 0)', () => {
    const dir = copyFixture('read-all');
    try {
      // Three entries with monotonic timestamps guaranteed by the binary.
      expect(run(['log', 'add', '--node', 'services/orders', '--reason', 'alpha'], dir).status).toBe(0);
      expect(run(['log', 'add', '--node', 'services/orders', '--reason', 'beta'], dir).status).toBe(0);
      expect(run(['log', 'add', '--node', 'services/orders', '--reason', 'gamma'], dir).status).toBe(0);

      const { status, stdout } = run(['log', 'read', '--node', 'services/orders', '--all'], dir);
      expect(status).toBe(0);
      // All three present.
      expect(stdout).toContain('alpha');
      expect(stdout).toContain('beta');
      expect(stdout).toContain('gamma');
      // Newest-first ordering: gamma's body precedes beta's, which precedes alpha's.
      expect(stdout.indexOf('gamma')).toBeLessThan(stdout.indexOf('beta'));
      expect(stdout.indexOf('beta')).toBeLessThan(stdout.indexOf('alpha'));
      // Exactly three entry headers rendered.
      const headerCount = stdout.split('\n').filter((l) => l.startsWith('## [')).length;
      expect(headerCount).toBe(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('4b: read --top with a non-integer value is rejected (exit 1)', () => {
    const dir = copyFixture('read-top-nan');
    try {
      run(['log', 'add', '--node', 'services/orders', '--reason', 'one'], dir);
      // parseInt('abc', 10) → NaN; logRead rejects a non-positive/non-integer top.
      const { status, all } = run(
        ['log', 'read', '--node', 'services/orders', '--top', 'abc'],
        dir,
      );
      expect(status).toBe(1);
      expect(all).toContain('Invalid --top value: NaN');
      expect(all).toContain('positive integer');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('4c: read --top combined with --all is rejected (exit 1)', () => {
    const dir = copyFixture('read-top-all');
    try {
      run(['log', 'add', '--node', 'services/orders', '--reason', 'one'], dir);
      const { status, all } = run(
        ['log', 'read', '--node', 'services/orders', '--top', '2', '--all'],
        dir,
      );
      expect(status).toBe(1);
      expect(all).toContain('Cannot combine --top with --all');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('4d: read a node that has no log.md returns "No log entries." (exit 0)', () => {
    const dir = copyFixture('read-no-log');
    try {
      // services/payments ships no log.md in the fixture.
      expect(existsSync(path.join(dir, '.yggdrasil', 'model', 'services', 'payments', 'log.md'))).toBe(false);
      const { status, stdout } = run(['log', 'read', '--node', 'services/payments'], dir);
      expect(status).toBe(0);
      expect(stdout).toContain('No log entries.');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // =========================================================================
  // MERGE-RESOLVE — additional tamper paths (NOT in the base suite, which
  // covers non-merge HEAD + tampered ancestor prefix only)
  // =========================================================================

  it('5a: merge-resolve rejects a DROPPED parent entry (exit 1)', () => {
    // Resolved log keeps the ancestor + feat2 but drops feat1's entry.
    const repo = buildMergeRepo('drop', ANCESTOR_LOG + P2_NEW);
    try {
      const { status, all } = run(['log', 'merge-resolve', '--node', 'services/orders'], repo);
      expect(status).toBe(1);
      expect(all).toContain('missing or has altered');
      // The dropped entry's datetime is named in the restore guidance.
      expect(all).toContain('2026-05-11T11:00:00.000Z');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('5b: merge-resolve rejects a FABRICATED entry present in neither parent (exit 1)', () => {
    const fabricated = '## [2026-05-11T13:00:00.000Z]\nfabricated, in no branch.\n';
    const repo = buildMergeRepo('fab', ANCESTOR_LOG + P1_NEW + P2_NEW + fabricated);
    try {
      const { status, all } = run(['log', 'merge-resolve', '--node', 'services/orders'], repo);
      expect(status).toBe(1);
      expect(all).toContain('not present in either merge parent');
      expect(all).toContain('2026-05-11T13:00:00.000Z');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('5c: merge-resolve rejects an ALTERED parent-entry body (exit 1)', () => {
    // feat1's body is changed; content-hash matching classifies it as a missing
    // (altered) parent entry rather than a clean union.
    const alteredP1 = '## [2026-05-11T11:00:00.000Z]\nfeat1-ALTERED-BODY.\n';
    const repo = buildMergeRepo('alter', ANCESTOR_LOG + alteredP1 + P2_NEW);
    try {
      const { status, all } = run(['log', 'merge-resolve', '--node', 'services/orders'], repo);
      expect(status).toBe(1);
      expect(all).toContain('missing or has altered');
      expect(all).toContain('2026-05-11T11:00:00.000Z');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
