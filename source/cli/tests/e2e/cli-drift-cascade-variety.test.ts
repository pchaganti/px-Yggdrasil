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
import { startMockReviewer, runAsync } from './support/mock-reviewer.js';

// ---------------------------------------------------------------------------
// Harness — duplicated from cli-deterministic-lifecycle.test.ts because the two
// e2e test files do not share a module. Each test copies the e2e-lifecycle
// fixture into a FRESH mkdtemp dir, mutates only that copy (never the committed
// fixture), and removes it in a finally block. Nothing here depends on a real
// network host: when the LLM reviewer must be unreachable it is forced to the
// guaranteed-dead loopback endpoint below.
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'e2e-lifecycle');

const distExists = existsSync(BIN_PATH);

// A dead loopback endpoint — port 1 never has a listener on any machine, so
// pointing the reviewer here makes the LLM aspect path deterministically
// unreachable with no dependency on any external host being present or absent.
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
  const dir = mkdtempSync(path.join(tmpdir(), `yg-cascade-${label}-`));
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

/**
 * Repoint the reviewer endpoint at the dead loopback address so the reviewer is
 * ALWAYS unreachable regardless of the machine. Approve then records only
 * deterministic verdicts; no LLM call is ever made.
 */
function killReviewer(dir: string): void {
  const cfgPath = path.join(dir, '.yggdrasil', 'yg-config.yaml');
  const cfg = readFileSync(cfgPath, 'utf-8').replace(
    /endpoint:\s*["']?[^"'\n]+["']?/,
    `endpoint: "${DEAD_ENDPOINT}"`,
  );
  writeFileSync(cfgPath, cfg, 'utf-8');
}

/**
 * Copy the fixture, strip the LLM aspect (`has-doc-comment`) so every node's
 * effective aspects are purely deterministic, and kill the reviewer endpoint.
 * The cascade scenarios below are then fully hermetic — no network, no LLM
 * verdict, every refuse/pass driven only by the `no-todo-comments` (enforced)
 * and `requires-named-export` (advisory) deterministic aspects.
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
  killReviewer(dir);
  return dir;
}

const aspectCheckMjs = (dir: string, id: string) =>
  path.join(dir, '.yggdrasil', 'aspects', id, 'check.mjs');
const parentNodeYaml = (dir: string) =>
  path.join(dir, '.yggdrasil', 'model', 'services', 'yg-node.yaml');
const ordersNodeYaml = (dir: string) =>
  path.join(dir, '.yggdrasil', 'model', 'services', 'orders', 'yg-node.yaml');
const paymentsNodeYaml = (dir: string) =>
  path.join(dir, '.yggdrasil', 'model', 'services', 'payments', 'yg-node.yaml');
const flowYaml = (dir: string) =>
  path.join(dir, '.yggdrasil', 'flows', 'order-processing', 'yg-flow.yaml');

/** Approve both leaf service nodes from a clean fixture; assert both succeed. */
function approveBoth(dir: string): void {
  expect(run(['approve', '--node', 'services/orders'], dir).status).toBe(0);
  expect(run(['approve', '--node', 'services/payments'], dir).status).toBe(0);
  // Sanity: a clean baseline means check passes before we introduce drift.
  expect(run(['check'], dir).status).toBe(0);
}

// ---------------------------------------------------------------------------
// Upstream (cascade) drift across every cascade layer, and the documented
// re-approve path that clears each one. Reuses the e2e-lifecycle fixture:
// parent module `services`, leaf services `services/orders` + `services/payments`,
// the `order-processing` flow, and the deterministic aspects. Both leaf nodes
// are `service` type with `log_required: false` (confirmed in the fixture's
// yg-architecture.yaml), so no `yg log add` is needed before approve.
//
// Note on node rendering: when a cascade affects multiple sibling nodes under
// one parent, `yg check` collapses them to the compact form
// `services/{orders, payments}` (a stable substring that proves BOTH
// participants), rather than printing each full node path. Note the single
// slash between the common prefix and the brace group. The single-node
// cascades print the full `services/orders` path. Assertions below target the
// form the CLI actually emits.
// ---------------------------------------------------------------------------

describe.skipIf(!distExists)('CLI E2E — upstream cascade drift across every layer', () => {
  // --- 1. Aspect layer: editing the aspect implementation cascades to every
  //        node that uses it; `--aspect` batch re-approve clears it. ---

  it('1: editing no-todo-comments/check.mjs cascades to both nodes; --aspect re-approve clears it', () => {
    const dir = deterministicFixture('aspect');
    try {
      approveBoth(dir);

      // Trivial no-op change to the aspect's implementation.
      appendFileSync(
        aspectCheckMjs(dir, 'no-todo-comments'),
        '\n// cascade-trigger: trivial no-op comment\n',
      );

      const drifted = run(['check'], dir);
      expect(drifted.status).toBe(1);
      expect(drifted.stdout).toContain('cascade');
      expect(drifted.stdout).toContain("aspect 'no-todo-comments' check.mjs changed");
      // Both participants are named in the compact sibling rendering with a
      // single slash before the brace group — not the doubled `services//{...}`.
      // (The baseline is settled in one approve, so this is the ONLY cascade —
      // no spurious per-node "set of files read changed" causes are dragged in.)
      expect(drifted.stdout).toContain('services/{orders, payments}');
      expect(drifted.stdout).not.toContain('services//{');
      expect(drifted.stdout).not.toContain('the set of files read by deterministic aspect');

      const reapprove = run(['approve', '--aspect', 'no-todo-comments'], dir);
      expect(reapprove.status).toBe(0);
      expect(reapprove.stdout).toContain('services/orders');
      expect(reapprove.stdout).toContain('services/payments');
      expect(reapprove.stdout).toContain('2 approved');

      // Cascade is gone.
      const cleared = run(['check'], dir);
      expect(cleared.status).toBe(0);
      expect(cleared.stdout).not.toContain("aspect 'no-todo-comments' check.mjs changed");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- 2. Reference-file layer: an LLM aspect declares a `references:` file;
  //        editing that file cascades to every node the aspect reaches. ---
  //
  // The reference-file mechanism is LLM-only, so this scenario KEEPS the LLM
  // aspect `has-doc-comment` (it does NOT use deterministicFixture). The reviewer
  // is pointed at a live in-process mock that returns a satisfied verdict, so
  // approve records a genuine, clean baseline that captures the declared
  // reference file's hash. Editing that reference file then surfaces a
  // reference-file cascade in `yg check`. (A dead reviewer would fail closed and
  // write NO baseline (#2), leaving nothing to cascade against — hence the mock.)
  it('2: editing an LLM aspect reference file cascades; check reports the reference-file cascade', async () => {
    const dir = copyFixture('reference');
    const mock = await startMockReviewer();
    try {
      // Point the reviewer at the live mock so the LLM aspect is verified.
      const cfgPath = path.join(dir, '.yggdrasil', 'yg-config.yaml');
      writeFileSync(
        cfgPath,
        readFileSync(cfgPath, 'utf-8').replace(/endpoint:\s*["']?[^"'\n]+["']?/, `endpoint: "${mock.endpoint}"`),
        'utf-8',
      );

      // Declare a reference file on the LLM aspect and create it in the copy.
      const aspectYaml = path.join(dir, '.yggdrasil', 'aspects', 'has-doc-comment', 'yg-aspect.yaml');
      writeFileSync(
        aspectYaml,
        [
          'name: HasDocComment',
          "description: Every source file must begin with a documentation comment describing the file's purpose.",
          'reviewer:',
          '  type: llm',
          'status: enforced',
          'references:',
          '  - docs/guidance.md',
          '',
        ].join('\n'),
        'utf-8',
      );
      mkdirSync(path.join(dir, 'docs'), { recursive: true });
      const guidance = path.join(dir, 'docs', 'guidance.md');
      writeFileSync(
        guidance,
        '# Guidance\n\nDescribe the file purpose in the opening comment.\n',
        'utf-8',
      );

      // Record a clean (LLM-verified) baseline that captures the reference hash.
      expect((await runAsync(['approve', '--node', 'services/orders'], dir)).status).toBe(0);
      expect((await runAsync(['approve', '--node', 'services/payments'], dir)).status).toBe(0);

      // Now change the reference file — this is the reference-file cascade.
      appendFileSync(guidance, '\nAdditional guidance appended to trigger a cascade.\n');

      const drifted = await runAsync(['check'], dir);
      expect(drifted.status).toBe(1);
      expect(drifted.stdout).toContain('cascade');
      expect(drifted.stdout).toContain("reference file 'docs/guidance.md'");
      expect(drifted.stdout).toContain('changed');
      // The cascade names the declaring aspect and reaches both participants.
      expect(drifted.stdout).toContain("declared by aspect 'has-doc-comment'");
      expect(drifted.stdout).toContain('services/{orders, payments}');
      expect(drifted.stdout).not.toContain('services//{');
    } finally {
      await mock.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- 3. Hierarchy layer: changing a parent node's metadata cascades to every
  //        descendant; approving the parent re-approves the whole subtree. ---

  it('3: editing parent services/yg-node.yaml cascades to both children; approve --node services clears it', () => {
    const dir = deterministicFixture('hierarchy');
    try {
      approveBoth(dir);

      appendFileSync(parentNodeYaml(dir), '\n# cascade-trigger comment\n');

      const drifted = run(['check'], dir);
      expect(drifted.status).toBe(1);
      expect(drifted.stdout).toContain("parent node 'services' metadata changed");
      // Both children are named (compact sibling rendering, single slash).
      expect(drifted.stdout).toContain('services/orders');
      expect(drifted.stdout).toContain('services/{orders, payments}');
      expect(drifted.stdout).not.toContain('services//{');

      const reapprove = run(['approve', '--node', 'services'], dir);
      expect(reapprove.status).toBe(0);
      expect(reapprove.stdout).toContain('services/orders');
      expect(reapprove.stdout).toContain('services/payments');

      expect(run(['check'], dir).status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- 4. Relational layer: a `uses` dependency makes the dependent drift when
  //        the dependency's metadata changes. ---

  it("4: a 'uses' dependency makes services/orders drift when services/payments metadata changes", () => {
    const dir = deterministicFixture('relational');
    try {
      // Add a `uses` relation from orders -> payments (allowed: service uses service).
      writeFileSync(
        ordersNodeYaml(dir),
        [
          'name: OrdersService',
          'description: Creates and retrieves customer orders.',
          'type: service',
          'aspects:',
          '  - wip-rule',
          'relations:',
          '  - type: uses',
          '    target: services/payments',
          'mapping:',
          '  - src/services/orders.ts',
          '',
        ].join('\n'),
        'utf-8',
      );

      approveBoth(dir);

      // Change the dependency's metadata — orders depends on payments, so orders drifts.
      appendFileSync(paymentsNodeYaml(dir), '\n# cascade-trigger comment\n');

      const drifted = run(['check'], dir);
      expect(drifted.status).toBe(1);
      expect(drifted.stdout).toContain("dependency 'services/payments' metadata changed");
      // The cascade lands on the DEPENDENT node, services/orders.
      expect(drifted.stdout).toContain('services/orders');

      // Re-approve both nodes (dependency first, then the dependent) to clear it.
      const reapprove = run(
        ['approve', '--node', 'services/payments', '--node', 'services/orders'],
        dir,
      );
      expect(reapprove.status).toBe(0);

      expect(run(['check'], dir).status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- 5. Flow layer. ---
  //
  // BUG (documented, see final report): the cascade mechanic documents a flow
  // change as an upstream cause that cascades to participants, but the
  // implementation does NOT track the flow yaml file's hash. Appending a comment
  // (or even changing the flow description) to a flow yaml produces NO drift, so
  // there is no "flow 'order-processing' changed" cascade message and
  // `yg check` stays green. The ONLY way a flow influences participant drift is
  // by changing the EFFECTIVE ASPECT SET (adding/removing an aspect that was not
  // otherwise present), and even then the cascade is attributed to the ASPECT,
  // never to the flow.
  //
  // This test documents the EXPECTED-vs-ACTUAL gap WITHOUT working around it:
  //   (a) it asserts the ACTUAL current behavior — a flow-yaml comment edit
  //       produces no cascade and `yg check` stays exit 0 — and flags that this
  //       contradicts the documented mechanic; and
  //   (b) it still exercises the documented clearing command, `yg approve
  //       --flow`, proving that command path is wired up (it processes flow
  //       participants and exits 0 when there is no cascade drift to clear).
  it('5: BUG — a flow-yaml comment edit does NOT cascade to participants (documented divergence)', () => {
    const dir = deterministicFixture('flow');
    try {
      approveBoth(dir);

      // Documented mechanic says this SHOULD cascade to both flow participants.
      appendFileSync(flowYaml(dir), '\n# cascade-trigger comment\n');

      // ACTUAL behavior: no cascade is detected — check stays green. If the CLI
      // is ever fixed to track the flow file, this assertion will start failing
      // and should be replaced with a positive cascade assertion plus an
      // `yg approve --flow order-processing` clear step.
      const afterEdit = run(['check'], dir);
      expect(afterEdit.status).toBe(0);
      expect(afterEdit.stdout).not.toContain("flow 'order-processing'");
      expect(afterEdit.stdout).not.toContain('cascade');

      // The documented clearing command is still wired up: with no cascade drift
      // to clear it processes the flow's participants and exits 0.
      const flowApprove = run(['approve', '--flow', 'order-processing'], dir);
      expect(flowApprove.status).toBe(0);
      expect(flowApprove.all).toContain('order-processing');

      // Repo stays green afterwards.
      expect(run(['check'], dir).status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
