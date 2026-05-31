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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'e2e-lifecycle');

const distExists = existsSync(BIN_PATH);

// A dead loopback endpoint. Pointing the reviewer at this makes the LLM aspect
// path unreachable, so `yg approve` never produces an environment-dependent LLM
// verdict — only the deterministic aspects drive every refuse/pass outcome.
// Port 1 never has a listener on any machine, so the assertions are hermetic
// without relying on any real endpoint being present or absent.
const DEAD_ENDPOINT = 'http://127.0.0.1:1';

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
  const dir = mkdtempSync(path.join(tmpdir(), `yg-flow5-${label}-`));
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

/**
 * Copy the fixture and strip the LLM aspect (`has-doc-comment`) so the node's
 * effective aspects are purely deterministic. This makes the approve/check
 * lifecycle hermetic: no network, no LLM verdict, fully reproducible — the
 * `no-todo-comments` (enforced) and `requires-named-export` (advisory)
 * deterministic aspects drive every refuse/pass outcome.
 */
function deterministicFixture(label: string): string {
  const dir = copyFixture(label);
  // Drop the LLM aspect from the `service` node type's default aspects.
  const archPath = path.join(dir, '.yggdrasil', 'yg-architecture.yaml');
  const arch = readFileSync(archPath, 'utf-8')
    .split('\n')
    .filter((line) => line.trim() !== '- has-doc-comment')
    .join('\n');
  writeFileSync(archPath, arch, 'utf-8');
  // Remove the now-orphaned aspect definition so `yg check` is clean.
  rmSync(path.join(dir, '.yggdrasil', 'aspects', 'has-doc-comment'), {
    recursive: true,
    force: true,
  });
  return dir;
}

/**
 * Repoint the reviewer endpoint at the dead loopback address so the reviewer is
 * ALWAYS unreachable regardless of the machine — no reliance on any specific
 * external host being present or absent.
 */
function killReviewer(dir: string): void {
  const cfgPath = path.join(dir, '.yggdrasil', 'yg-config.yaml');
  const cfg = readFileSync(cfgPath, 'utf-8').replace(
    /endpoint:\s*["']?[^"'\n]+["']?/,
    `endpoint: "${DEAD_ENDPOINT}"`,
  );
  writeFileSync(cfgPath, cfg, 'utf-8');
}

const paymentsFile = (dir: string) => path.join(dir, 'src', 'services', 'payments.ts');
const noTodoCheckMjs = (dir: string) =>
  path.join(dir, '.yggdrasil', 'aspects', 'no-todo-comments', 'check.mjs');

/**
 * Build a fixture that ISOLATES channel 5 (flow aspects) on a descendant of a
 * flow participant. The committed fixture attaches `no-todo-comments` as a
 * `service`-type DEFAULT aspect, which would reach a descendant through plain
 * ancestor/type inheritance and so would NOT prove flow propagation. Here we
 * rewrite the architecture so that:
 *   - the `service` type carries ONLY `requires-named-export` (no
 *     `no-todo-comments` default), and
 *   - a new `repo` type nests under `service` and carries NO default aspects.
 * The `order-processing` flow still attaches `no-todo-comments` to the two
 * participants. As a result the ONLY way `no-todo-comments` can reach the
 * descendant `services/orders/order-repo` is via the flow propagating to the
 * descendants of its participant `services/orders`. `yg context` confirms the
 * attribution: "Source: flow 'order-processing' (via parent 'services/orders')".
 *
 * The descendant maps a clean source file (no TODO) so a fresh approve passes.
 */
function descendantFixture(label: string): string {
  const dir = copyFixture(label);

  // Drop the LLM aspect so the lifecycle is purely deterministic + hermetic,
  // and remove `no-todo-comments` from the `service` type defaults so the flow
  // is the sole source of that aspect on the subtree. Also add a `repo` type.
  const archPath = path.join(dir, '.yggdrasil', 'yg-architecture.yaml');
  writeFileSync(
    archPath,
    [
      'node_types:',
      '  module:',
      "    description: 'Organizational grouping of related services. Parent-only.'",
      '    log_required: false',
      '',
      '  service:',
      "    description: 'Discrete service unit implemented as a single source file under src/services/.'",
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
      "    description: 'Persistence helper nested under a service. Carries no default aspects of its own.'",
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
  rmSync(path.join(dir, '.yggdrasil', 'aspects', 'has-doc-comment'), {
    recursive: true,
    force: true,
  });

  // Add the descendant node mapping a clean source file (no TODO).
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
      'export interface OrderRecord {',
      '  id: string;',
      '  total: number;',
      '}',
      '',
      'export function save(record: OrderRecord): OrderRecord {',
      '  return record;',
      '}',
      '',
    ].join('\n'),
    'utf-8',
  );

  return dir;
}

const orderRepoFile = (dir: string) =>
  path.join(dir, 'src', 'services', 'orders', 'order-repo.ts');

// ---------------------------------------------------------------------------
// Channel 5 — flow aspects reach participants AND descendants, and are
// ENFORCED at approve. Hermetic: no LLM, no network (killReviewer + dead port).
// ---------------------------------------------------------------------------

describe.skipIf(!distExists)('CLI E2E — channel 5: flow aspects reach participants and descendants', () => {
  // --- 1. Descendant propagation ---

  it('1: the flow aspect cascades to a descendant of a participant and blocks check', () => {
    const dir = descendantFixture('descendant');
    try {
      killReviewer(dir);

      // The descendant receives `no-todo-comments` SOLELY from the flow.
      const ctx = run(['context', '--node', 'services/orders/order-repo'], dir);
      expect(ctx.status).toBe(0);
      expect(ctx.stdout).toContain('no-todo-comments');
      expect(ctx.stdout).toContain("flow 'order-processing' (via parent 'services/orders')");

      // Clean descendant approves cleanly.
      const approve = run(['approve', '--node', 'services/orders/order-repo'], dir);
      expect(approve.status).toBe(0);
      expect(approve.stdout).toContain('Approved: services/orders/order-repo');

      // Now violate the flow aspect on the DESCENDANT's source file.
      appendFileSync(orderRepoFile(dir), '\n// TODO: implement caching\n');
      const check = run(['check'], dir);
      expect(check.status).toBe(1);
      // The descendant is the node that drifted because of the flow-cascaded
      // aspect — proving the flow rule reaches the participant's descendant.
      expect(check.stdout).toContain('services/orders/order-repo');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('1b: approving the descendant with the flow aspect violated REFUSES (enforced)', () => {
    const dir = descendantFixture('descendant-refuse');
    try {
      killReviewer(dir);
      expect(run(['approve', '--node', 'services/orders/order-repo'], dir).status).toBe(0);

      appendFileSync(orderRepoFile(dir), '\n// TODO: implement caching\n');
      const refused = run(['approve', '--node', 'services/orders/order-repo'], dir);
      // The flow-attached enforced aspect rejects the descendant's TODO.
      expect(refused.status).toBe(1);
      expect(refused.stdout).toContain('no-todo-comments');
      expect(refused.stdout).toContain('NOT SATISFIED');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- 2. Participant violation refuses ---

  it('2: approving a participant with the flow aspect violated REFUSES (exit 1)', () => {
    const dir = deterministicFixture('participant-refuse');
    try {
      killReviewer(dir);
      appendFileSync(paymentsFile(dir), '\n// TODO: fix\n');
      const refused = run(['approve', '--node', 'services/payments'], dir);
      expect(refused.status).toBe(1);
      expect(refused.stdout).toContain('no-todo-comments');
      expect(refused.stdout).toContain('NOT SATISFIED');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- 3. Flow batch names violators ---

  it('3: a flow batch re-approve names the violating participant and the aspect (exit 1)', () => {
    const dir = deterministicFixture('flow-batch-violator');
    try {
      killReviewer(dir);
      // Establish baselines so the violating node carries source drift that the
      // flow batch then re-verifies.
      expect(run(['approve', '--node', 'services/orders', '--node', 'services/payments'], dir).status).toBe(0);

      appendFileSync(paymentsFile(dir), '\n// TODO: fix\n');
      const batch = run(['approve', '--flow', 'order-processing'], dir);
      expect(batch.status).toBe(1);
      expect(batch.stdout).toContain('services/payments');
      expect(batch.stdout).toContain('no-todo-comments');
      expect(batch.stdout).toContain('NOT SATISFIED');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- 4. Clean flow batch ---

  it('4: a clean flow batch re-approve names BOTH participants and exits 0', () => {
    const dir = deterministicFixture('flow-batch-clean');
    try {
      killReviewer(dir);
      // Establish baselines for both participants.
      expect(run(['approve', '--node', 'services/orders', '--node', 'services/payments'], dir).status).toBe(0);

      // A trivial no-op edit to the flow aspect's implementation creates a
      // cascade drift across both participants WITHOUT touching any source file,
      // so the flow batch re-approves both nodes cleanly.
      appendFileSync(noTodoCheckMjs(dir), '\n// cascade-trigger: trivial no-op comment\n');

      const batch = run(['approve', '--flow', 'order-processing'], dir);
      expect(batch.status).toBe(0);
      expect(batch.stdout).toContain('services/orders');
      expect(batch.stdout).toContain('services/payments');
      expect(batch.stdout).toContain('2 approved');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- 5. yg flows lists the flow, participants, and its aspect ---

  it('5: yg flows lists the flow, both participants, and the flow aspect (exit 0)', () => {
    const dir = deterministicFixture('flows-listing');
    try {
      const flows = run(['flows'], dir);
      expect(flows.status).toBe(0);
      expect(flows.stdout).toContain('OrderProcessing');
      expect(flows.stdout).toContain('services/orders');
      expect(flows.stdout).toContain('services/payments');
      // The flow's Aspects line names the channel-5 aspect.
      expect(flows.stdout).toContain('Aspects: no-todo-comments');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
