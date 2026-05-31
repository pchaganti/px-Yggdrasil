import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  cpSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// DRIFT & CASCADE — extended paths.
//
// Covers the remaining drift/cascade behaviours that the existing suites do
// not exercise:
//   * CROSS-NODE check-touched cascade — a graph-aware deterministic aspect on
//     node A reads a file owned by node B (reachable via a declared `uses`
//     relation). Editing B's file drifts A, and re-approving A re-runs ONLY
//     that one local check at zero LLM cost.
//   * BATCH approve partial-failure INDEPENDENCE — A and C approve while the
//     middle node B refuses; one failure does not abort its siblings.
//   * Cascade-only re-approve needs NO new log entry (on a log_required node).
//   * All-draft node — a node whose only effective aspect is draft is skipped
//     by drift detection entirely, even after a source edit.
//   * Multiple SIMULTANEOUS cascade causes on one node, all surfaced, cleared
//     by one batch approve.
//   * Partial mapping deletion — one of several mapped files removed surfaces
//     mapping-path-missing + source drift; restoring it clears both.
//   * No-change re-approve — a zero-LLM no-op that prints `No changes:`.
//
// Harness REUSED VERBATIM from cli-deterministic-lifecycle.test.ts: the
// run(args, cwd) spawnSync wrapper, BIN_PATH resolution, the distExists guard
// with describe.skipIf(!distExists), the copyFixture/mkdtemp helpers, the
// deterministicFixture (strip the LLM `has-doc-comment` aspect) helper, and the
// killReviewer/dead-endpoint pattern. Each test builds its graph in a FRESH
// mkdtemp copy of the committed e2e-lifecycle fixture, mutates only that copy
// (zero committed bytes change), and rmSync's it in a finally. Fully hermetic:
// no network host/port, no clock reads, no random sources inside assertions.
// Every refuse/pass is driven solely by the deterministic check.mjs aspects
// (`no-todo-comments` enforced, `requires-named-export` advisory, `wip-rule`
// draft) plus authored-in graph-aware aspects.
//
// check-touched SETTLE step (mirrors cli-tier-cascade): a deterministic
// aspect's `check-touched:<id>` synthetic keys and its cross-node touched paths
// are derived from the recorded checkTouchedFiles set, which is folded into the
// per-node drift hash only on a SUBSEQUENT approve. So a node carrying a
// graph-aware cross-node check is approved TWICE before mutating the cross-node
// file, isolating the cross-node-content drift signal.
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'e2e-lifecycle');

const distExists = existsSync(BIN_PATH);

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
  const dir = mkdtempSync(path.join(tmpdir(), `yg-dcx-${label}-`));
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

/**
 * Copy the fixture and strip the LLM aspect (`has-doc-comment`) so every node's
 * effective aspects are purely deterministic. This makes the lifecycle hermetic:
 * no network, no LLM verdict, fully reproducible — only deterministic check.mjs
 * runs drive every refuse/pass/cascade outcome.
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
const paymentsFile = (dir: string) => path.join(dir, 'src', 'services', 'payments.ts');
const archPath = (dir: string) => path.join(dir, '.yggdrasil', 'yg-architecture.yaml');
const parentNodeYaml = (dir: string) =>
  path.join(dir, '.yggdrasil', 'model', 'services', 'yg-node.yaml');
const ordersNodeYaml = (dir: string) =>
  path.join(dir, '.yggdrasil', 'model', 'services', 'orders', 'yg-node.yaml');
const noTodoCheckMjs = (dir: string) =>
  path.join(dir, '.yggdrasil', 'aspects', 'no-todo-comments', 'check.mjs');

// A graph-aware deterministic aspect that reaches the DEPENDENCY node
// 'services/payments' (declared via a `uses` relation on orders) and flags a
// TODO marker in any of its files. Reading a cross-node file is what records a
// cross-node check-touched path in orders' baseline.
const CROSS_READ_TODO_CHECK = `export function check(ctx) {
  const violations = [];
  const dep = ctx.graph.node('services/payments');
  if (!dep) return violations;
  for (const file of dep.files) {
    if (file.content.includes('TODO')) {
      violations.push({
        file: file.path,
        line: 1,
        column: 0,
        message: \`Dependency file \${file.path} contains a TODO marker.\`,
      });
    }
  }
  return violations;
}
`;

/** Author the cross-read-todo deterministic aspect into the temp graph. */
function writeCrossReadAspect(dir: string): void {
  const aspectDir = path.join(dir, '.yggdrasil', 'aspects', 'cross-read-todo');
  mkdirSync(aspectDir, { recursive: true });
  writeFileSync(
    path.join(aspectDir, 'yg-aspect.yaml'),
    [
      'name: CrossReadTodo',
      'description: The dependency services/payments must not contain a TODO marker.',
      'reviewer:',
      '  type: deterministic',
      'status: enforced',
      '',
    ].join('\n'),
    'utf-8',
  );
  writeFileSync(path.join(aspectDir, 'check.mjs'), CROSS_READ_TODO_CHECK, 'utf-8');
}

/**
 * Rewrite orders' yg-node.yaml to KEEP the draft `wip-rule` (so it stays
 * referenced — no orphaned-aspect warning), declare a `uses` relation to
 * services/payments (widening the allowed-reads boundary so the cross-node
 * check can reach it), and attach the cross-read-todo aspect.
 */
function wireOrdersToPayments(dir: string): void {
  writeFileSync(
    ordersNodeYaml(dir),
    [
      'name: OrdersService',
      'description: Creates and retrieves customer orders.',
      'type: service',
      'aspects:',
      '  - wip-rule',
      '  - cross-read-todo',
      'relations:',
      '  - type: uses',
      '    target: services/payments',
      'mapping:',
      '  - src/services/orders.ts',
      '',
    ].join('\n'),
    'utf-8',
  );
}

describe.skipIf(!distExists)('CLI E2E — drift & cascade extended paths', () => {
  // -------------------------------------------------------------------------
  // 1. CROSS-NODE check-touched cascade.
  //
  // A graph-aware deterministic aspect on services/orders reads a file owned by
  // services/payments (reachable via a declared `uses` relation). Editing the
  // payments file drifts orders, and re-approving orders re-runs ONLY the one
  // cross-read check (zero LLM — it is deterministic). After re-approving both
  // nodes, check returns green.
  //
  // The cross-node check-touched cascade: a touched path whose CONTENT (not the set
  // membership) changes is tracked under the 'check-touched' file layer, which
  // describeCascadeCause() renders as "a file read by a deterministic aspect
  // changed". The specific aspect id is named only when the SET of touched paths
  // changes (the synthetic "check-touched:<id>" hash on the 'aspects' layer); on a
  // content edit we have only the path, so the message is accurate but not aspect-
  // specific. The STRUCTURAL contract holds and IS asserted: the cross-node edit
  // drifts the dependent node, and re-approve re-runs only that one local
  // deterministic check ("1 aspects satisfied", zero LLM).
  // -------------------------------------------------------------------------

  it('1: editing a file owned by node B drifts node A whose deterministic check reads it cross-node; re-approve re-runs only that local check (zero LLM) and clears it', () => {
    const dir = deterministicFixture('cross');
    try {
      writeCrossReadAspect(dir);
      wireOrdersToPayments(dir);

      // Approve payments first (dependency), then orders TWICE so the cross-node
      // check-touched set is settled into orders' baseline.
      expect(run(['approve', '--node', 'services/payments'], dir).status).toBe(0);
      expect(run(['approve', '--node', 'services/orders'], dir).status).toBe(0);
      expect(run(['approve', '--node', 'services/orders'], dir).status).toBe(0);
      // Settled: no orphan warning (wip-rule kept), no residual drift.
      expect(run(['check'], dir).status).toBe(0);

      // Edit the CROSS-NODE file (owned by services/payments). A benign,
      // non-TODO change keeps the cross-read check passing but changes the
      // tracked content hash → orders drifts via the cross-node check-touched
      // path; payments drifts as ordinary source drift.
      appendFileSync(paymentsFile(dir), '\n// benign cross-node edit\n');

      const drifted = run(['check'], dir);
      expect(drifted.status).toBe(1);
      // The dependent node services/orders IS drifted by the cross-node edit.
      expect(drifted.all).toContain('services/orders');
      expect(drifted.all).toContain('Fix: yg approve --node services/orders');
      // The orders cascade names the deterministic-aspect read cause; the specific
      // aspect id is not named on a content edit (only on a set-membership change).
      expect(drifted.all).toContain('a file read by a deterministic aspect changed');
      expect(drifted.all).not.toContain('cross-read-todo');
      // payments itself shows ordinary source drift.
      expect(drifted.all).toContain('services/payments');

      // Re-approve the dependency, then the dependent. Orders' re-approve runs
      // ONLY the one local deterministic check (the others carry forward) — the
      // "1 aspects satisfied" line proves a single-aspect, zero-LLM re-run.
      expect(run(['approve', '--node', 'services/payments'], dir).status).toBe(0);
      const reapproveOrders = run(['approve', '--node', 'services/orders'], dir);
      expect(reapproveOrders.status).toBe(0);
      expect(reapproveOrders.all).toContain('Approved: services/orders — 1 aspects satisfied.');

      // The cross-node cascade is gone — check is green again.
      const cleared = run(['check'], dir);
      expect(cleared.status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // 2. BATCH approve partial-failure INDEPENDENCE.
  //
  // `yg approve --node A --node B --node C` where B violates an enforced aspect:
  // A and C approve, B refuses, overall exit 1, and EVERY per-node result is
  // printed — one failure does not abort the siblings.
  // -------------------------------------------------------------------------

  it('2: batch approve — A and C approve, the middle node B refuses; exit 1, all per-node results printed (independence)', () => {
    const dir = deterministicFixture('batch');
    try {
      // Author a third service node, services/inventory (clean), so we have A, B, C.
      const invDir = path.join(dir, '.yggdrasil', 'model', 'services', 'inventory');
      mkdirSync(invDir, { recursive: true });
      writeFileSync(
        path.join(invDir, 'yg-node.yaml'),
        [
          'name: InventoryService',
          'description: Tracks stock levels for products.',
          'type: service',
          'mapping:',
          '  - src/services/inventory.ts',
          '',
        ].join('\n'),
        'utf-8',
      );
      writeFileSync(
        path.join(dir, 'src', 'services', 'inventory.ts'),
        [
          '// Inventory service — tracks stock levels.',
          'export interface Stock {',
          '  sku: string;',
          '  qty: number;',
          '}',
          'export function setStock(sku, qty) {',
          '  return { sku, qty };',
          '}',
          '',
        ].join('\n'),
        'utf-8',
      );

      // B = services/payments violates the enforced no-todo-comments aspect.
      appendFileSync(paymentsFile(dir), '\n// TODO: middle node violates on purpose\n');

      const batch = run(
        [
          'approve',
          '--node',
          'services/orders',
          '--node',
          'services/payments',
          '--node',
          'services/inventory',
        ],
        dir,
      );
      // Overall exit 1 because at least one node failed.
      expect(batch.status).toBe(1);
      // A and C approved — their results are printed.
      expect(batch.all).toContain('Approved: services/orders');
      expect(batch.all).toContain('Approved: services/inventory');
      // B refused — its result is printed too (not aborted by being in the middle).
      expect(batch.all).toContain('no-todo-comments — NOT SATISFIED');
      // The grouped summary reflects the independent per-node outcomes.
      expect(batch.all).toContain('2 approved, 1 failed');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // 3. Cascade-only re-approve needs NO new log entry.
  //
  // On a node type with log_required: true, a SOURCE change without a fresh log
  // entry fails approve with the mandatory-log error. But a cascade-only
  // re-approve (upstream-only drift, source unchanged) succeeds with NO new log
  // entry. Both halves are asserted to make the distinction load-bearing.
  // -------------------------------------------------------------------------

  it('3: cascade-only re-approve succeeds with NO new log entry (while a source change on the same log_required node would require one)', () => {
    const dir = deterministicFixture('nolog');
    try {
      // Flip the service node type to log_required: true. The `service:` type
      // key is indented 2 spaces, its fields 4 spaces (matched via \x20{n}).
      const arch = readFileSync(archPath(dir), 'utf-8').replace(
        /(\x20{2}service:\n\x20{4}description: [^\n]*\n)\x20{4}log_required: false/,
        '$1    log_required: true',
      );
      writeFileSync(archPath(dir), arch, 'utf-8');

      // Half A — a SOURCE change with no log entry fails the mandatory-log gate.
      appendFileSync(ordersFile(dir), '\n// benign source edit needing a log\n');
      const noLog = run(['approve', '--node', 'services/orders'], dir);
      expect(noLog.status).toBe(1);
      expect(noLog.all).toContain('No log entry found');
      expect(noLog.all).toContain('log_required: true');

      // Provide the log entry, then approve both nodes to settle clean baselines.
      run(['log', 'add', '--node', 'services/orders', '--reason', 'initial baseline for orders service'], dir);
      run(['log', 'add', '--node', 'services/payments', '--reason', 'initial baseline for payments service'], dir);
      expect(run(['approve', '--node', 'services/orders'], dir).status).toBe(0);
      expect(run(['approve', '--node', 'services/payments'], dir).status).toBe(0);
      expect(run(['check'], dir).status).toBe(0);

      // Half B — trigger an aspect-content cascade (upstream-only; no source
      // change). Re-approving via --aspect needs NO fresh log entry and succeeds.
      appendFileSync(noTodoCheckMjs(dir), '\n// cascade no-op comment\n');
      const cascade = run(['check'], dir);
      expect(cascade.status).toBe(1);
      expect(cascade.all).toContain('cascade');

      const reapprove = run(['approve', '--aspect', 'no-todo-comments'], dir);
      // No mandatory-log error — cascade-only re-approve is exempt.
      expect(reapprove.status).toBe(0);
      expect(reapprove.all).not.toContain('No log entry found');
      expect(reapprove.all).toContain('2 approved');
      expect(run(['check'], dir).status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // 4. ALL-DRAFT node — skipped by drift detection entirely.
  //
  // A node whose ONLY effective aspect is draft is never flagged unapproved and
  // never drifts, even after a source edit. Authored as a new `widget` node
  // type with no default aspects, carrying only the draft `wip-rule`.
  // -------------------------------------------------------------------------

  it('4: an all-draft node is skipped by check — never unapproved, no drift even after a source edit', () => {
    const dir = deterministicFixture('alldraft');
    try {
      // Add a `widget` node type with NO default aspects.
      appendFileSync(
        archPath(dir),
        [
          '',
          '  widget:',
          "    description: 'A widget whose only effective aspect is draft.'",
          '    log_required: false',
          '    when:',
          '      path: "src/widgets/**"',
          '    parents: [module]',
          '',
        ].join('\n'),
      );
      // Parent module + the all-draft widget node (only wip-rule, which is draft).
      mkdirSync(path.join(dir, '.yggdrasil', 'model', 'widgets', 'gadget'), { recursive: true });
      mkdirSync(path.join(dir, 'src', 'widgets'), { recursive: true });
      writeFileSync(
        path.join(dir, '.yggdrasil', 'model', 'widgets', 'yg-node.yaml'),
        ['name: Widgets', 'description: Organizational parent grouping widgets.', 'type: module', ''].join('\n'),
        'utf-8',
      );
      writeFileSync(
        path.join(dir, '.yggdrasil', 'model', 'widgets', 'gadget', 'yg-node.yaml'),
        [
          'name: Gadget',
          'description: A widget whose only effective aspect is draft.',
          'type: widget',
          'aspects:',
          '  - wip-rule',
          'mapping:',
          '  - src/widgets/gadget.ts',
          '',
        ].join('\n'),
        'utf-8',
      );
      const gadgetFile = path.join(dir, 'src', 'widgets', 'gadget.ts');
      writeFileSync(
        gadgetFile,
        ['// Gadget widget — only a draft aspect applies here.', "export const gadget = { name: 'gadget' };", ''].join('\n'),
        'utf-8',
      );

      // Approve the two real service nodes so the only NON-clean signal would be
      // the gadget — if it drifted. It must not.
      expect(run(['approve', '--node', 'services/orders'], dir).status).toBe(0);
      expect(run(['approve', '--node', 'services/payments'], dir).status).toBe(0);

      // The all-draft gadget node is NEVER approved, yet check is green — it is
      // not flagged `unapproved` and carries no drift.
      const before = run(['check'], dir);
      expect(before.status).toBe(0);
      expect(before.all).not.toContain('widgets/gadget');

      // Edit the gadget's source — still no drift (its only aspect is draft).
      appendFileSync(gadgetFile, '\n// edited; no non-draft aspect cares\n');
      const after = run(['check'], dir);
      expect(after.status).toBe(0);
      expect(after.all).not.toContain('widgets/gadget');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // 5. MULTIPLE SIMULTANEOUS cascade causes on one node.
  //
  // A source edit + an aspect-content edit + a parent-metadata change applied at
  // once all surface for services/orders. The aspect/parent causes also cascade
  // to the sibling services/payments (they share the parent + the aspect), so
  // one BATCH approve of both nodes clears every cause in a single invocation.
  // -------------------------------------------------------------------------

  it('5: source edit + aspect-content edit + parent change at once all surface; one batch approve clears them', () => {
    const dir = deterministicFixture('multi');
    try {
      expect(run(['approve', '--node', 'services/orders'], dir).status).toBe(0);
      expect(run(['approve', '--node', 'services/payments'], dir).status).toBe(0);
      expect(run(['check'], dir).status).toBe(0);

      // Three simultaneous causes (all benign — re-approve must succeed):
      appendFileSync(ordersFile(dir), '\n// benign source edit\n'); // source drift (orders only)
      appendFileSync(noTodoCheckMjs(dir), '\n// aspect tweak\n'); // aspect-content cascade
      appendFileSync(parentNodeYaml(dir), '\n# parent metadata tweak\n'); // parent-change cascade

      const drifted = run(['check'], dir);
      expect(drifted.status).toBe(1);
      // All three causes are surfaced.
      expect(drifted.all).toContain('Source files changed since last approve.'); // source drift
      expect(drifted.all).toContain("aspect 'no-todo-comments' check.mjs changed"); // aspect cascade
      expect(drifted.all).toContain("parent node 'services' metadata changed"); // parent cascade
      // The source-drifted node is named.
      expect(drifted.all).toContain('services/orders');

      // One batch approve of both affected nodes clears every cause at once.
      const batch = run(['approve', '--node', 'services/orders', '--node', 'services/payments'], dir);
      expect(batch.status).toBe(0);
      expect(batch.all).toContain('2 approved');
      expect(run(['check'], dir).status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // 6. PARTIAL mapping deletion.
  //
  // A node mapping several files loses ONE of them on disk: check reports
  // mapping-path-missing (plus source drift). Restoring the file with identical
  // content clears both with no re-approve (the byte-identical hash matches the
  // baseline).
  // -------------------------------------------------------------------------

  it('6: deleting one of several mapped files surfaces mapping-path-missing + source drift; restoring it clears both', () => {
    const dir = deterministicFixture('partial-del');
    try {
      // orders maps TWO files.
      writeFileSync(
        ordersNodeYaml(dir),
        [
          'name: OrdersService',
          'description: Creates and retrieves customer orders.',
          'type: service',
          'aspects:',
          '  - wip-rule',
          'mapping:',
          '  - src/services/orders.ts',
          '  - src/services/orders-helpers.ts',
          '',
        ].join('\n'),
        'utf-8',
      );
      const helpersFile = path.join(dir, 'src', 'services', 'orders-helpers.ts');
      const helpersContent = [
        '// Orders helpers — secondary mapped file.',
        'export function fmtOrderId(id) {',
        '  return `ORD-${id}`;',
        '}',
        '',
      ].join('\n');
      writeFileSync(helpersFile, helpersContent, 'utf-8');

      expect(run(['approve', '--node', 'services/orders'], dir).status).toBe(0);
      expect(run(['approve', '--node', 'services/payments'], dir).status).toBe(0);
      expect(run(['check'], dir).status).toBe(0);

      // Delete ONE of the two mapped files.
      rmSync(helpersFile, { force: true });
      const drifted = run(['check'], dir);
      expect(drifted.status).toBe(1);
      expect(drifted.all).toContain('mapping-path-missing');
      expect(drifted.all).toContain("Mapping path 'src/services/orders-helpers.ts' does not exist on disk.");
      // The deletion also changes the node's source hash → source drift.
      expect(drifted.all).toContain('Source files changed since last approve.');

      // Restore the file with identical content — both issues clear (the
      // byte-identical hash matches the recorded baseline; no re-approve needed).
      writeFileSync(helpersFile, helpersContent, 'utf-8');
      const recovered = run(['check'], dir);
      expect(recovered.status).toBe(0);
      expect(recovered.all).not.toContain('mapping-path-missing');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // 7. NO-CHANGE re-approve — a zero-LLM no-op.
  //
  // Re-running approve on a node with no source change and no upstream change
  // records nothing new and prints the `No changes:` verdict, exit 0.
  //
  // SETTLE: the per-node baseline is FULLY SETTLED by a SINGLE approve — the
  // first approve folds the deterministic aspects' check-touched synthetic keys
  // into both state.hash AND state.files, so no redundant second approve is
  // needed. The very next approve against the unchanged, settled baseline is the
  // true no-op.
  // -------------------------------------------------------------------------

  it('7: re-approving an unchanged node is a no-op after a SINGLE approve — prints "No changes:" and exits 0', () => {
    const dir = deterministicFixture('nochange');
    try {
      // #1 — initial baseline, fully settled in ONE pass (check-touched keys
      // folded into state.files, not just state.hash).
      const first = run(['approve', '--node', 'services/orders'], dir);
      expect(first.status).toBe(0);
      expect(first.all).toContain('Approved: services/orders (initial)');

      // #2 — nothing changed and the baseline is already settled: the true no-op.
      const second = run(['approve', '--node', 'services/orders'], dir);
      expect(second.status).toBe(0);
      expect(second.all).toContain('No changes: services/orders');
      // A no-op does NOT re-record an initial baseline or re-run the aspects.
      expect(second.all).not.toContain('Approved: services/orders (initial)');
      expect(second.all).not.toContain('aspects satisfied');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
