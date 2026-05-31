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
// FLOWS — remaining paths not covered by cli-flow-channel5 (basic propagation,
// descendant, --flow batch, flows listing) or cli-flows-advanced (conditional /
// advisory / draft flow aspect + flow-SET cascade via aspects:/nodes:). This
// suite pins:
//
//   M*  MULTIPLE flow aspects propagating INDEPENDENTLY — two distinct flow
//       aspects both reach BOTH participants and are each SEPARATELY
//       enforceable (every other fixture/suite uses exactly one flow aspect).
//   D*  yg approve --flow --dry-run — REJECTED (no batch preview mode); and the
//       single-node --dry-run preview shows a flow-delivered aspect WITHOUT
//       writing a baseline.
//   C*  NEW CHILD of a participant auto-included AFTER a baseline exists — the
//       flow aspect surfaces newly-active on the child (via parent), check
//       reports it, approve enforces it.
//   R*  PARTICIPANT REMOVAL — dropping a participant from nodes: drops the flow
//       aspect from it (effective-aspect change asserted) and cascades a
//       re-approve, which clears.
//   P*  Flow YAML PARSE/validation errors via the spawned binary — empty nodes,
//       missing nodes key, non-string node entry, missing name, missing
//       description (the one that is a VALIDATION finding, not a parse throw).
//   L*  yg flows for a graph with NO flows (empty), and with MULTIPLE flows
//       (sorted listing). Also `participants:` alias.
//   X   yg impact --node + --flow mutex (cli-impact pins --node/--aspect and
//       --flow/--aspect, but NOT --node/--flow).
//
// HERMETIC: every test copies the committed e2e-lifecycle fixture into a fresh
// mkdtemp, mutates ONLY that copy, and rmSync's it in `finally`. The LLM aspect
// (`has-doc-comment`) is stripped so the reviewer endpoint is never contacted —
// only deterministic check.mjs aspects drive every outcome. No network, no
// clock, no randomness in any assertion. Harness (run / copyFixture / the
// distExists guard) duplicated verbatim from cli-deterministic-lifecycle.test.ts.
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
  const dir = mkdtempSync(path.join(tmpdir(), `yg-flowext-${label}-`));
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

/**
 * Copy the fixture and strip the LLM aspect (`has-doc-comment`) so every node's
 * effective aspects are purely deterministic. No reviewer endpoint is ever
 * contacted, so the suite is hermetic and reproducible.
 */
function deterministicFixture(label: string): string {
  const dir = copyFixture(label);
  const arch = readFileSync(archPath(dir), 'utf-8')
    .split('\n')
    .filter((line) => line.trim() !== '- has-doc-comment')
    .join('\n');
  writeFileSync(archPath(dir), arch, 'utf-8');
  rmSync(path.join(dir, '.yggdrasil', 'aspects', 'has-doc-comment'), {
    recursive: true,
    force: true,
  });
  return dir;
}

// --- path helpers (operate on the temp COPY only) ---------------------------

const archPath = (dir: string) => path.join(dir, '.yggdrasil', 'yg-architecture.yaml');
const flowPath = (dir: string) =>
  path.join(dir, '.yggdrasil', 'flows', 'order-processing', 'yg-flow.yaml');
const ordersFile = (dir: string) => path.join(dir, 'src', 'services', 'orders.ts');
const paymentsFile = (dir: string) => path.join(dir, 'src', 'services', 'payments.ts');
const aspectDir = (dir: string, id: string) => path.join(dir, '.yggdrasil', 'aspects', id);
const baselinePath = (dir: string, node: string) =>
  path.join(dir, '.yggdrasil', '.drift-state', ...node.split('/')) + '.json';

/**
 * Strip `no-todo-comments` from the `service` architecture-type defaults so the
 * flow becomes the SOLE channel delivering it. `requires-named-export` stays as
 * the type default (every fixture source already satisfies it).
 */
function dropNoTodoFromServiceDefault(dir: string): void {
  const arch = readFileSync(archPath(dir), 'utf-8')
    .split('\n')
    .filter((line) => line.trim() !== '- no-todo-comments')
    .join('\n');
  writeFileSync(archPath(dir), arch, 'utf-8');
}

/**
 * Write a tiny deterministic aspect that flags any line containing `token`. The
 * token is chosen so the committed fixture sources NEVER contain it — a fresh
 * approve passes until the test deliberately introduces the token.
 */
function writeTokenAspect(dir: string, id: string, token: string): void {
  const d = aspectDir(dir, id);
  mkdirSync(d, { recursive: true });
  writeFileSync(
    path.join(d, 'yg-aspect.yaml'),
    [
      `name: ${id}`,
      `description: Source files must not contain the ${token} token.`,
      'reviewer:',
      '  type: deterministic',
      'status: enforced',
      '',
    ].join('\n'),
    'utf-8',
  );
  writeFileSync(
    path.join(d, 'check.mjs'),
    [
      'export function check(ctx) {',
      '  const violations = [];',
      '  for (const file of ctx.files) {',
      '    const lines = file.content.split(String.fromCharCode(10));',
      '    for (let i = 0; i < lines.length; i++) {',
      `      if (lines[i].includes(${JSON.stringify(token)})) {`,
      `        violations.push({ file: file.path, line: i + 1, column: 0, message: ${JSON.stringify(
        `${token} token found.`,
      )} });`,
      '      }',
      '    }',
      '  }',
      '  return violations;',
      '}',
      '',
    ].join('\n'),
    'utf-8',
  );
}

/** Overwrite the order-processing flow file with the given nodes + aspects YAML. */
function writeFlow(dir: string, nodesYaml: string[], aspectsYaml: string[]): void {
  writeFileSync(
    flowPath(dir),
    [
      'name: OrderProcessing',
      'description: End-to-end processing of a customer order, from creation through payment.',
      'nodes:',
      ...nodesYaml,
      'aspects:',
      ...aspectsYaml,
      '',
    ].join('\n'),
    'utf-8',
  );
}

/**
 * Add a `repo` child type (nested under `service`) so a child node of a flow
 * participant can exist. Returns nothing; mutates the architecture in place.
 * Keeps `requires-named-export` on `service`; removes `no-todo-comments` from
 * the type default so the FLOW is the only source of it on the subtree.
 */
function addRepoChildType(dir: string): void {
  writeFileSync(
    archPath(dir),
    [
      'node_types:',
      '  module:',
      "    description: 'Organizational grouping. Parent-only.'",
      '    log_required: false',
      '',
      '  service:',
      "    description: 'Service unit under src/services/.'",
      '    log_required: false',
      '    when:',
      '      path: "src/services/*"',
      '    parents: [module]',
      '    aspects:',
      '      - requires-named-export',
      '    relations:',
      '      uses: [service]',
      '      calls: [service]',
      '',
      '  repo:',
      "    description: 'Persistence helper nested under a service.'",
      '    log_required: false',
      '    when:',
      '      path: "src/services/*/**"',
      '    parents: [service]',
      '    relations:',
      '      uses: [service]',
      '',
    ].join('\n'),
    'utf-8',
  );
}

/** Create the order-repo child node + a clean source file (no TODO). */
function writeOrderRepoChild(dir: string): void {
  const nodeDir = path.join(dir, '.yggdrasil', 'model', 'services', 'orders', 'order-repo');
  mkdirSync(nodeDir, { recursive: true });
  writeFileSync(
    path.join(nodeDir, 'yg-node.yaml'),
    [
      'name: OrderRepo',
      'description: Persists and retrieves order records for the orders service.',
      'type: repo',
      'mapping:',
      '  - src/services/orders/order-repo.ts',
      '',
    ].join('\n'),
    'utf-8',
  );
  const srcDir = path.join(dir, 'src', 'services', 'orders');
  mkdirSync(srcDir, { recursive: true });
  writeFileSync(
    path.join(srcDir, 'order-repo.ts'),
    [
      '// Order repository — persists and retrieves order records.',
      '',
      'export function save(record) {',
      '  return record;',
      '}',
      '',
    ].join('\n'),
    'utf-8',
  );
}

const orderRepoFile = (dir: string) =>
  path.join(dir, 'src', 'services', 'orders', 'order-repo.ts');

describe.skipIf(!distExists)('CLI E2E — flows extended (multi-aspect / dry-run / child / removal / parse / listing)', () => {
  // =========================================================================
  // M. MULTIPLE flow aspects propagate INDEPENDENTLY to EVERY participant.
  // =========================================================================

  it('M1: TWO distinct flow aspects both reach BOTH participants, each attributed to the flow', () => {
    const dir = deterministicFixture('m1');
    try {
      dropNoTodoFromServiceDefault(dir);
      writeTokenAspect(dir, 'flow-alpha', 'ALPHATKN');
      writeTokenAspect(dir, 'flow-beta', 'BETATKN');
      writeFlow(
        dir,
        ['  - services/orders', '  - services/payments'],
        ['  - flow-alpha', '  - flow-beta'],
      );

      for (const node of ['services/orders', 'services/payments']) {
        const ctx = run(['context', '--node', node], dir);
        expect(ctx.status).toBe(0);
        expect(ctx.stdout).toContain('flow-alpha [enforced]');
        expect(ctx.stdout).toContain('flow-beta [enforced]');
        // Both attributed to the flow, not to a type default or ancestor.
        expect(ctx.stdout).toContain("flow 'order-processing'");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('M2: the two flow aspects are SEPARATELY enforceable — orders fails alpha/passes beta, payments fails beta/passes alpha', () => {
    const dir = deterministicFixture('m2');
    try {
      dropNoTodoFromServiceDefault(dir);
      writeTokenAspect(dir, 'flow-alpha', 'ALPHATKN');
      writeTokenAspect(dir, 'flow-beta', 'BETATKN');
      writeFlow(
        dir,
        ['  - services/orders', '  - services/payments'],
        ['  - flow-alpha', '  - flow-beta'],
      );

      // Violate ONLY alpha on orders, ONLY beta on payments.
      appendFileSync(ordersFile(dir), '\n// ALPHATKN here\n');
      appendFileSync(paymentsFile(dir), '\n// BETATKN here\n');

      const onOrders = run(['approve', '--node', 'services/orders'], dir);
      expect(onOrders.status).toBe(1);
      expect(onOrders.stdout).toContain('flow-alpha — NOT SATISFIED');
      expect(onOrders.stdout).toContain('flow-beta — SATISFIED');

      const onPayments = run(['approve', '--node', 'services/payments'], dir);
      expect(onPayments.status).toBe(1);
      expect(onPayments.stdout).toContain('flow-beta — NOT SATISFIED');
      expect(onPayments.stdout).toContain('flow-alpha — SATISFIED');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // =========================================================================
  // D. dry-run paths.
  // =========================================================================

  it('D1: approve --flow --dry-run is REJECTED — batch has no preview mode (exit 1)', () => {
    const dir = deterministicFixture('d1');
    try {
      const res = run(['approve', '--flow', 'order-processing', '--dry-run'], dir);
      expect(res.status).toBe(1);
      expect(res.all).toContain('--dry-run is only supported with --node, not with --aspect or --flow');
      // No baseline is written by the rejected invocation.
      expect(existsSync(baselinePath(dir, 'services/orders'))).toBe(false);
      expect(existsSync(baselinePath(dir, 'services/payments'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('D2: approve --node --dry-run previews a flow-delivered aspect and writes NO baseline', () => {
    const dir = deterministicFixture('d2');
    try {
      // Flow is the SOLE source of no-todo-comments on the participant.
      dropNoTodoFromServiceDefault(dir);
      writeFlow(
        dir,
        ['  - services/orders', '  - services/payments'],
        ['  - no-todo-comments'],
      );

      const preview = run(['approve', '--node', 'services/orders', '--dry-run'], dir);
      expect(preview.status).toBe(0);
      expect(preview.stdout).toContain('Dry run: services/orders');
      // The flow-delivered aspect is part of the previewed aspect set.
      expect(preview.stdout).toContain('no-todo-comments');
      // Preview must not commit a baseline.
      expect(existsSync(baselinePath(dir, 'services/orders'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // =========================================================================
  // C. NEW CHILD of a participant auto-included AFTER a baseline exists.
  // =========================================================================

  it('C1: a child added under a participant AFTER baselines exist gains the flow aspect (via parent) and is reported unapproved by check', () => {
    const dir = deterministicFixture('c1');
    try {
      addRepoChildType(dir);
      // Baseline the existing participants BEFORE the child exists.
      expect(
        run(['approve', '--node', 'services/orders', '--node', 'services/payments'], dir).status,
      ).toBe(0);
      expect(run(['check'], dir).status).toBe(0);

      // Now create the child node under the participant services/orders.
      writeOrderRepoChild(dir);

      // The flow aspect reaches the child, attributed via the parent participant.
      const ctx = run(['context', '--node', 'services/orders/order-repo'], dir);
      expect(ctx.status).toBe(0);
      expect(ctx.stdout).toContain('no-todo-comments [enforced]');
      expect(ctx.stdout).toContain("flow 'order-processing' (via parent 'services/orders')");

      // The brand-new node has no baseline → check blocks on it.
      const check = run(['check'], dir);
      expect(check.status).toBe(1);
      expect(check.stdout).toContain('services/orders/order-repo');
      expect(check.stdout).toContain('unapproved');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('C2: the flow aspect is ENFORCED on the new child — clean approve passes, a TODO then refuses', () => {
    const dir = deterministicFixture('c2');
    try {
      addRepoChildType(dir);
      writeOrderRepoChild(dir);

      // Clean child approves (the flow aspect is satisfied).
      const clean = run(['approve', '--node', 'services/orders/order-repo'], dir);
      expect(clean.status).toBe(0);
      expect(clean.stdout).toContain('Approved: services/orders/order-repo');

      // Violate the flow-delivered enforced aspect on the child source.
      appendFileSync(orderRepoFile(dir), '\n// TODO: implement caching\n');
      const refused = run(['approve', '--node', 'services/orders/order-repo'], dir);
      expect(refused.status).toBe(1);
      expect(refused.stdout).toContain('no-todo-comments — NOT SATISFIED');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // =========================================================================
  // R. PARTICIPANT REMOVAL drops the flow aspect from the removed node.
  // =========================================================================

  it('R1: removing a participant from nodes: drops the flow aspect from its effective set', () => {
    const dir = deterministicFixture('r1');
    try {
      dropNoTodoFromServiceDefault(dir); // flow is the SOLE source

      // Before: payments has the flow aspect.
      const before = run(['context', '--node', 'services/payments'], dir);
      expect(before.stdout).toContain('no-todo-comments [enforced]');
      expect(before.stdout).toContain("flow 'order-processing'");

      // Remove payments from the flow.
      writeFlow(dir, ['  - services/orders'], ['  - no-todo-comments']);

      // After: payments no longer carries the flow aspect or the flow line.
      const after = run(['context', '--node', 'services/payments'], dir);
      expect(after.status).toBe(0);
      expect(after.stdout).not.toContain('no-todo-comments');
      expect(after.stdout).not.toContain("flow 'order-processing'");
      // Its other (type-default) aspect remains.
      expect(after.stdout).toContain('requires-named-export');

      // impact --flow no longer lists the removed participant.
      const impact = run(['impact', '--flow', 'order-processing'], dir);
      expect(impact.stdout).toContain('services/orders');
      expect(impact.stdout).not.toContain('services/payments');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('R2: removing a baselined participant cascades drift on it (effective-aspect change) and a re-approve clears it', () => {
    const dir = deterministicFixture('r2');
    try {
      dropNoTodoFromServiceDefault(dir);
      // Baseline both with the flow aspect active on payments.
      expect(
        run(['approve', '--node', 'services/orders', '--node', 'services/payments'], dir).status,
      ).toBe(0);
      expect(run(['check'], dir).status).toBe(0);

      // Remove payments from the flow → its effective-aspect set changed.
      writeFlow(dir, ['  - services/orders'], ['  - no-todo-comments']);

      const drifted = run(['check'], dir);
      expect(drifted.status).toBe(1);
      expect(drifted.stdout).toContain('cascade');
      expect(drifted.stdout).toContain('services/payments');

      // The documented per-node clearing path resolves it.
      const reapprove = run(['approve', '--node', 'services/payments'], dir);
      expect(reapprove.status).toBe(0);

      const cleared = run(['check'], dir);
      expect(cleared.status).toBe(0);
      expect(cleared.stdout).toContain('PASS');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // =========================================================================
  // P. Flow YAML PARSE / validation errors via the spawned binary.
  // =========================================================================

  it('P1: an EMPTY nodes array is a parse error (non-empty array required, exit 1)', () => {
    const dir = deterministicFixture('p1');
    try {
      writeFileSync(
        flowPath(dir),
        [
          'name: OrderProcessing',
          'description: End-to-end processing of a customer order.',
          'nodes: []',
          'aspects:',
          '  - no-todo-comments',
          '',
        ].join('\n'),
        'utf-8',
      );
      const check = run(['check'], dir);
      expect(check.status).toBe(1);
      expect(check.all).toContain("'nodes' (or 'participants') must be a non-empty array");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('P2: a MISSING nodes key (no nodes/participants) is the same non-empty-array parse error (exit 1)', () => {
    const dir = deterministicFixture('p2');
    try {
      writeFileSync(
        flowPath(dir),
        [
          'name: OrderProcessing',
          'description: A flow with no nodes list at all.',
          'aspects:',
          '  - no-todo-comments',
          '',
        ].join('\n'),
        'utf-8',
      );
      const check = run(['check'], dir);
      expect(check.status).toBe(1);
      expect(check.all).toContain("'nodes' (or 'participants') must be a non-empty array");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('P3: a NON-STRING node entry is rejected with its index/type (exit 1)', () => {
    const dir = deterministicFixture('p3');
    try {
      writeFileSync(
        flowPath(dir),
        [
          'name: OrderProcessing',
          'description: A flow with a numeric node entry.',
          'nodes:',
          '  - services/orders',
          '  - 42',
          'aspects:',
          '  - no-todo-comments',
          '',
        ].join('\n'),
        'utf-8',
      );
      const check = run(['check'], dir);
      expect(check.status).toBe(1);
      expect(check.all).toContain("contains non-string entry [index 1: 42 (number)]");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('P4: a MISSING name is a parse error (exit 1)', () => {
    const dir = deterministicFixture('p4');
    try {
      writeFileSync(
        flowPath(dir),
        [
          'description: A flow without a name field.',
          'nodes:',
          '  - services/orders',
          'aspects:',
          '  - no-todo-comments',
          '',
        ].join('\n'),
        'utf-8',
      );
      const check = run(['check'], dir);
      expect(check.status).toBe(1);
      expect(check.all).toContain("missing or empty 'name'");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('P5: a MISSING description (name + nodes present) is a VALIDATION finding, not a parse throw — description-missing blocks check (exit 1)', () => {
    const dir = deterministicFixture('p5');
    try {
      // Approve participants first so the only remaining finding is the flow's.
      expect(
        run(['approve', '--node', 'services/orders', '--node', 'services/payments'], dir).status,
      ).toBe(0);
      writeFileSync(
        flowPath(dir),
        [
          'name: OrderProcessing',
          'nodes:',
          '  - services/orders',
          '  - services/payments',
          'aspects:',
          '  - no-todo-comments',
          '',
        ].join('\n'),
        'utf-8',
      );
      const check = run(['check'], dir);
      expect(check.status).toBe(1);
      expect(check.stdout).toContain('description-missing');
      expect(check.stdout).toContain("Flow 'OrderProcessing' has no description.");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // =========================================================================
  // L. yg flows listing — empty, multiple, and the participants: alias.
  // =========================================================================

  it('L1: yg flows on a graph with NO flows prints nothing and exits 0', () => {
    const dir = deterministicFixture('l1');
    try {
      rmSync(path.join(dir, '.yggdrasil', 'flows', 'order-processing'), {
        recursive: true,
        force: true,
      });
      const flows = run(['flows'], dir);
      expect(flows.status).toBe(0);
      expect(flows.stdout).toBe('');
      // And check accounts zero flows.
      const check = run(['check'], dir);
      expect(check.stdout).toContain('0 flows');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('L2: yg flows lists MULTIPLE flows sorted by name, each with participants and aspects (exit 0)', () => {
    const dir = deterministicFixture('l2');
    try {
      // Add a second flow; PaymentSettlement sorts AFTER OrderProcessing.
      const dir2 = path.join(dir, '.yggdrasil', 'flows', 'payment-settlement');
      mkdirSync(dir2, { recursive: true });
      writeFileSync(
        path.join(dir2, 'yg-flow.yaml'),
        [
          'name: PaymentSettlement',
          'description: Settles captured payments with the processor at end of day.',
          'nodes:',
          '  - services/payments',
          'aspects:',
          '  - requires-named-export',
          '',
        ].join('\n'),
        'utf-8',
      );
      const flows = run(['flows'], dir);
      expect(flows.status).toBe(0);
      // Both flows appear.
      expect(flows.stdout).toContain('OrderProcessing');
      expect(flows.stdout).toContain('PaymentSettlement');
      // Sorted by name: OrderProcessing precedes PaymentSettlement.
      expect(flows.stdout.indexOf('OrderProcessing')).toBeLessThan(
        flows.stdout.indexOf('PaymentSettlement'),
      );
      // The second flow shows its single participant and its aspect.
      expect(flows.stdout).toContain('Participants: 1 nodes (services/payments)');
      expect(flows.stdout).toContain('Aspects: requires-named-export');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('L3: the participants: alias is accepted as a synonym for nodes:', () => {
    const dir = deterministicFixture('l3');
    try {
      writeFileSync(
        flowPath(dir),
        [
          'name: OrderProcessing',
          'description: End-to-end processing of a customer order, from creation through payment.',
          'participants:',
          '  - services/orders',
          '  - services/payments',
          'aspects:',
          '  - no-todo-comments',
          '',
        ].join('\n'),
        'utf-8',
      );
      const flows = run(['flows'], dir);
      expect(flows.status).toBe(0);
      expect(flows.stdout).toContain('Participants: 2 nodes (services/orders, services/payments)');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // =========================================================================
  // X. yg impact --node + --flow mutex (the pair cli-impact does not pin).
  // =========================================================================

  it('X1: yg impact --node and --flow together is rejected (exit 1)', () => {
    const dir = deterministicFixture('x1');
    try {
      const res = run(['impact', '--node', 'services/orders', '--flow', 'order-processing'], dir);
      expect(res.status).toBe(1);
      expect(res.stderr).toContain('Multiple targets specified');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
