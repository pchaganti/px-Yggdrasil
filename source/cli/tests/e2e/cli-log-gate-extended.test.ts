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
// Every scenario here is LLM-independent and network-free. The fill cases run on
// `deterministicFixture` (the LLM aspect `has-doc-comment` is stripped from the
// service type, so `yg check --approve` records only deterministic verdicts and
// never contacts a reviewer endpoint). The log add/read and merge-resolve cases
// never invoke the reviewer at all. No real host/port is dialed; no wall clock
// or random source is read in assertions (log timestamps are produced by the
// binary and read back, never compared to the current time). Each test works
// inside a fresh mkdtemp dir and removes it in a finally block; the committed
// fixture bytes are never mutated.
//
// MODEL — `yg approve` / `.drift-state/` are GONE. Verification happens via
// `yg check --approve` (fill); state lives in `.yggdrasil/yg-lock.json`. The
// mandatory-log gate now fires at fill time: a node whose type has
// `log_required: true` and whose source fingerprint changed but has no fresh log
// entry emits `No fresh log entry for node '<path>' — mandatory before --approve
// when source changed.` (code log-entry-missing), has its pairs SKIPPED, and the
// run stays red. The gate keys off the SOURCE fingerprint, never on verdict
// invalidation: a cascade-only change (aspect check.mjs edited, source untouched)
// re-runs the check at fill time WITHOUT requiring a new log entry. With
// log_required:true even the FIRST fill of a node with mapped source needs an
// entry (the cold source fingerprint counts as a change). The log baseline lives
// in yg-lock.json (`nodes.<path>.log`), not the removed `.drift-state/`.
//
// SCOPE — gate SEMANTICS (cascade-only-no-entry, status independence,
// log_required:false no-op, zero-mapped-source vacuous), the fence-exemption +
// duplicate-datetime FORMAT edges, the node-path-SYNTAX rejection across all
// three log subcommands, node-not-found, and the merge-resolve missing-log /
// conflict-markers / chronological-order paths.
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
  const dir = mkdtempSync(path.join(tmpdir(), `yg-loggate-${label}-`));
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

/**
 * Copy the fixture and strip the LLM aspect (`has-doc-comment`) so the node's
 * effective aspects are purely deterministic. This makes the fill lifecycle
 * hermetic: no network, no LLM verdict, fully reproducible.
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

/**
 * Flip the `service` node type's `log_required` from false (fixture default) to
 * true so the mandatory-log gate engages on a source change. Scans for the
 * service block specifically and only mutates its flag; the module block's flag
 * is left untouched.
 */
function enableServiceLogRequired(dir: string): void {
  const archPath = path.join(dir, '.yggdrasil', 'yg-architecture.yaml');
  const lines = readFileSync(archPath, 'utf-8').split('\n');
  let inService = false;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('  service:')) {
      inService = true;
      continue;
    }
    if (inService && /^ {2}\S.*:\s*$/.test(lines[i]) && !lines[i].startsWith('  service:')) {
      inService = false;
    }
    if (inService && lines[i].trim() === 'log_required: false') {
      lines[i] = lines[i].replace('false', 'true');
      inService = false;
    }
  }
  writeFileSync(archPath, lines.join('\n'), 'utf-8');
}

/** Rewrite an aspect's `status:` line to a new level (draft/advisory/enforced). */
function setAspectStatus(dir: string, aspectId: string, status: 'draft' | 'advisory' | 'enforced'): void {
  const p = path.join(dir, '.yggdrasil', 'aspects', aspectId, 'yg-aspect.yaml');
  const rewritten = readFileSync(p, 'utf-8')
    .split('\n')
    .map((l) => (/^status:\s*\S+/.test(l) ? `status: ${status}` : l))
    .join('\n');
  writeFileSync(p, rewritten, 'utf-8');
}

const ordersFile = (dir: string) => path.join(dir, 'src', 'services', 'orders.ts');
const ordersLogPath = (dir: string) =>
  path.join(dir, '.yggdrasil', 'model', 'services', 'orders', 'log.md');

const NO_TODO_CHECK = (dir: string) =>
  path.join(dir, '.yggdrasil', 'aspects', 'no-todo-comments', 'check.mjs');

// ---------------------------------------------------------------------------
// merge-resolve git-repo helpers. Drive the REAL binary against a copy of the
// e2e-lifecycle graph. git stdio is piped (silent); a conflicting merge returns
// non-zero, which is tolerated (the conflict is then hand-resolved).
// ---------------------------------------------------------------------------

const ANCESTOR_LOG = '## [2026-05-11T10:00:00.000Z]\nbase.\n';
const P1_NEW = '## [2026-05-11T11:00:00.000Z]\nfeat1.\n';
const P2_NEW = '## [2026-05-11T12:00:00.000Z]\nfeat2.\n';

function git(repo: string, cmd: string): void {
  execSync(`git ${cmd}`, { cwd: repo, stdio: 'pipe' });
}

/**
 * Build a throwaway git repo seeded with the e2e-lifecycle graph, an ancestor
 * log entry on services/orders, two divergent branches each adding one entry,
 * merged with a conflict left for the caller to resolve by writing `resolvedLog`
 * into log.md and committing the merge.
 */
function buildMergeRepo(label: string, resolvedLog: string): string {
  const repo = mkdtempSync(path.join(tmpdir(), `yg-loggate-mr-${label}-`));
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

const GATE_FIRED = "No fresh log entry for node 'services/orders' — mandatory before --approve when source changed.";

describe.skipIf(!distExists)('CLI E2E — log gate semantics, format edges, node-path syntax, merge-resolve paths', () => {
  // =========================================================================
  // 1. GATE SEMANTICS — when a fresh log entry is (not) required
  // =========================================================================

  // --- 1A. Cascade-only re-fill needs NO new log entry (log_required:true) ---
  // A source change demands an entry; an UPSTREAM-only change (aspect check.mjs
  // edited) does not. The gate keys off a SOURCE change, not any verdict
  // invalidation. After the aspect edit both pairs are `unverified`; the fill
  // re-runs them WITHOUT a fresh log entry because the source is untouched.
  it('1A: cascade-only re-fill (log_required:true) needs no new log entry — fill passes (exit 0)', () => {
    const dir = deterministicFixture('cascade-only');
    try {
      enableServiceLogRequired(dir);
      // Seed both nodes with a log entry (cold fill needs an entry per node) +
      // a clean lock.
      expect(run(['log', 'add', '--node', 'services/orders', '--reason', 'init'], dir).status).toBe(0);
      expect(run(['log', 'add', '--node', 'services/payments', '--reason', 'init'], dir).status).toBe(0);
      expect(run(['check', '--approve'], dir).status).toBe(0);

      const before = readFileSync(ordersLogPath(dir), 'utf-8');

      // Upstream cascade trigger — edit the aspect implementation, no source touch.
      appendFileSync(NO_TODO_CHECK(dir), '\n// cascade-trigger: trivial no-op comment\n');

      // The cascade is real: both pairs go unverified and check exits 1 before
      // the re-fill.
      const drifted = run(['check'], dir);
      expect(drifted.status).toBe(1);
      expect(drifted.stdout).toContain('unverified');

      // Re-fill WITHOUT adding a new log entry — the gate does not fire.
      const refill = run(['check', '--approve'], dir);
      expect(refill.status).toBe(0);
      expect(refill.stdout).toContain('[det] no-todo-comments on node:services/orders — approved');
      expect(refill.all).not.toContain(GATE_FIRED);

      // The log was not mutated by the cascade re-fill.
      expect(readFileSync(ordersLogPath(dir), 'utf-8')).toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- 1B. A SECOND source change with log_required:true + no fresh entry → gate refuses ---
  // The node already carries a verified baseline + an old log entry; a SECOND
  // source change without a NEW entry must still be blocked at fill time.
  it('1B: a second source change with no fresh entry is skipped by the gate (exit 1)', () => {
    const dir = deterministicFixture('gate-second-change');
    try {
      enableServiceLogRequired(dir);
      // First cycle: entry on each node + a source edit, then fill establishes a
      // log baseline + verified verdicts.
      expect(run(['log', 'add', '--node', 'services/orders', '--reason', 'cycle one'], dir).status).toBe(0);
      expect(run(['log', 'add', '--node', 'services/payments', '--reason', 'cycle one'], dir).status).toBe(0);
      writeFileSync(ordersFile(dir), readFileSync(ordersFile(dir), 'utf-8') + '\nexport const a = 1;\n', 'utf-8');
      expect(run(['check', '--approve'], dir).status).toBe(0);

      // Second source change but the newest log entry is the already-baselined one.
      writeFileSync(ordersFile(dir), readFileSync(ordersFile(dir), 'utf-8') + '\nexport const b = 2;\n', 'utf-8');
      const { status, all } = run(['check', '--approve'], dir);
      expect(status).toBe(1);
      expect(all).toContain(GATE_FIRED);
      expect(all).toContain("Node type 'service' has log_required: true");
      expect(all).toContain('yg log add --node services/orders');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- 1C. Gate firing is INDEPENDENT of aspect status (ADVISORY) ---
  // The gate keys off log_required + a source change, never on aspect status:
  // even when every non-draft effective aspect is merely advisory, a source
  // change with no fresh entry still TRIPS the gate (its message prints and the
  // node's pairs are skipped). The RUN exit code then follows the skipped pairs'
  // severity: both are advisory, so the skipped pairs render as non-blocking
  // WARNINGS and the run exits 0. (Under the old per-node `yg approve` model the
  // gate firing alone forced exit 1; in the fill model the severity is
  // status-driven — what is preserved is that the gate fires regardless of
  // status, asserted via the gate message, not the exit code.)
  it('1C: gate fires on a source change when every non-draft aspect is advisory (warning, exit 0)', () => {
    const dir = deterministicFixture('status-indep-advisory');
    try {
      enableServiceLogRequired(dir);
      // Demote the only enforced aspect to advisory → all non-draft aspects are
      // advisory (requires-named-export already advisory; wip-rule is draft).
      setAspectStatus(dir, 'no-todo-comments', 'advisory');
      // First cycle with an entry per node so a baseline exists.
      expect(run(['log', 'add', '--node', 'services/orders', '--reason', 'init advisory'], dir).status).toBe(0);
      expect(run(['log', 'add', '--node', 'services/payments', '--reason', 'init advisory'], dir).status).toBe(0);
      expect(run(['check', '--approve'], dir).status).toBe(0);

      // Source change, no fresh entry.
      writeFileSync(ordersFile(dir), readFileSync(ordersFile(dir), 'utf-8') + '\nexport const c = 3;\n', 'utf-8');
      const { status, all } = run(['check', '--approve'], dir);
      // The gate fires (message present, pairs skipped) regardless of aspect
      // status — proven by the message, not by the exit code.
      expect(all).toContain(GATE_FIRED);
      expect(all).toContain("Node type 'service' has log_required: true");
      // The skipped pairs are advisory → non-blocking warnings → exit 0.
      expect(status).toBe(0);
      expect(all).toContain('unverified');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- 1D. An ALL-DRAFT node produces no fill pairs, so the gate cannot fire ---
  //
  // BEHAVIOR CHANGE (ported, not weakened): the old per-node `yg approve` log
  // gate ran on every approved node regardless of aspect status, so an all-draft
  // source change still demanded an entry. In the fill model the gate is
  // PAIR-SCOPED: it only iterates over nodes that own unverified pairs to fill
  // (core/fill.ts builds its node set from `unverifiedPairs`). Draft aspects
  // produce NO pairs, so an all-draft node is never in the fill's node set and
  // the source-change gate has nothing to gate — the fill is vacuously clean
  // (exit 0) and the gate message never appears. (The gate's status-independence
  // for nodes that DO have non-draft pairs is pinned by 1B/1C.)
  it('1D: an all-draft node produces no fill pairs — the source-change gate does not fire (exit 0)', () => {
    const dir = deterministicFixture('status-indep-draft');
    try {
      enableServiceLogRequired(dir);
      // Drive EVERY effective aspect to draft.
      setAspectStatus(dir, 'no-todo-comments', 'draft');
      setAspectStatus(dir, 'requires-named-export', 'draft');
      // wip-rule is already draft in the fixture.

      // Source change, no log entry at all, no prior baseline.
      writeFileSync(ordersFile(dir), readFileSync(ordersFile(dir), 'utf-8') + '\nexport const d = 4;\n', 'utf-8');
      const { status, stdout, all } = run(['check', '--approve'], dir);

      // No pairs to fill → the gate never iterates this node → no gate message.
      expect(status).toBe(0);
      expect(all).not.toContain(GATE_FIRED);
      expect(stdout).toContain('Filling 0 unverified pairs across 0 nodes');
      expect(stdout).toContain('yg check: PASS');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // 1D-clear: the same all-draft source change with fresh log entries present
  // also fills cleanly (exit 0). An all-draft node produces no pairs, so the
  // fill is vacuously satisfied whether or not an entry exists — the entries
  // here just confirm their presence is harmless (no double-counting, no error).
  it('1D-clear: all-draft node with a fresh log entry fills cleanly (exit 0)', () => {
    const dir = deterministicFixture('status-indep-draft-clear');
    try {
      enableServiceLogRequired(dir);
      setAspectStatus(dir, 'no-todo-comments', 'draft');
      setAspectStatus(dir, 'requires-named-export', 'draft');
      writeFileSync(ordersFile(dir), readFileSync(ordersFile(dir), 'utf-8') + '\nexport const d = 4;\n', 'utf-8');
      // payments is also all-draft now; give it an entry too so the cold fill is
      // not blocked on the unrelated node.
      run(['log', 'add', '--node', 'services/payments', '--reason', 'draft-phase change recorded'], dir);
      run(['log', 'add', '--node', 'services/orders', '--reason', 'draft-phase change recorded'], dir);
      const { status, stdout, all } = run(['check', '--approve'], dir);
      expect(status).toBe(0);
      expect(all).not.toContain(GATE_FIRED);
      // All aspects draft → no pairs to fill → the run is clean.
      expect(stdout).toContain('yg check: PASS');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- 1E. log_required:false node: a source change needs NO entry (no-op gate) ---
  // The fixture's service type ships log_required:false. A source change with no
  // log entry and no log.md at all fills cleanly — the gate is a no-op.
  it('1E: log_required:false node — source change with no entry fills (exit 0, no log.md)', () => {
    const dir = deterministicFixture('lr-false-noop');
    try {
      // First fill (no entry) establishes a baseline.
      expect(run(['check', '--approve'], dir).status).toBe(0);

      // Source change, still no log entry.
      writeFileSync(ordersFile(dir), readFileSync(ordersFile(dir), 'utf-8') + '\nexport const e = 5;\n', 'utf-8');
      const { status, stdout, all } = run(['check', '--approve'], dir);
      expect(status).toBe(0);
      expect(stdout).toContain('[det] no-todo-comments on node:services/orders — approved');
      expect(all).not.toContain(GATE_FIRED);
      // No log.md was ever required or created.
      expect(existsSync(ordersLogPath(dir))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- 1F. A zero-mapped-source node never trips the gate (vacuous) ---
  // A service-typed node with NO `mapping:` key has zero source files. Even with
  // log_required:true the gate cannot fire (no source change to justify): the
  // node has no aspect pairs and no source fingerprint to change, so the fill is
  // vacuously clean and the gate never mentions it.
  it('1F: a zero-mapped-source node is vacuously satisfied at fill (exit 0, log_required:true)', () => {
    const dir = deterministicFixture('zero-source-vacuous');
    try {
      enableServiceLogRequired(dir);
      // A service-typed node with no mapping (zero mapped source files).
      const emptyDir = path.join(dir, '.yggdrasil', 'model', 'services', 'empty');
      mkdirSync(emptyDir, { recursive: true });
      writeFileSync(
        path.join(emptyDir, 'yg-node.yaml'),
        'name: EmptyService\ndescription: A service-typed node with no mapping — zero mapped source files.\ntype: service\n',
        'utf-8',
      );
      // Give the two mapped service nodes their cold-fill entries so the overall
      // run is green and the only node under test is the mapping-less one.
      run(['log', 'add', '--node', 'services/orders', '--reason', 'init'], dir);
      run(['log', 'add', '--node', 'services/payments', '--reason', 'init'], dir);

      const { status, all } = run(['check', '--approve'], dir);
      expect(status).toBe(0);
      // No source change is possible for `empty`, so the mandatory-log gate never
      // fires for it despite log_required:true on the type.
      expect(all).not.toContain("No fresh log entry for node 'services/empty'");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // =========================================================================
  // 2. LOG FORMAT EDGES — fence exemption + duplicate-datetime
  //
  // Each violation/exemption is APPENDED post-baseline so the append-only check
  // passes and the FORMAT validator is the gate that fires (or stays silent).
  // The format CODE surfaces via `yg check` (log-format); the per-line reason
  // detail surfaces via `yg log read`.
  // =========================================================================

  /**
   * Seed services/orders with one filled log baseline (deterministic-only,
   * hermetic). After this later post-baseline appends are validated by the
   * format check at `yg check` time.
   */
  function seedLogBaseline(dir: string, reason: string): void {
    expect(run(['log', 'add', '--node', 'services/orders', '--reason', reason], dir).status).toBe(0);
    expect(run(['check', '--approve'], dir).status).toBe(0);
  }

  // --- 2A. A level-2 heading INSIDE a code fence is NOT an entry header ---
  // validateFormat is CommonMark-fence-aware: a `## ` line inside a ``` fence is
  // body text, not a reserved level-2 header. So a fenced level-2 heading in an
  // entry body does NOT trip level2_header_in_body; check stays clean for it.
  it('2A: a level-2 heading wrapped in a code fence is not flagged — check stays clean for log (exit 0)', () => {
    const dir = deterministicFixture('fence-h2-exempt');
    try {
      seedLogBaseline(dir, 'base entry');
      appendFileSync(
        ordersLogPath(dir),
        '## [2027-01-01T00:00:00.000Z]\nbody line\n```\n## Stray top-level heading inside a fence\n```\nmore body\n',
      );
      const { status, all } = run(['check'], dir);
      expect(status).toBe(0);
      // The fenced heading does not trip the log-format gate.
      expect(all).not.toContain('log-format');
      expect(all).not.toContain('Log format invalid');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- 2B. A `## [datetime]` header line INSIDE a code fence is not a header ---
  // (to validateFormat). It does NOT become a duplicate/out-of-order entry, so
  // check stays clean. parseLog (used by `yg log read`) is fence-aware too, so
  // both agree on entry boundaries: the fenced line is body, not a separate entry.
  it('2B: a fenced `## [datetime]` line does not trip the format validator — check clean (exit 0)', () => {
    const dir = deterministicFixture('fence-datetime-exempt');
    try {
      seedLogBaseline(dir, 'base entry');
      appendFileSync(
        ordersLogPath(dir),
        '## [2027-03-03T00:00:00.000Z]\nreal body\n```\n## [2030-12-31T23:59:59.999Z]\n```\ntail\n',
      );
      const { status, all } = run(['check'], dir);
      expect(status).toBe(0);
      expect(all).not.toContain('log-format');
      expect(all).not.toContain('Log format invalid');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // parseLog (used by `yg log read`) is fence-aware, matching validateFormat:
  // fenced header lines are body, not entry headers. Both agree on entry
  // boundaries, so a fenced `## [datetime]` is never a separate entry.
  it('2B-fence: `yg log read` is fence-aware — a fenced `## [datetime]` is body, not a separate (newer) entry', () => {
    const dir = deterministicFixture('fence-datetime-read');
    try {
      seedLogBaseline(dir, 'base entry');
      appendFileSync(
        ordersLogPath(dir),
        '## [2027-03-03T00:00:00.000Z]\nreal body\n```\n## [2030-12-31T23:59:59.999Z]\n```\ntail\n',
      );
      // The fenced 2030-12-31 line belongs to the 2027-03-03 entry's body, it is
      // NOT a separate, newer entry. So the single newest entry is 2027-03-03.
      const { status, stdout } = run(['log', 'read', '--node', 'services/orders', '--top', '1'], dir);
      expect(status).toBe(0);
      expect(stdout.trimStart().startsWith('## [2027-03-03T00:00:00.000Z]')).toBe(true);
      expect(stdout.trimStart().startsWith('## [2030-12-31')).toBe(false);
      // The fenced datetime is present only inside that entry's body.
      expect(stdout).toContain('## [2030-12-31T23:59:59.999Z]');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- 2C. Duplicate-datetime detection ---
  // Two headers carrying the identical strict datetime → duplicate_datetime. The
  // format CODE surfaces via check; the duplicate-datetime reason detail surfaces
  // via read. Post-baseline (editable) zone.
  it('2C: two entries with the same datetime are rejected as duplicate_datetime (exit 1)', () => {
    const dir = deterministicFixture('dup-datetime');
    try {
      seedLogBaseline(dir, 'base entry');
      appendFileSync(
        ordersLogPath(dir),
        '## [2027-05-05T00:00:00.000Z]\nfirst dup\n## [2027-05-05T00:00:00.000Z]\nsecond dup\n',
      );
      const check = run(['check'], dir);
      expect(check.status).toBe(1);
      expect(check.all).toContain('log-format');
      expect(check.all).toContain('Log format invalid');

      const read = run(['log', 'read', '--node', 'services/orders'], dir);
      expect(read.status).toBe(1);
      expect(read.all).toContain('duplicate_datetime');
      expect(read.all).toContain("Datetime '2027-05-05T00:00:00.000Z' also appears at line");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // =========================================================================
  // 3. NODE-PATH SYNTAX REJECTION — add / read / merge-resolve
  //
  // The CLI strips a trailing slash and converts backslashes before calling the
  // core; the core then runs validateNodePath, which rejects `..` segments,
  // `model/` prefixes, and absolute paths (leading `/` or `<drive>:`). All three
  // log subcommands wrap a bad path as `Invalid --node value: <reason>`.
  // =========================================================================

  it('3A: log add rejects a `..` segment node path (exit 1)', () => {
    const dir = copyFixture('np-add-dotdot');
    try {
      const { status, all } = run(['log', 'add', '--node', '../escape', '--reason', 'x'], dir);
      expect(status).toBe(1);
      expect(all).toContain('Invalid --node value: Node path must not contain .. segments');
      expect(existsSync(ordersLogPath(dir))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('3B: log add rejects a `model/`-prefixed node path (exit 1)', () => {
    const dir = copyFixture('np-add-model');
    try {
      const { status, all } = run(['log', 'add', '--node', 'model/services/orders', '--reason', 'x'], dir);
      expect(status).toBe(1);
      expect(all).toContain('Invalid --node value: Node path must not start with model/');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('3C: log add rejects an absolute (leading-slash) node path (exit 1)', () => {
    const dir = copyFixture('np-add-abs');
    try {
      const { status, all } = run(['log', 'add', '--node', '/abs/path', '--reason', 'x'], dir);
      expect(status).toBe(1);
      expect(all).toContain('Invalid --node value: Node path must not be absolute (starts with /)');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('3D: log add rejects a drive-letter (Windows-absolute) node path (exit 1)', () => {
    const dir = copyFixture('np-add-drive');
    try {
      const { status, all } = run(['log', 'add', '--node', 'C:/foo/bar', '--reason', 'x'], dir);
      expect(status).toBe(1);
      expect(all).toContain('Invalid --node value: Node path must not be absolute (drive letter)');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('3E: log read rejects a `..` segment node path (exit 1)', () => {
    const dir = copyFixture('np-read-dotdot');
    try {
      const { status, all } = run(['log', 'read', '--node', 'a/../b'], dir);
      expect(status).toBe(1);
      expect(all).toContain('Invalid --node value: Node path must not contain .. segments');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('3F: log read normalizes backslashes then rejects the resulting `model/` prefix (exit 1)', () => {
    const dir = copyFixture('np-read-backslash');
    try {
      // Backslashes are converted to forward slashes before validation, so
      // `model\services\orders` becomes `model/services/orders` → model/ reject.
      const { status, all } = run(['log', 'read', '--node', 'model\\services\\orders'], dir);
      expect(status).toBe(1);
      expect(all).toContain('Invalid --node value: Node path must not start with model/');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('3G: log merge-resolve rejects a `model/`-prefixed node path before any git check (exit 1)', () => {
    const dir = copyFixture('np-mr-model');
    try {
      // No git repo is needed: validateNodePath runs before the merge-commit check.
      const { status, all } = run(['log', 'merge-resolve', '--node', 'model/x'], dir);
      expect(status).toBe(1);
      expect(all).toContain('Invalid --node value: Node path must not start with model/');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('3H: log merge-resolve rejects a `..` segment node path (exit 1)', () => {
    const dir = copyFixture('np-mr-dotdot');
    try {
      const { status, all } = run(['log', 'merge-resolve', '--node', 'a/../b'], dir);
      expect(status).toBe(1);
      expect(all).toContain('Invalid --node value: Node path must not contain .. segments');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // =========================================================================
  // 4. NODE-NOT-FOUND — valid syntax, node absent (per-subcommand message)
  // =========================================================================

  it('4A: log add on a nonexistent node returns a node-not-found message (exit 1)', () => {
    const dir = copyFixture('nf-add');
    try {
      const { status, all } = run(['log', 'add', '--node', 'services/ghost', '--reason', 'x'], dir);
      expect(status).toBe(1);
      expect(all).toContain('Node not found: services/ghost');
      expect(all).toContain('before log entries can be added');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('4B: log read on a nonexistent node returns a node-not-found message (exit 1)', () => {
    const dir = copyFixture('nf-read');
    try {
      const { status, all } = run(['log', 'read', '--node', 'services/ghost'], dir);
      expect(status).toBe(1);
      expect(all).toContain('Node not found: services/ghost');
      expect(all).toContain('before its log can be read');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('4C: log merge-resolve on a nonexistent node returns its node-not-found message (exit 1)', () => {
    const dir = copyFixture('nf-mr');
    try {
      // node-not-found fires before the merge-commit check, so no git repo needed.
      const { status, all } = run(['log', 'merge-resolve', '--node', 'services/ghost'], dir);
      expect(status).toBe(1);
      expect(all).toContain('Node not found: services/ghost');
      expect(all).toContain('before its log can be merge-resolved');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // =========================================================================
  // 5. MERGE-RESOLVE — additional paths the existing suites do not pin
  //   (base: happy / non-merge HEAD / tampered ancestor; extended: dropped /
  //    fabricated / altered). Here: missing log.md / conflict markers /
  //    chronological-order.
  // =========================================================================

  it('5A: merge-resolve on a merge commit with no log.md for the node is rejected (exit 1)', () => {
    // Merge topology exists, but services/orders never had a log.md.
    const repo = mkdtempSync(path.join(tmpdir(), 'yg-loggate-mr-nolog-'));
    try {
      cpSync(FIXTURE, repo, { recursive: true });
      git(repo, 'init -q -b main');
      git(repo, 'config user.email t@t.test');
      git(repo, 'config user.name Test');
      git(repo, 'add -A');
      git(repo, 'commit -qm ancestor');
      git(repo, 'checkout -qb feat1');
      writeFileSync(path.join(repo, 'marker1.txt'), 'x\n', 'utf-8');
      git(repo, 'add -A');
      git(repo, 'commit -qm feat1');
      git(repo, 'checkout -q main');
      git(repo, 'checkout -qb feat2 main');
      writeFileSync(path.join(repo, 'marker2.txt'), 'y\n', 'utf-8');
      git(repo, 'add -A');
      git(repo, 'commit -qm feat2');
      try {
        git(repo, 'merge --no-commit --no-ff feat1 -q');
      } catch {
        /* no conflict expected on disjoint marker files */
      }
      git(repo, 'add -A');
      git(repo, 'commit -qm "merge"');

      const { status, all } = run(['log', 'merge-resolve', '--node', 'services/orders'], repo);
      expect(status).toBe(1);
      expect(all).toContain('log.md not found for node services/orders');
      expect(all).toContain('this node has no log.md in the working tree');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('5B: merge-resolve rejects a log.md that still contains conflict markers (exit 1)', () => {
    // Resolved file keeps Git conflict markers around the two divergent entries.
    const withMarkers =
      ANCESTOR_LOG +
      '<<<<<<< HEAD\n' +
      P2_NEW +
      '=======\n' +
      P1_NEW +
      '>>>>>>> feat1\n';
    const repo = buildMergeRepo('conflict', withMarkers);
    try {
      const { status, all } = run(['log', 'merge-resolve', '--node', 'services/orders'], repo);
      expect(status).toBe(1);
      expect(all).toContain('log.md still contains conflict markers');
      expect(all).toContain('the merge conflict was not fully resolved');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('5C: merge-resolve rejects new entries that are out of chronological order (exit 1)', () => {
    // Both parent entries survive byte-for-byte (so missing/fabricated checks
    // pass), but feat2 (12:00) is placed BEFORE feat1 (11:00) after the ancestor.
    const repo = buildMergeRepo('chrono', ANCESTOR_LOG + P2_NEW + P1_NEW);
    try {
      const { status, all } = run(['log', 'merge-resolve', '--node', 'services/orders'], repo);
      expect(status).toBe(1);
      expect(all).toContain('New log entries are not in chronological order');
      expect(all).toContain('ordered by timestamp');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
