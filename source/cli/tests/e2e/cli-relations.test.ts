import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
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
// Harness — duplicated here because e2e test files do not share a module.
// Pattern mirrors cli-deterministic-lifecycle.test.ts: spawn the REAL built
// binary against a fixture COPIED into a fresh mkdtemp dir, assert exit code
// plus stdout/stderr substrings. Every scenario is hermetic: fresh temp dir
// per test, rmSync cleanup in finally, no network host dependency, no clock
// or RNG reads in assertions.
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const FIXTURES = path.join(CLI_ROOT, 'tests', 'fixtures');

const SAMPLE = path.join(FIXTURES, 'sample-project');
const BROKEN_RELATION = path.join(FIXTURES, 'sample-project-broken-relation');
const LIFECYCLE = path.join(FIXTURES, 'e2e-lifecycle');

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

/** Copy any fixture directory into a fresh temp dir for mutation. */
function copyFixture(source: string, label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-rel-${label}-`));
  cpSync(source, dir, { recursive: true });
  return dir;
}

/**
 * Copy the e2e-lifecycle fixture and strip the LLM aspect (`has-doc-comment`)
 * so the `service` node type's effective aspects are purely deterministic.
 * This makes the approve/check lifecycle hermetic — no network, no LLM
 * verdict, fully reproducible. Mirrors deterministicFixture() in the lifecycle
 * suite.
 */
function deterministicLifecycleFixture(label: string): string {
  const dir = copyFixture(LIFECYCLE, label);
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

const ordersNodePath = (dir: string) =>
  path.join(dir, '.yggdrasil', 'model', 'services', 'orders', 'yg-node.yaml');
const paymentsNodePath = (dir: string) =>
  path.join(dir, '.yggdrasil', 'model', 'services', 'payments', 'yg-node.yaml');
const paymentsSrc = (dir: string) =>
  path.join(dir, 'src', 'services', 'payments.ts');

describe.skipIf(!distExists)('CLI E2E — architecture relation rules, event pairing, relational cascade', () => {
  // -------------------------------------------------------------------------
  // 1. relation-broken — a relation pointing at a node that does not exist.
  //    The sample-project-broken-relation fixture declares
  //    orders/broken-service -> nonexistent/missing-target (type: uses).
  // -------------------------------------------------------------------------
  it('1: relation-broken — check fails when a relation target does not exist', () => {
    const dir = copyFixture(BROKEN_RELATION, 'broken');
    try {
      const { status, stdout } = run(['check'], dir);
      expect(status).toBe(1);
      expect(stdout).toContain('relation-broken');
      // The unresolved target name as it appears in the fixture's yg-node.yaml.
      expect(stdout).toContain('nonexistent/missing-target');
      // It is attributed to the node that declares the broken relation.
      expect(stdout).toContain('orders/broken-service');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // 2. event-unpaired — an emits with no matching listens.
  //    sample-project pairs orders/order-service --emits order.created-->
  //    users/user-repo with users/user-repo --listens order.created-->
  //    orders/order-service. Removing the listens half leaves the emit
  //    unpaired.
  //
  //    NOTE ON ASSERTION: the binary's event-unpaired message identifies the
  //    pair by NODE PATHS ("emits to 'users/user-repo' but ... has no listens
  //    from ..."), it does NOT echo the event name in that line. So we assert
  //    on the stable error code plus both node paths — the substrings the
  //    binary actually emits — rather than on the event name string.
  // -------------------------------------------------------------------------
  it('2: event-unpaired — removing the listens half of an emits/listens pair fails check', () => {
    const dir = copyFixture(SAMPLE, 'event');
    try {
      const userRepoNode = path.join(
        dir,
        '.yggdrasil',
        'model',
        'users',
        'user-repo',
        'yg-node.yaml',
      );
      // Rewrite user-repo without the `listens order.created` relation block.
      writeFileSync(
        userRepoNode,
        [
          'name: UserRepo',
          'description: x',
          'type: repository',
          'mapping:',
          '- src/users/user.repository.ts',
          '',
        ].join('\n'),
        'utf-8',
      );

      const { status, stdout } = run(['check'], dir);
      expect(status).toBe(1);
      expect(stdout).toContain('event-unpaired');
      // Both ends of the now-unpaired event relation are named.
      expect(stdout).toContain('orders/order-service');
      expect(stdout).toContain('users/user-repo');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // 3. relation-target-forbidden — a relation pointing at a node whose TYPE
  //    the architecture does not allow as a target for that relation.
  //
  //    e2e-lifecycle architecture allows `service` to `uses: [service]` /
  //    `calls: [service]` only. The `services` parent node is type `module`,
  //    which is NOT an allowed target for a `uses` relation from a service.
  //    Pointing services/orders --uses--> services (module) is forbidden.
  // -------------------------------------------------------------------------
  it('3: relation-target-forbidden — uses pointing at a disallowed target type fails check', () => {
    const dir = deterministicLifecycleFixture('forbidden');
    try {
      writeFileSync(
        ordersNodePath(dir),
        [
          'name: OrdersService',
          'description: Creates and retrieves customer orders.',
          'type: service',
          'aspects:',
          '  - wip-rule',
          'relations:',
          // `services` is type `module`; `uses` only allows `service`.
          '  - target: services',
          '    type: uses',
          'mapping:',
          '  - src/services/orders.ts',
          '',
        ].join('\n'),
        'utf-8',
      );

      const { status, stdout } = run(['check'], dir);
      expect(status).toBe(1);
      expect(stdout).toContain('relation-target-forbidden');
      // Attributed to the declaring node and naming the forbidden relation.
      expect(stdout).toContain('services/orders');
      expect(stdout).toContain('uses');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // 4. high-fan-out — too many direct relations on a single node.
  //    sample-project's orders/order-service declares 3 relations. Lowering
  //    quality.max_direct_relations to 1 makes it exceed the threshold.
  //
  //    We assert the high-fan-out diagnostic appears. We deliberately do NOT
  //    over-assert the exit code: in this fixture the diagnostic surfaces as a
  //    blocking finding (non-zero exit), but the scenario only requires the
  //    warning to appear, so we just record that the exit code is non-null.
  // -------------------------------------------------------------------------
  it('4: high-fan-out — lowering max_direct_relations flags a node with multiple relations', () => {
    const dir = copyFixture(SAMPLE, 'fanout');
    try {
      const cfgPath = path.join(dir, '.yggdrasil', 'yg-config.yaml');
      const cfg = readFileSync(cfgPath, 'utf-8').replace(
        /max_direct_relations:\s*\d+/,
        'max_direct_relations: 1',
      );
      writeFileSync(cfgPath, cfg, 'utf-8');

      const { status, stdout } = run(['check'], dir);
      expect(stdout).toContain('high-fan-out');
      // The node that exceeds the fan-out limit is named.
      expect(stdout).toContain('orders/order-service');
      // Exit code is captured but not pinned to a specific value.
      expect(status).not.toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // 5. Structural dependency cascade.
  //    Wire services/orders --uses--> services/payments, approve both, then
  //    exercise the relational cascade.
  //
  //    IMPORTANT — actual binary behavior vs. the naive premise:
  //    Editing the dependency's mapped SOURCE (payments.ts) produces source
  //    drift on services/payments ONLY. It does NOT cascade to the dependent
  //    services/orders. This is intentional/scoped: the relational layer
  //    tracks the dependency target's yg-node.yaml metadata (and ports hash),
  //    NOT the dependency's source files (see source/cli/src/core/graph/
  //    files.ts — "Track dependency yg-node.yaml only"). So a source edit to a
  //    dependency never reaches its dependents.
  //
  //    The structural dependency cascade onto the dependent fires when the
  //    dependency's METADATA changes. This test documents both halves:
  //      (a) editing payments.ts => payments source drift, orders untouched;
  //      (b) changing payments yg-node.yaml metadata => orders cascade
  //          ("dependency 'services/payments' metadata changed"), cleared by
  //          re-approving services/orders, after which check is clean.
  // -------------------------------------------------------------------------
  it('5: structural dependency cascade — source edit drifts only the dependency; metadata change cascades to the dependent', () => {
    const dir = deterministicLifecycleFixture('cascade');
    try {
      // Wire orders --uses--> payments (allowed: service uses service).
      writeFileSync(
        ordersNodePath(dir),
        [
          'name: OrdersService',
          'description: Creates and retrieves customer orders.',
          'type: service',
          'aspects:',
          '  - wip-rule',
          'relations:',
          '  - target: services/payments',
          '    type: uses',
          'mapping:',
          '  - src/services/orders.ts',
          '',
        ].join('\n'),
        'utf-8',
      );

      // Approve both nodes; baseline check is clean.
      expect(run(['approve', '--node', 'services/orders'], dir).status).toBe(0);
      expect(run(['approve', '--node', 'services/payments'], dir).status).toBe(0);
      expect(run(['check'], dir).status).toBe(0);

      // --- (a) Edit the dependency's SOURCE. Adds a named export so no
      // enforced aspect is violated; the file simply changes. ---
      appendFileSync(
        paymentsSrc(dir),
        '\nexport function describePayment(p: Payment): string {\n  return p.orderId;\n}\n',
      );

      const afterSourceEdit = run(['check'], dir);
      expect(afterSourceEdit.status).toBe(1);
      // Source drift is reported on the edited dependency itself.
      expect(afterSourceEdit.stdout).toContain('services/payments');
      expect(afterSourceEdit.stdout).toContain('Source files changed');
      // The dependent is NOT dragged in by a source edit (scoped cascade).
      const orderLines = afterSourceEdit.stdout
        .split('\n')
        .filter((l) => l.includes('services/orders'));
      expect(orderLines.length).toBe(0);

      // Re-approving the edited dependency clears the drift.
      expect(run(['approve', '--node', 'services/payments'], dir).status).toBe(0);
      expect(run(['check'], dir).status).toBe(0);

      // --- (b) Change the dependency's METADATA. This is what actually
      // cascades onto the dependent. ---
      writeFileSync(
        paymentsNodePath(dir),
        [
          'name: PaymentsService',
          'description: Charges and refunds payments for orders (updated wording).',
          'type: service',
          'mapping:',
          '  - src/services/payments.ts',
          '',
        ].join('\n'),
        'utf-8',
      );

      const afterMetaChange = run(['check'], dir);
      expect(afterMetaChange.status).toBe(1);
      // The relational cascade fires on the dependent and names the dependency.
      expect(afterMetaChange.stdout).toContain('cascade');
      expect(afterMetaChange.stdout).toContain(
        "dependency 'services/payments' metadata changed",
      );
      expect(afterMetaChange.stdout).toContain('services/orders');

      // Re-approving the dependent clears the cascade; final check is clean.
      expect(run(['approve', '--node', 'services/orders'], dir).status).toBe(0);
      expect(run(['check'], dir).status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // 6. yg context --node — a node with relations lists its relation targets.
  //    sample-project's orders/order-service declares three relations.
  // -------------------------------------------------------------------------
  it('6: context --node lists a node\'s relation targets', () => {
    const dir = copyFixture(SAMPLE, 'context');
    try {
      const { status, stdout } = run(
        ['context', '--node', 'orders/order-service'],
        dir,
      );
      expect(status).toBe(0);
      // The relation targets and their relation types are listed.
      expect(stdout).toContain('auth/auth-api');
      expect(stdout).toContain('users/user-repo');
      expect(stdout).toContain('uses');
      expect(stdout).toContain('emits');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
