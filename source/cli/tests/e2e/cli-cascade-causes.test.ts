import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  rmSync,
  cpSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// CASCADE CAUSE MESSAGES. The drift tracker collapses several SYNTHETIC tracked
// keys into per-node drift, each rendered by describeCascadeCause() with a
// distinct, agent-facing what/why string. The tier-identity, reference-file,
// aspect-content (check.mjs), and check-touched-content causes are proven
// elsewhere; this suite pins the remaining ones END-TO-END against the binary:
//   - aspect-meta:<id>   → "the definition of aspect '<id>' changed"
//                          (an aspect's metadata — description/reviewer/implies —
//                          changing WITHOUT a check.mjs edit still cascades)
//   - own-subset:<node>  → "node '<path>' own metadata changed"
//                          (a node re-deriving its own effective aspects after a
//                          relations/type/ports edit)
//   - MULTI-CAUSE        → two simultaneous causes on one node, both surfaced,
//                          cleared by one approve.
//   - PARTIAL DELETION   → one of several mapped files removed → source-drift →
//                          restored → cleared.
//
// Fully hermetic: copy e2e-lifecycle, strip the LLM aspect, kill the reviewer
// endpoint, rmSync in finally.
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'e2e-lifecycle');
const distExists = existsSync(BIN_PATH);

const DEAD_ENDPOINT = 'http://127.0.0.1:1';

function run(args: string[], cwd: string): { stdout: string; stderr: string; status: number | null; all: string } {
  const result = spawnSync('node', [BIN_PATH, ...args], { cwd, encoding: 'utf-8' });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  return { stdout, stderr, status: result.status, all: stdout + stderr };
}

function hermeticFixture(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-cause-${label}-`));
  cpSync(FIXTURE, dir, { recursive: true });
  const archPath = path.join(dir, '.yggdrasil', 'yg-architecture.yaml');
  writeFileSync(
    archPath,
    readFileSync(archPath, 'utf-8').split('\n').filter((l) => l.trim() !== '- has-doc-comment').join('\n'),
    'utf-8',
  );
  rmSync(path.join(dir, '.yggdrasil', 'aspects', 'has-doc-comment'), { recursive: true, force: true });
  const cfgPath = path.join(dir, '.yggdrasil', 'yg-config.yaml');
  writeFileSync(
    cfgPath,
    readFileSync(cfgPath, 'utf-8').replace(/endpoint:\s*["']?[^"'\n]+["']?/, `endpoint: "${DEAD_ENDPOINT}"`),
    'utf-8',
  );
  return dir;
}

const noTodoYaml = (dir: string) => path.join(dir, '.yggdrasil', 'aspects', 'no-todo-comments', 'yg-aspect.yaml');
const ordersNodeYaml = (dir: string) => path.join(dir, '.yggdrasil', 'model', 'services', 'orders', 'yg-node.yaml');
const ordersSrc = (dir: string) => path.join(dir, 'src', 'services', 'orders.ts');

/** Approve both service nodes so the suite starts from a clean, settled baseline. */
function approveBoth(dir: string): void {
  expect(run(['approve', '--node', 'services/orders'], dir).status).toBe(0);
  expect(run(['approve', '--node', 'services/payments'], dir).status).toBe(0);
}

describe.skipIf(!distExists)('CLI E2E — cascade cause messages (aspect-meta, own-subset, multi-cause, partial deletion)', () => {
  // --- aspect-meta: editing aspect METADATA (not check.mjs) cascades ---

  it('1: editing an aspect\'s description (metadata, not check.mjs) cascades with "the definition of aspect ... changed"', () => {
    const dir = hermeticFixture('aspect-meta');
    try {
      approveBoth(dir);
      // Sanity: clean baseline.
      expect(run(['check'], dir).status).toBe(0);

      // Edit ONLY the description of the deterministic no-todo-comments aspect —
      // its check.mjs is untouched, but its definition metadata changed.
      const yaml = readFileSync(noTodoYaml(dir), 'utf-8').replace(
        /description:.*/,
        'description: Source files must not contain TODO comments — rewritten metadata.',
      );
      writeFileSync(noTodoYaml(dir), yaml, 'utf-8');

      const drifted = run(['check'], dir);
      expect(drifted.status).toBe(1);
      expect(drifted.all).toContain("the definition of aspect 'no-todo-comments' changed");
      // Both using nodes are affected (rendered in the grouped affected-node form).
      expect(drifted.all).toContain('services/{orders, payments}');

      // A deterministic --aspect re-approve clears it (zero LLM cost).
      expect(run(['approve', '--aspect', 'no-todo-comments'], dir).status).toBe(0);
      expect(run(['check'], dir).status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- own-subset: editing a node's OWN metadata (relations) re-derives it ---

  it('2: adding a relation to a node cascades on that node with "node ... own metadata changed"', () => {
    const dir = hermeticFixture('own-subset');
    try {
      approveBoth(dir);
      expect(run(['check'], dir).status).toBe(0);

      // Add a `uses` relation on orders → its OWN metadata subset changes.
      writeFileSync(
        ordersNodeYaml(dir),
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

      const drifted = run(['check'], dir);
      expect(drifted.status).toBe(1);
      expect(drifted.all).toContain("node 'services/orders' own metadata changed");

      // Re-approving the node clears its own-metadata cascade.
      expect(run(['approve', '--node', 'services/orders'], dir).status).toBe(0);
      expect(run(['check'], dir).status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- MULTI-CAUSE: two simultaneous causes on one node, both surfaced ---

  it('3: two simultaneous cascade causes on one node are BOTH surfaced and cleared by one approve', () => {
    const dir = hermeticFixture('multi-cause');
    try {
      approveBoth(dir);
      expect(run(['check'], dir).status).toBe(0);

      // Cause A: edit the aspect metadata (aspect-meta cascade on orders).
      writeFileSync(
        noTodoYaml(dir),
        readFileSync(noTodoYaml(dir), 'utf-8').replace(/description:.*/, 'description: TODO rule — metadata v2.'),
        'utf-8',
      );
      // Cause B: edit orders' own metadata (own-subset cascade on orders).
      writeFileSync(
        ordersNodeYaml(dir),
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

      const drifted = run(['check'], dir);
      expect(drifted.status).toBe(1);
      // BOTH causes appear for services/orders.
      expect(drifted.all).toContain("the definition of aspect 'no-todo-comments' changed");
      expect(drifted.all).toContain("node 'services/orders' own metadata changed");

      // A single approve of the node absorbs every cause on it; then re-approve
      // the aspect cascade that also reached payments.
      expect(run(['approve', '--node', 'services/orders'], dir).status).toBe(0);
      expect(run(['approve', '--node', 'services/payments'], dir).status).toBe(0);
      expect(run(['check'], dir).status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- PARTIAL DELETION: one of several mapped files removed → source drift ---

  it('4: deleting one of several mapped files raises source-drift; restoring it clears the drift', () => {
    const dir = hermeticFixture('partial-deletion');
    try {
      // Map orders to TWO files; create the second with a named export so the
      // advisory requires-named-export aspect stays satisfied.
      const extra = path.join(dir, 'src', 'services', 'orders-extra.ts');
      const extraContent = 'export const ordersExtra = 1;\n';
      writeFileSync(extra, extraContent, 'utf-8');
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
          '  - src/services/orders-extra.ts',
          '',
        ].join('\n'),
        'utf-8',
      );
      expect(run(['approve', '--node', 'services/orders'], dir).status).toBe(0);
      expect(run(['approve', '--node', 'services/payments'], dir).status).toBe(0);
      expect(run(['check'], dir).status).toBe(0);

      // Delete one of the two mapped files.
      rmSync(extra, { force: true });
      const drifted = run(['check'], dir);
      expect(drifted.status).toBe(1);
      expect(drifted.all).toContain('services/orders');
      expect(drifted.all).toContain('orders-extra.ts');

      // Restore it byte-identically → drift clears, no re-approve needed.
      writeFileSync(extra, extraContent, 'utf-8');
      expect(run(['check'], dir).status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
