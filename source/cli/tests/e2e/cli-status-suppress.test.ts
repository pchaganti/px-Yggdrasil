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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'e2e-lifecycle');

const distExists = existsSync(BIN_PATH);

// A dead loopback endpoint. Pointing the reviewer at this makes the LLM aspect
// path unreachable, so `yg approve` never produces an environment-dependent LLM
// verdict — port 1 never has a listener, on ANY machine, with no reliance on a
// real endpoint being present or absent. Used by killReviewer().
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
  const dir = mkdtempSync(path.join(tmpdir(), `yg-status-${label}-`));
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

/**
 * Copy the fixture and strip the LLM aspect (`has-doc-comment`) so the node's
 * effective aspects are purely deterministic. This makes the approve/check
 * lifecycle hermetic: no network, no LLM verdict, fully reproducible — the
 * `no-todo-comments` (enforced), `requires-named-export` (advisory) and
 * `wip-rule` (draft) deterministic aspects drive every outcome.
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
 * Repoint the reviewer endpoint at the dead loopback address. Rewrites whatever
 * `endpoint:` the fixture config carries to the guaranteed-dead port-1 address,
 * so the LLM reviewer is ALWAYS unreachable regardless of the machine. The
 * deterministicFixture already removes the only LLM aspect, but killing the
 * endpoint as well guarantees no test in this suite can reach out over the
 * network even if a future fixture edit reintroduces an LLM aspect.
 */
function killReviewer(dir: string): void {
  const cfgPath = path.join(dir, '.yggdrasil', 'yg-config.yaml');
  const cfg = readFileSync(cfgPath, 'utf-8').replace(
    /endpoint:\s*["']?[^"'\n]+["']?/,
    `endpoint: "${DEAD_ENDPOINT}"`,
  );
  writeFileSync(cfgPath, cfg, 'utf-8');
}

const ordersFile = (dir: string) => path.join(dir, 'src', 'services', 'orders.ts');
const paymentsFile = (dir: string) => path.join(dir, 'src', 'services', 'payments.ts');

const aspectYaml = (dir: string, aspect: string) =>
  path.join(dir, '.yggdrasil', 'aspects', aspect, 'yg-aspect.yaml');
const ordersNodeYaml = (dir: string) =>
  path.join(dir, '.yggdrasil', 'model', 'services', 'orders', 'yg-node.yaml');

/** Build a hermetic, LLM-free copy of the fixture (strip LLM aspect + kill endpoint). */
function hermeticFixture(label: string): string {
  const dir = deterministicFixture(label);
  killReviewer(dir);
  return dir;
}

// ---------------------------------------------------------------------------
// Status-flip drift/render semantics + suppress edge cases, exercised through
// the REAL built binary against fresh per-test fixture copies. Fully hermetic:
// no LLM, no network, no wall-clock or random sources in any assertion.
// ---------------------------------------------------------------------------

describe.skipIf(!distExists)('CLI E2E — status-flip drift/render semantics + suppress edge cases', () => {
  // --- 1. draft -> advisory makes the aspect newly active (no baseline -> drift) ---

  it('1: flipping wip-rule draft->advisory makes check fail (newly-active, no baseline); approve clears it', () => {
    const dir = hermeticFixture('newly-active');
    try {
      // Approve both nodes while wip-rule is still DRAFT (dormant, no verdict).
      expect(run(['approve', '--node', 'services/orders'], dir).status).toBe(0);
      expect(run(['approve', '--node', 'services/payments'], dir).status).toBe(0);
      expect(run(['check'], dir).status).toBe(0);

      // Promote wip-rule draft -> advisory. It is an OWN aspect of services/orders,
      // so it becomes effective there with no reviewer baseline yet.
      const flipped = readFileSync(aspectYaml(dir, 'wip-rule'), 'utf-8').replace(
        /^status: draft$/m,
        'status: advisory',
      );
      writeFileSync(aspectYaml(dir, 'wip-rule'), flipped, 'utf-8');

      const drifted = run(['check'], dir);
      expect(drifted.status).toBe(1);
      // The newly-active aspect has no baseline — check reports it explicitly.
      expect(drifted.stdout).toContain('aspect-newly-active');
      expect(drifted.stdout).toContain('services/orders');

      // Re-approving the node records the missing verdict and clears the drift.
      const reapprove = run(['approve', '--node', 'services/orders'], dir);
      expect(reapprove.status).toBe(0);
      expect(reapprove.stdout).toContain('Approved: services/orders');

      expect(run(['check'], dir).status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- 2. advisory <-> enforced is a render flip, not a source change ---

  it('2: flipping no-todo-comments enforced->advisory (check.mjs unchanged) re-approves clean; check passes', () => {
    const dir = hermeticFixture('render-flip');
    try {
      // Approve both nodes with no-todo-comments at its default ENFORCED status.
      // The source is clean (no TODO), so both approve.
      expect(run(['approve', '--node', 'services/orders'], dir).status).toBe(0);
      expect(run(['approve', '--node', 'services/payments'], dir).status).toBe(0);
      expect(run(['check'], dir).status).toBe(0);

      // Flip the aspect status ONLY — check.mjs is left byte-for-byte unchanged.
      const before = readFileSync(aspectYaml(dir, 'no-todo-comments'), 'utf-8');
      const after = before.replace(/^status: enforced$/m, 'status: advisory');
      expect(after).not.toBe(before); // guard: the flip actually applied
      writeFileSync(aspectYaml(dir, 'no-todo-comments'), after, 'utf-8');

      // The status change cascades (the aspect definition changed), so re-approve
      // the affected nodes. No source file changed and the code is clean, so each
      // approve exits 0 with NO refusal — this is a render flip, not source drift.
      const ordersApprove = run(['approve', '--node', 'services/orders'], dir);
      expect(ordersApprove.status).toBe(0);
      expect(ordersApprove.stdout).toContain('Approved: services/orders');
      expect(ordersApprove.stdout).not.toContain('NOT SATISFIED');

      expect(run(['approve', '--node', 'services/payments'], dir).status).toBe(0);

      expect(run(['check'], dir).status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- 3. explicit attach-site status that relaxes a stricter cascade is rejected ---

  it('3: attaching no-todo-comments with explicit status:advisory below its enforced default is an aspect-status-downgrade error', () => {
    const dir = hermeticFixture('downgrade');
    try {
      // Re-author the orders node so it attaches no-todo-comments (whose aspect
      // default is `enforced`) with an explicit, weaker `status: advisory`.
      writeFileSync(
        ordersNodeYaml(dir),
        [
          'name: OrdersService',
          'description: Creates and retrieves customer orders.',
          'type: service',
          'aspects:',
          '  - wip-rule',
          '  - id: no-todo-comments',
          '    status: advisory',
          'mapping:',
          '  - src/services/orders.ts',
          '',
        ].join('\n'),
        'utf-8',
      );

      const check = run(['check'], dir);
      expect(check.status).toBe(1);
      // Exact validator code: an explicit attach-site status cannot relax a
      // stricter cascading anchor (here the aspect-default `enforced`).
      expect(check.stdout).toContain('aspect-status-downgrade');
      expect(check.stdout).toContain('services/orders');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- 4. bracket wildcard suppress waives every aspect within its range ---

  it('4: a yg-suppress-disable(*)..enable(*) bracket waives a TODO inside the range; approve exits 0', () => {
    const dir = hermeticFixture('bracket-suppress');
    try {
      // Baseline approve on the clean source.
      expect(run(['approve', '--node', 'services/payments'], dir).status).toBe(0);

      // Append a block carrying a TODO (would trip enforced no-todo-comments) and
      // a non-exported helper, wrapped entirely in a wildcard bracket suppress.
      appendFileSync(
        paymentsFile(dir),
        [
          '',
          '// yg-suppress-disable(*) legacy reconciliation path, tracked in the issue tracker',
          '// TODO: migrate the legacy reconciliation path',
          'function legacyReconcile(p: Payment): Payment {',
          '  return p;',
          '}',
          '// yg-suppress-enable(*)',
          '',
        ].join('\n'),
        'utf-8',
      );

      const approve = run(['approve', '--node', 'services/payments'], dir);
      // Everything inside the bracket range is waived -> no refusal.
      expect(approve.status).toBe(0);
      expect(approve.stdout).toContain('Approved: services/payments');
      expect(approve.stdout).not.toContain('NOT SATISFIED');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- 4b. control: the same TODO WITHOUT the bracket refuses (proves the bracket did the waiving) ---

  it('4b: the identical TODO block WITHOUT bracket markers refuses approve (proves the suppress is what waived it)', () => {
    const dir = hermeticFixture('bracket-control');
    try {
      expect(run(['approve', '--node', 'services/payments'], dir).status).toBe(0);

      // Same payload, but no suppress markers.
      appendFileSync(
        paymentsFile(dir),
        [
          '',
          '// TODO: migrate the legacy reconciliation path',
          'function legacyReconcile(p: Payment): Payment {',
          '  return p;',
          '}',
          '',
        ].join('\n'),
        'utf-8',
      );

      const approve = run(['approve', '--node', 'services/payments'], dir);
      expect(approve.status).toBe(1);
      expect(approve.stdout).toContain('no-todo-comments');
      expect(approve.stdout).toContain('NOT SATISFIED');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- 5. single-line suppress is contextual: it covers only the next line ---

  it('5: a single-line yg-suppress over ONE TODO leaves a second un-suppressed TODO flagged; approve exits 1', () => {
    const dir = hermeticFixture('single-line-suppress');
    try {
      expect(run(['approve', '--node', 'services/orders'], dir).status).toBe(0);

      // First TODO is suppressed (marker on the line immediately above it);
      // the second TODO is left bare.
      appendFileSync(
        ordersFile(dir),
        [
          '',
          '// yg-suppress(no-todo-comments) known debt, tracked in the issue tracker',
          '// TODO: first todo is suppressed',
          '// TODO: second todo is NOT suppressed',
          '',
        ].join('\n'),
        'utf-8',
      );

      const approve = run(['approve', '--node', 'services/orders'], dir);
      expect(approve.status).toBe(1);
      expect(approve.stdout).toContain('no-todo-comments');
      expect(approve.stdout).toContain('NOT SATISFIED');
      // Exactly ONE TODO is reported — the un-suppressed second one. The single
      // suppress covered only the line directly beneath it, not both TODOs.
      const todoViolations = approve.stdout
        .split('\n')
        .filter((l) => l.includes('TODO comment found'));
      expect(todoViolations.length).toBe(1);
      // The lone reported violation is the second TODO. The appended block places
      // the suppress marker on the original last line + 2, the first (suppressed)
      // TODO on +3 and the second (flagged) TODO on +4. The original file is 15
      // lines (a trailing newline keeps line 15 empty), so the flagged TODO lands
      // on line 18 — and the suppressed first TODO on line 17 is NOT reported.
      expect(todoViolations[0]).toContain('orders.ts:18');
      expect(approve.stdout).not.toContain('orders.ts:17');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- 6. suppressing a draft aspect is a no-op (the reviewer never runs it) ---

  it('6: yg-suppress(wip-rule) near a WIP marker is inert while wip-rule is draft; approve exits 0 with no suppress error', () => {
    const dir = hermeticFixture('draft-suppress-noop');
    try {
      expect(run(['approve', '--node', 'services/orders'], dir).status).toBe(0);

      // wip-rule (draft) would flag any line containing "WIP" if it were active.
      // Suppressing a draft aspect is documented as a no-op: the reviewer never
      // runs the aspect, so there is nothing to waive and no error to raise.
      appendFileSync(
        ordersFile(dir),
        [
          '',
          '// yg-suppress(wip-rule) draft aspect, suppress should be inert',
          '// WIP marker here',
          '',
        ].join('\n'),
        'utf-8',
      );

      const approve = run(['approve', '--node', 'services/orders'], dir);
      expect(approve.status).toBe(0);
      expect(approve.stdout).toContain('Approved: services/orders');
      // The draft aspect is skipped, not evaluated, regardless of the suppress.
      expect(approve.stdout).toContain('wip-rule');
      expect(approve.stdout).toContain('skipped');
      // No violation, and no error about the suppress marker itself.
      expect(approve.stdout).not.toContain('NOT SATISFIED');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
