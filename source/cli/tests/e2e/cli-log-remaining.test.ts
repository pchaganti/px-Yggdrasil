import { describe, it, expect } from 'vitest';
import { spawnSync, execSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  rmSync,
  cpSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
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
// git-recovery cases never invoke the reviewer at all. No real host/port is
// dialed. No wall clock or random source is read in assertions: every datetime
// asserted on is either produced by the binary and read back (never compared to
// the current time) or seeded as a FIXED far-future literal so the monotonic
// bump is invariant across runs. Each test works inside a fresh mkdtemp dir and
// removes it in a finally block; the committed fixture bytes are never mutated.
//
// SCOPE — this suite covers the LOG-DOMAIN paths the three existing log suites
// leave UNCOVERED. Cases SKIPPED here because they are already pinned:
//   cli-log-integrity.test.ts: mandatory-gate refusal + log-add-then-approve
//     pass; level-2 heading in a --reason rejected / level-3 accepted; read
//     --top 2 / --top 0; merge-resolve happy / non-merge-HEAD / tampered
//     ancestor prefix.
//   cli-log-integrity-extended.test.ts: append-only prefix_modified /
//     boundary_missing; format out_of_order / invalid_datetime / invalid_header
//     / unclosed_code_fence / level2_header_in_body (hand-written); log add
//     symlink / hardlink / empty-reason / reason-file missing|dir|multiline|
//     both-flags; read --all (3 entries) / --top NaN / --top+--all / no-log;
//     merge-resolve dropped / fabricated / altered.
//   cli-log-gate-extended.test.ts: cascade-only no-entry; gate status
//     independence (advisory/all-draft); log_required:false no-op; zero-mapped
//     vacuous; fenced level-2 / fenced datetime exemption + fence-aware read;
//     duplicate_datetime; node-path syntax rejection across add/read/merge;
//     node-not-found across add/read/merge; merge-resolve missing-log /
//     conflict-markers / chronological-order.
//   cli-lifecycle.test.ts: basic add / read / read --all / read --top 1 /
//     reason-file happy path / missing --node / missing --reason / nonexistent
//     node smoke.
//
// This file adds: the Supersedes convention (acceptance + round-trip), the
// `yg log read` FORMAT-VIOLATION surfacing path (invalid_start — read is the
// only command that runs validateFormat for rendering, and no suite pins it),
// the DEFAULT --top 10 bound and --all no-truncation on a LARGE log, the
// monotonic-clock datetime BUMP (last entry in the future), and the git-based
// typo-recovery + full-revert + partial-revert-pitfall workflows from
// `knowledge read log-management`.
// ---------------------------------------------------------------------------

function run(
  args: string[],
  cwd: string,
): { stdout: string; stderr: string; status: number | null; all: string } {
  const result = spawnSync('node', [BIN_PATH, ...args], { cwd, encoding: 'utf-8' });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  return { stdout, stderr, status: result.status, all: stdout + stderr };
}

/** Copy the e2e-lifecycle fixture into a fresh temp dir for mutation. */
function copyFixture(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-logrem-${label}-`));
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

const ordersFile = (dir: string) => path.join(dir, 'src', 'services', 'orders.ts');
const ordersLogPath = (dir: string) =>
  path.join(dir, '.yggdrasil', 'model', 'services', 'orders', 'log.md');
const ordersDriftPath = (dir: string) =>
  path.join(dir, '.yggdrasil', '.drift-state', 'services', 'orders.json');

/** Run a git command in the repo with stdio piped (silent). */
function git(repo: string, cmd: string): void {
  execSync(`git ${cmd}`, { cwd: repo, stdio: 'pipe' });
}

/** Initialize a throwaway git repo over a deterministic fixture copy. */
function initRepo(label: string): string {
  const dir = deterministicFixture(label);
  git(dir, 'init -q -b main');
  git(dir, 'config user.email t@t.test');
  git(dir, 'config user.name Test');
  return dir;
}

const headerCount = (s: string) => s.split('\n').filter((l) => l.startsWith('## [')).length;

describe.skipIf(!distExists)('CLI E2E — log remaining: supersedes, read format surfacing, large-log bounds, clock bump, git recovery', () => {
  // =========================================================================
  // 1. SUPERSEDES CONVENTION
  //
  // knowledge read log-management: to supersede an earlier entry, append a new
  // entry whose body opens with `### Supersedes: <prior ISO datetime>`. It is a
  // LEVEL-3 heading, so `yg log add` accepts it (the level-2 reservation does
  // not fire), and it round-trips through `yg log read` verbatim. No existing
  // log suite exercises this convention through the binary.
  // =========================================================================

  it('1A: a `### Supersedes:` entry is accepted by log add and round-trips through read (exit 0)', () => {
    const dir = copyFixture('supersedes-add');
    try {
      const first = run(['log', 'add', '--node', 'services/orders', '--reason', 'the original decision'], dir);
      expect(first.status).toBe(0);

      const supersedeReason =
        '### Supersedes: 2026-01-01T00:00:00.000Z\nThe earlier decision no longer holds; this entry replaces it.';
      const add = run(['log', 'add', '--node', 'services/orders', '--reason', supersedeReason], dir);
      expect(add.status).toBe(0);
      expect(add.stdout).toContain('Added log entry');

      // The newest entry renders the structured supersedes line verbatim.
      const read = run(['log', 'read', '--node', 'services/orders', '--top', '1'], dir);
      expect(read.status).toBe(0);
      expect(read.stdout).toContain('### Supersedes: 2026-01-01T00:00:00.000Z');
      expect(read.stdout).toContain('this entry replaces it');
      // Both entries survive in --all; the supersede entry does not delete history.
      const all = run(['log', 'read', '--node', 'services/orders', '--all'], dir);
      expect(headerCount(all.stdout)).toBe(2);
      expect(all.stdout).toContain('the original decision');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // =========================================================================
  // 2. `yg log read` SURFACES A FORMAT VIOLATION
  //
  // log-read.ts runs validateFormat before rendering; on a violation it returns
  // a `log.md format violation at line N: <reason>` error (exit 1). Approve and
  // check surface format via their own gates (the two integrity suites pin
  // those), but the READ command's own format-surfacing path — and the
  // `invalid_start` reason specifically (a file that does not begin with a
  // header) — is pinned by no e2e suite. invalid_start is impossible to produce
  // via `yg log add` (it always writes a header first), so it is hand-written.
  // =========================================================================

  it('2A: log read on a log.md not starting with a header reports invalid_start (exit 1)', () => {
    const dir = copyFixture('read-invalid-start');
    try {
      mkdirSync(path.dirname(ordersLogPath(dir)), { recursive: true });
      // Preamble line before the first header → validateFormat invalid_start.
      writeFileSync(
        ordersLogPath(dir),
        'stray preamble line, not a header\n## [2027-01-01T00:00:00.000Z]\nbody\n',
        'utf-8',
      );
      const { status, all } = run(['log', 'read', '--node', 'services/orders'], dir);
      expect(status).toBe(1);
      expect(all).toContain('log.md format violation at line 1: invalid_start');
      expect(all).toContain('File must start with `## [<datetime>]` or be empty');
      expect(all).toContain('Fix log.md for node services/orders');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('2B: log read surfaces an out_of_order format violation before rendering (exit 1)', () => {
    const dir = copyFixture('read-out-of-order');
    try {
      mkdirSync(path.dirname(ordersLogPath(dir)), { recursive: true });
      // Second header older than the first → out_of_order; read refuses to
      // render rather than emit a misordered history.
      writeFileSync(
        ordersLogPath(dir),
        '## [2027-02-02T00:00:00.000Z]\nnewer first\n## [2027-01-01T00:00:00.000Z]\nolder second\n',
        'utf-8',
      );
      const { status, all } = run(['log', 'read', '--node', 'services/orders'], dir);
      expect(status).toBe(1);
      expect(all).toContain('out_of_order');
      expect(all).toContain('is not strictly greater than previous');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // =========================================================================
  // 3. LARGE-LOG READ BOUNDS — default --top 10 + --all no-truncation
  //
  // The existing suites only exercise --top 2 / --top 1 / --all over 3 entries,
  // and --top 0 / NaN guards. The DEFAULT limit (DEFAULT_TOP = 10) on a log with
  // MORE than ten entries, and that --all returns every entry with no
  // truncation surprise, are unpinned. Thirteen entries make the boundary
  // explicit: default read = newest 10, --all = all 13.
  // =========================================================================

  it('3A: default read bounds to the newest 10 entries while --all returns all 13 (no truncation)', () => {
    const dir = copyFixture('large-log');
    try {
      // Thirteen entries; the binary guarantees strictly-ascending timestamps.
      for (let i = 1; i <= 13; i++) {
        expect(run(['log', 'add', '--node', 'services/orders', '--reason', `entry-marker-${i}`], dir).status).toBe(0);
      }

      const def = run(['log', 'read', '--node', 'services/orders'], dir);
      expect(def.status).toBe(0);
      // Default --top is 10: exactly ten headers, newest-first.
      expect(headerCount(def.stdout)).toBe(10);
      // Newest entry present; the three oldest (1..3) fall outside the window.
      expect(def.stdout).toContain('entry-marker-13');
      expect(def.stdout).toContain('entry-marker-4'); // oldest within the top-10 window
      expect(def.stdout).not.toContain('entry-marker-3\n');
      expect(def.stdout).not.toContain('entry-marker-1\n');

      const all = run(['log', 'read', '--node', 'services/orders', '--all'], dir);
      expect(all.status).toBe(0);
      // --all returns every entry — no truncation at 10.
      expect(headerCount(all.stdout)).toBe(13);
      expect(all.stdout).toContain('entry-marker-1\n');
      expect(all.stdout).toContain('entry-marker-13');
      // Newest-first ordering across the full set.
      expect(all.stdout.indexOf('entry-marker-13')).toBeLessThan(all.stdout.indexOf('entry-marker-1\n'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('3B: read --top 25 on a 13-entry log returns all 13 (limit exceeding count is not an error)', () => {
    const dir = copyFixture('top-over-count');
    try {
      for (let i = 1; i <= 13; i++) {
        run(['log', 'add', '--node', 'services/orders', '--reason', `e${i}`], dir);
      }
      const r = run(['log', 'read', '--node', 'services/orders', '--top', '25'], dir);
      expect(r.status).toBe(0);
      // A --top larger than the entry count clamps to the available entries.
      expect(headerCount(r.stdout)).toBe(13);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // =========================================================================
  // 4. MONOTONIC-CLOCK DATETIME BUMP
  //
  // log-add's monotonicNow guarantees strictly-ascending datetimes even when the
  // host clock is at or behind the last recorded entry: the new entry is stamped
  // last_entry_ms + 1. Seeding a FIXED far-future last entry makes the asserted
  // result invariant (independent of the real wall clock — the bump path, not
  // Date.now(), determines the output). No suite pins this guarantee.
  // =========================================================================

  it('4A: a new entry after a far-future last entry is bumped to last+1ms and stays strictly ascending', () => {
    const dir = copyFixture('clock-bump');
    try {
      mkdirSync(path.dirname(ordersLogPath(dir)), { recursive: true });
      // Last entry is in the year 2099 — guaranteed ahead of any real test clock.
      writeFileSync(ordersLogPath(dir), '## [2099-12-31T23:59:59.999Z]\nfar future\n', 'utf-8');

      const add = run(['log', 'add', '--node', 'services/orders', '--reason', 'after the future'], dir);
      expect(add.status).toBe(0);
      // 2099-12-31T23:59:59.999Z + 1ms = 2100-01-01T00:00:00.000Z (deterministic).
      expect(add.stdout).toContain('Timestamp: 2100-01-01T00:00:00.000Z');

      const read = run(['log', 'read', '--node', 'services/orders', '--top', '1'], dir);
      expect(read.status).toBe(0);
      expect(read.stdout.trimStart().startsWith('## [2100-01-01T00:00:00.000Z]')).toBe(true);
      // The append is strictly ascending, so the format validator is satisfied —
      // a no-op approve setup would not see out_of_order. Verify via read of the
      // full history: both headers present, newest first.
      const all = run(['log', 'read', '--node', 'services/orders', '--all'], dir);
      expect(all.stdout.indexOf('2100-01-01T00:00:00.000Z')).toBeLessThan(
        all.stdout.indexOf('2099-12-31T23:59:59.999Z'),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // =========================================================================
  // 5. GIT TYPO-RECOVERY — restore a mistaken entry BEFORE first approve
  //
  // knowledge read log-management "Recovery from typo": if a fresh `yg log add`
  // has a typo and NO approve has run since, `git checkout -- log.md` restores
  // the committed version; integrity stays intact because the drift-state
  // baseline was never advanced past the typo'd entry. Pin the integrity outcome
  // before and after the restore + a corrected re-add.
  // =========================================================================

  it('5A: git-checkout restores a typo entry pre-approve; corrected re-add then approves (exit 0)', () => {
    const dir = initRepo('typo-recovery');
    try {
      // Establish a committed baseline: one correct entry + approve, then commit.
      expect(run(['log', 'add', '--node', 'services/orders', '--reason', 'correct first entry'], dir).status).toBe(0);
      expect(run(['approve', '--node', 'services/orders'], dir).status).toBe(0);
      git(dir, 'add -A');
      git(dir, 'commit -qm baseline');

      // Append a typo'd entry (post-baseline). No approve runs on it.
      expect(run(['log', 'add', '--node', 'services/orders', '--reason', 'typo entyr, regret'], dir).status).toBe(0);
      expect(headerCount(run(['log', 'read', '--node', 'services/orders', '--all'], dir).stdout)).toBe(2);

      // Restore the committed log.md — the typo entry vanishes, history is back to one.
      git(dir, `checkout -- .yggdrasil/model/services/orders/log.md`);
      const restored = run(['log', 'read', '--node', 'services/orders', '--all'], dir);
      expect(headerCount(restored.stdout)).toBe(1);
      expect(restored.stdout).not.toContain('typo entyr');

      // Re-add the corrected entry and approve — integrity intact, exit 0.
      expect(run(['log', 'add', '--node', 'services/orders', '--reason', 'corrected entry text'], dir).status).toBe(0);
      const approve = run(['approve', '--node', 'services/orders'], dir);
      expect(approve.status).toBe(0);
      expect(approve.stdout).toContain('Approved: services/orders');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // =========================================================================
  // 6. GIT FULL-REVERT — restore source + log + drift-state together
  //
  // knowledge read log-management "Reverting a change you regret": move source,
  // log.md, and the drift-state file together with one `git checkout HEAD~1 --`.
  // All three move as a unit → no source drift, integrity intact, and a
  // subsequent approve is cascade-clean. Pin that the trio restores cleanly.
  // =========================================================================

  it('6A: reverting source + log + drift-state together leaves no drift; approve is cascade-clean (exit 0)', () => {
    const dir = initRepo('full-revert');
    try {
      // Commit A: baseline entry + approve.
      expect(run(['log', 'add', '--node', 'services/orders', '--reason', 'entry one'], dir).status).toBe(0);
      expect(run(['approve', '--node', 'services/orders'], dir).status).toBe(0);
      git(dir, 'add -A');
      git(dir, 'commit -qm commitA');

      // Commit B: a regretted source change + entry two + approve.
      writeFileSync(ordersFile(dir), readFileSync(ordersFile(dir), 'utf-8') + '\nexport const regret = 1;\n', 'utf-8');
      expect(run(['log', 'add', '--node', 'services/orders', '--reason', 'entry two: add regret const'], dir).status).toBe(0);
      expect(run(['approve', '--node', 'services/orders'], dir).status).toBe(0);
      git(dir, 'add -A');
      git(dir, 'commit -qm commitB');

      // Revert all three files together to commit A.
      git(
        dir,
        'checkout HEAD~1 -- src/services/orders.ts ' +
          '.yggdrasil/model/services/orders/log.md ' +
          '.yggdrasil/.drift-state/services/orders.json',
      );
      // Source reverted, log back to one entry.
      expect(readFileSync(ordersFile(dir), 'utf-8')).not.toContain('regret');
      expect(headerCount(run(['log', 'read', '--node', 'services/orders', '--all'], dir).stdout)).toBe(1);

      // No source-drift and no log-integrity error for services/orders.
      const check = run(['check'], dir);
      const ordersLines = check.stdout
        .split('\n')
        .filter((l) => l.includes('services/orders') && (l.includes('drift') || l.includes('log-integrity')));
      expect(ordersLines).toEqual([]);

      // Re-approve is cascade-clean (no source change vs. the restored baseline).
      expect(run(['approve', '--node', 'services/orders'], dir).status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // 6B: the PARTIAL-revert pitfall the contract warns against — restoring
  // source + log but NOT the drift-state file. The stale drift-state still
  // points at commit B's source hash AND its log baseline datetime (entry two),
  // which no longer exists after the log revert. So check reports BOTH a source
  // `drift` and a `log-integrity (boundary_missing)` error — demonstrating WHY
  // all three files must move as a unit.
  it('6B: partial revert (source + log, NOT drift-state) yields drift + boundary_missing (exit 1)', () => {
    const dir = initRepo('partial-revert');
    try {
      expect(run(['log', 'add', '--node', 'services/orders', '--reason', 'entry one'], dir).status).toBe(0);
      expect(run(['approve', '--node', 'services/orders'], dir).status).toBe(0);
      git(dir, 'add -A');
      git(dir, 'commit -qm commitA');

      writeFileSync(ordersFile(dir), readFileSync(ordersFile(dir), 'utf-8') + '\nexport const regret = 1;\n', 'utf-8');
      expect(run(['log', 'add', '--node', 'services/orders', '--reason', 'entry two'], dir).status).toBe(0);
      expect(run(['approve', '--node', 'services/orders'], dir).status).toBe(0);
      git(dir, 'add -A');
      git(dir, 'commit -qm commitB');

      // Restore ONLY source + log; leave drift-state at commit B.
      git(
        dir,
        'checkout HEAD~1 -- src/services/orders.ts .yggdrasil/model/services/orders/log.md',
      );
      // Guard: the drift-state file was not touched (still present from commit B).
      expect(existsSync(ordersDriftPath(dir))).toBe(true);

      const { status, all } = run(['check'], dir);
      expect(status).toBe(1);
      // Stale baseline source hash → source drift.
      expect(all).toContain('Source files changed since last approve');
      // Stale log baseline datetime (entry two) no longer present in the log →
      // the append-only boundary entry cannot be found.
      expect(all).toContain('Log integrity broken (boundary_missing)');
      expect(all).toContain('services/orders');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
