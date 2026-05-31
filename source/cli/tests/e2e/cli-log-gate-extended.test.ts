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
// Every scenario here is LLM-independent and network-free. Approve/check cases
// run on `deterministicFixture` (the LLM aspect `has-doc-comment` is stripped
// from the service type, so `yg approve` records only deterministic verdicts
// and never contacts a reviewer endpoint). The log add/read and merge-resolve
// cases never invoke the reviewer at all. No real host/port is dialed; no wall
// clock or random source is read in assertions (log timestamps are produced by
// the binary and read back, never compared to the current time). Each test
// works inside a fresh mkdtemp dir and removes it in a finally block; the
// committed fixture bytes are never mutated.
//
// SCOPE — this suite covers the LOG GATE semantics + remaining log/format/
// node-path paths NOT already pinned by the two existing log suites:
//   cli-log-integrity.test.ts pins: mandatory-gate basic refusal + the
//     log-add-then-approve pass that clears it; level-2 heading in a --reason
//     rejected / level-3 accepted; read --top 2 / --top 0; merge-resolve happy
//     path, non-merge HEAD, tampered ancestor prefix.
//   cli-log-integrity-extended.test.ts pins: append-only prefix_modified /
//     boundary_missing; format out_of_order / invalid_datetime / invalid_header
//     / unclosed_code_fence / level2_header_in_body (hand-written into the
//     file); log add symlink / hardlink / empty-reason / reason-file missing /
//     reason-file dir / reason-file multiline / both-flags; read --all /
//     --top NaN / --top+--all / no-log; merge-resolve dropped / fabricated /
//     altered parent entry.
// This file adds the gate-SEMANTICS gaps (cascade-only-no-entry, status
// independence, log_required:false no-op, zero-mapped-source vacuous), the
// fence-exemption + duplicate-datetime FORMAT edges, the node-path-SYNTAX
// rejection across all three log subcommands, and the merge-resolve
// node-not-found / log.md-missing / conflict-markers / chronological-order
// paths the existing suites miss.
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

/**
 * Flip the `service` node type's `log_required` from false (fixture default) to
 * true so the mandatory-log gate engages on a source change. Scans for the
 * service block specifically and only mutates its flag; the module block's flag
 * is left untouched. Mirrors enableServiceLogRequired in cli-log-integrity.
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
const baselinePath = (dir: string, node: string) =>
  path.join(dir, '.yggdrasil', '.drift-state', ...node.split('/')) + '.json';

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

describe.skipIf(!distExists)('CLI E2E — log gate semantics, format edges, node-path syntax, merge-resolve paths', () => {
  // =========================================================================
  // 1. GATE SEMANTICS — when a fresh log entry is (not) required
  // =========================================================================

  // --- 1A. Cascade-only re-approve needs NO new log entry (log_required:true) ---
  // A source change demands an entry; an UPSTREAM-only change (aspect check.mjs
  // edited) does not. The gate keys off a SOURCE change, not any drift.
  it('1A: cascade-only re-approve (log_required:true) needs no new log entry — passes (exit 0)', () => {
    const dir = deterministicFixture('cascade-only');
    try {
      enableServiceLogRequired(dir);
      // Seed both nodes with a log entry + baseline.
      expect(run(['log', 'add', '--node', 'services/orders', '--reason', 'init'], dir).status).toBe(0);
      expect(run(['approve', '--node', 'services/orders'], dir).status).toBe(0);
      expect(run(['log', 'add', '--node', 'services/payments', '--reason', 'init'], dir).status).toBe(0);
      expect(run(['approve', '--node', 'services/payments'], dir).status).toBe(0);

      const before = readFileSync(ordersLogPath(dir), 'utf-8');

      // Upstream cascade trigger — edit the aspect implementation, no source touch.
      appendFileSync(NO_TODO_CHECK(dir), '\n// cascade-trigger: trivial no-op comment\n');

      // The cascade is real: check reports drift and exits 1 before re-approve.
      const drifted = run(['check'], dir);
      expect(drifted.status).toBe(1);
      expect(drifted.stdout).toContain("aspect 'no-todo-comments' check.mjs changed");

      // Re-approve WITHOUT adding a new log entry — the gate does not fire.
      const reapprove = run(['approve', '--node', 'services/orders'], dir);
      expect(reapprove.status).toBe(0);
      expect(reapprove.stdout).toContain('Approved: services/orders');
      expect(reapprove.all).not.toContain('mandatory entry required when source files change');

      // The log was not mutated by the cascade re-approve.
      expect(readFileSync(ordersLogPath(dir), 'utf-8')).toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- 1B. A SOURCE change with log_required:true + no fresh entry → gate refuses ---
  // Distinct from the base suite's case (which has NO entry at all and never
  // approved): here the node already carries an approved baseline + an old log
  // entry, and a SECOND source change without a NEW entry must still be blocked.
  it('1B: a second source change with no fresh entry is refused by the gate (exit 1)', () => {
    const dir = deterministicFixture('gate-second-change');
    try {
      enableServiceLogRequired(dir);
      // First cycle: entry + approve establishes a log baseline.
      expect(run(['log', 'add', '--node', 'services/orders', '--reason', 'cycle one'], dir).status).toBe(0);
      writeFileSync(ordersFile(dir), readFileSync(ordersFile(dir), 'utf-8') + '\nexport const a = 1;\n', 'utf-8');
      expect(run(['approve', '--node', 'services/orders'], dir).status).toBe(0);

      // Second source change but the newest log entry is the already-baselined one.
      writeFileSync(ordersFile(dir), readFileSync(ordersFile(dir), 'utf-8') + '\nexport const b = 2;\n', 'utf-8');
      const { status, all } = run(['approve', '--node', 'services/orders'], dir);
      expect(status).toBe(1);
      expect(all).toContain('No log entry found — mandatory entry required when source files change');
      expect(all).toContain('src/services/orders.ts');
      expect(all).toContain("Node type 'service' has log_required: true");
      expect(all).toContain('yg log add --node services/orders');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- 1C. Gate INDEPENDENCE from aspect status (ADVISORY) ---
  // Every non-draft effective aspect is merely advisory, yet a source change
  // with no fresh entry still trips the gate. The gate depends only on
  // log_required + a source change, never on aspect status.
  it('1C: gate fires on a source change when every non-draft aspect is advisory (exit 1)', () => {
    const dir = deterministicFixture('status-indep-advisory');
    try {
      enableServiceLogRequired(dir);
      // Demote the only enforced aspect to advisory → all non-draft aspects are
      // advisory (requires-named-export already advisory; wip-rule is draft).
      setAspectStatus(dir, 'no-todo-comments', 'advisory');
      // First cycle with an entry so a baseline exists.
      expect(run(['log', 'add', '--node', 'services/orders', '--reason', 'init advisory'], dir).status).toBe(0);
      expect(run(['approve', '--node', 'services/orders'], dir).status).toBe(0);

      // Source change, no fresh entry.
      writeFileSync(ordersFile(dir), readFileSync(ordersFile(dir), 'utf-8') + '\nexport const c = 3;\n', 'utf-8');
      const { status, all } = run(['approve', '--node', 'services/orders'], dir);
      expect(status).toBe(1);
      expect(all).toContain('No log entry found — mandatory entry required when source files change');
      expect(all).toContain("Node type 'service' has log_required: true");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- 1D. Gate INDEPENDENCE from aspect status (ALL-DRAFT) — BUG ---
  //
  // BUG: contract vs actual.
  //   CONTRACT (agent-rules.md "Log management — workflow" + knowledge
  //   read log-management "Drift independence"): "a node whose every effective
  //   aspect is in draft still needs a log entry when its source changes (the
  //   reviewer is skipped for draft aspects, but the log gate is NOT)." The
  //   core approve algorithm honors this — src/core/approve.ts:163-167 runs the
  //   mandatory-log refusal inside the all-draft branch.
  //   ACTUAL: the CLI command short-circuits all-draft nodes BEFORE the core
  //   ever runs (src/cli/approve.ts:818-821): when !hasNonDraftEffectiveAspects
  //   it prints the all-draft message and process.exit(0) without invoking
  //   approveNode. So via `yg approve` the log gate is BYPASSED for an
  //   all-draft node: a source change with no fresh entry is silently
  //   "approved" (exit 0), no baseline written, no drift tracked. The core
  //   gate at approve.ts:163-167 is dead code from the CLI's perspective.
  //
  // This test pins the ACTUAL behavior. If the short-circuit is fixed to honor
  // the gate, flip the expectations to status 1 + the mandatory-log message.
  it('1D: BUG — all-draft node bypasses the log gate via CLI short-circuit (exit 0, no entry)', () => {
    const dir = deterministicFixture('status-indep-draft');
    try {
      enableServiceLogRequired(dir);
      // Drive EVERY effective aspect to draft.
      setAspectStatus(dir, 'no-todo-comments', 'draft');
      setAspectStatus(dir, 'requires-named-export', 'draft');
      // wip-rule is already draft in the fixture.

      // Source change, no log entry at all, no prior baseline.
      writeFileSync(ordersFile(dir), readFileSync(ordersFile(dir), 'utf-8') + '\nexport const d = 4;\n', 'utf-8');
      const { status, stdout } = run(['approve', '--node', 'services/orders'], dir);

      // ACTUAL: short-circuit wins — exit 0, all-draft message, gate not fired.
      expect(status).toBe(0);
      expect(stdout).toContain("Every effective aspect on node 'services/orders' has status 'draft'");
      expect(stdout).toContain('Reviewer skipped');
      expect(stdout).not.toContain('mandatory entry required when source files change');
      // Consistent with "no baseline written, no drift tracked".
      expect(existsSync(baselinePath(dir, 'services/orders'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- 1E. log_required:false node: a source change needs NO entry (no-op gate) ---
  // The fixture's service type ships log_required:false. A source change with no
  // log entry and no log.md at all approves cleanly — the gate is a no-op.
  it('1E: log_required:false node — source change with no entry approves (exit 0, no log.md)', () => {
    const dir = deterministicFixture('lr-false-noop');
    try {
      // First approve (no entry) establishes a baseline.
      expect(run(['approve', '--node', 'services/orders'], dir).status).toBe(0);

      // Source change, still no log entry.
      writeFileSync(ordersFile(dir), readFileSync(ordersFile(dir), 'utf-8') + '\nexport const e = 5;\n', 'utf-8');
      const { status, stdout, all } = run(['approve', '--node', 'services/orders'], dir);
      expect(status).toBe(0);
      expect(stdout).toContain('Approved: services/orders');
      expect(all).not.toContain('mandatory entry required when source files change');
      // No log.md was ever required or created.
      expect(existsSync(ordersLogPath(dir))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- 1F. First approve with ZERO mapped source files — gate vacuously satisfied ---
  // A service-typed node with NO `mapping:` key has zero source files. Even with
  // log_required:true the gate cannot fire (no source change to justify). The
  // CLI routes a mapping-less node through the parent-cascade path, which
  // reports "No cascade drift" and exits 0 — vacuously clean.
  it('1F: first approve of a zero-mapped-source node is vacuously satisfied (exit 0, log_required:true)', () => {
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

      const { status, stdout, all } = run(['approve', '--node', 'services/empty'], dir);
      expect(status).toBe(0);
      // No source change is possible, so the mandatory-log gate never fires
      // despite log_required:true on the type.
      expect(all).not.toContain('mandatory entry required when source files change');
      expect(stdout).toContain("parent node 'services/empty'");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // =========================================================================
  // 2. LOG FORMAT EDGES — fence exemption + duplicate-datetime
  //
  // Each violation/exemption is APPENDED post-baseline so the append-only check
  // passes and the FORMAT validator is the gate that fires (or stays silent).
  // =========================================================================

  /**
   * Seed services/orders with one approved log baseline (deterministic-aspect
   * approve, hermetic). After this the drift-state carries a `log` baseline, so
   * later post-baseline appends are validated by the format check on approve.
   */
  function seedLogBaseline(dir: string, reason: string): void {
    expect(run(['log', 'add', '--node', 'services/orders', '--reason', reason], dir).status).toBe(0);
    expect(run(['approve', '--node', 'services/orders'], dir).status).toBe(0);
  }

  // --- 2A. A level-2 heading INSIDE a code fence is NOT an entry header ---
  // validateFormat is CommonMark-fence-aware: a `## ` line inside a ``` fence is
  // body text, not a reserved level-2 header. So a fenced level-2 heading in an
  // entry body does NOT trip level2_header_in_body; approve succeeds.
  it('2A: a level-2 heading wrapped in a code fence is not flagged — approve passes (exit 0)', () => {
    const dir = deterministicFixture('fence-h2-exempt');
    try {
      seedLogBaseline(dir, 'base entry');
      appendFileSync(
        ordersLogPath(dir),
        '## [2027-01-01T00:00:00.000Z]\nbody line\n```\n## Stray top-level heading inside a fence\n```\nmore body\n',
      );
      const { status, stdout, all } = run(['approve', '--node', 'services/orders'], dir);
      expect(status).toBe(0);
      expect(stdout).toContain('Approved: services/orders');
      expect(all).not.toContain('level2_header_in_body');
      expect(all).not.toContain('Log format invalid');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- 2B. A `## [datetime]` header line INSIDE a code fence is not a header ---
  // (to validateFormat). It does NOT become a duplicate/out-of-order entry, so
  // approve passes. BUG: parseLog (used by `yg log read`) is NOT fence-aware, so
  // the same fenced header IS split into a spurious entry on read — see below.
  it('2B: a fenced `## [datetime]` line does not trip the format validator — approve passes (exit 0)', () => {
    const dir = deterministicFixture('fence-datetime-exempt');
    try {
      seedLogBaseline(dir, 'base entry');
      appendFileSync(
        ordersLogPath(dir),
        '## [2027-03-03T00:00:00.000Z]\nreal body\n```\n## [2030-12-31T23:59:59.999Z]\n```\ntail\n',
      );
      const { status, all } = run(['approve', '--node', 'services/orders'], dir);
      expect(status).toBe(0);
      expect(all).not.toContain('Log format invalid');
      expect(all).not.toContain('duplicate_datetime');
      expect(all).not.toContain('out_of_order');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // BUG: validateFormat (fence-aware) and parseLog (NOT fence-aware) disagree.
  //   CONTRACT (knowledge read log-management "Format constraints"): "a `## `
  //   that appears inside a fenced code block is allowed" — i.e. fenced header
  //   lines are body text, not entry headers.
  //   ACTUAL: src/core/log-format.ts honors the fence (the line is skipped while
  //   fenceOpen), but src/core/parsing/log-parser.ts splits on ANY `## [<dt>]`
  //   at column 0 regardless of fences. So `yg log read` — which validates with
  //   the fence-aware validator (clean) and then renders entries via the
  //   fence-UNaware parser — emits a SPURIOUS extra entry for the fenced
  //   datetime line. A log that validateFormat treats as 2 entries is rendered
  //   by `yg log read` as 3. This test pins the actual (divergent) read output.
  //   Fix would make parseLog fence-aware so both agree.
  it('2B-bug: `yg log read` splits a fenced `## [datetime]` into a spurious extra entry', () => {
    const dir = deterministicFixture('fence-datetime-readbug');
    try {
      seedLogBaseline(dir, 'base entry');
      appendFileSync(
        ordersLogPath(dir),
        '## [2027-03-03T00:00:00.000Z]\nreal body\n```\n## [2030-12-31T23:59:59.999Z]\n```\ntail\n',
      );
      const { status, stdout } = run(['log', 'read', '--node', 'services/orders', '--all'], dir);
      expect(status).toBe(0);
      // ACTUAL: the fenced datetime is rendered as its own entry header. There
      // are really two authored entries (the base + the 2027-03-03 one), but the
      // fence-unaware parser also surfaces the fenced 2030-12-31 line.
      expect(stdout).toContain('2030-12-31T23:59:59.999Z');
      const headerCount = stdout.split('\n').filter((l) => l.startsWith('## [')).length;
      expect(headerCount).toBe(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- 2C. Duplicate-datetime detection ---
  // Two headers carrying the identical strict datetime → duplicate_datetime. The
  // equal-datetime second header is also not strictly greater than the first, so
  // out_of_order co-fires; both are surfaced. Post-baseline (editable) zone.
  it('2C: two entries with the same datetime are rejected as duplicate_datetime (exit 1)', () => {
    const dir = deterministicFixture('dup-datetime');
    try {
      seedLogBaseline(dir, 'base entry');
      appendFileSync(
        ordersLogPath(dir),
        '## [2027-05-05T00:00:00.000Z]\nfirst dup\n## [2027-05-05T00:00:00.000Z]\nsecond dup\n',
      );
      const { status, all } = run(['approve', '--node', 'services/orders'], dir);
      expect(status).toBe(1);
      expect(all).toContain('Log format invalid');
      expect(all).toContain('duplicate_datetime');
      expect(all).toContain("Datetime '2027-05-05T00:00:00.000Z' also appears at line");
      expect(all).toContain('Post-baseline violation (editable)');
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
