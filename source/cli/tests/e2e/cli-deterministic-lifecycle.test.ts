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
// path unreachable, so `yg approve` records deterministic-only verdicts and
// never produces an unreliable (or environment-dependent) LLM verdict. The
// reviewer-unreachable test uses this so its assertion holds on ANY machine —
// port 1 never has a listener — with no dependency on any real endpoint being
// absent.
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
  const dir = mkdtempSync(path.join(tmpdir(), `yg-detlc-${label}-`));
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
 * Repoint the reviewer endpoint at the dead loopback address. Rewrites whatever
 * `endpoint:` the fixture config carries to the guaranteed-dead port-1 address,
 * so the reviewer is ALWAYS unreachable regardless of the machine — no reliance
 * on any specific external host being present or absent.
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

const baselinePath = (dir: string, node: string) =>
  path.join(dir, '.yggdrasil', '.drift-state', ...node.split('/')) + '.json';

// ---------------------------------------------------------------------------
// A–E: Deterministic lifecycle. Hermetic — no LLM, no network dependency.
// ---------------------------------------------------------------------------

describe.skipIf(!distExists)('CLI E2E — deterministic approve/drift/cascade/status/suppress lifecycle', () => {
  // --- A. Approve + drift lifecycle ---

  it('A1: fresh approve records a baseline and exits 0', () => {
    const dir = deterministicFixture('a1');
    try {
      const { status, stdout } = run(['approve', '--node', 'services/orders'], dir);
      expect(status).toBe(0);
      expect(stdout).toContain('Approved: services/orders');
      expect(existsSync(baselinePath(dir, 'services/orders'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('A2: after approving, check reports no source drift for that node', () => {
    const dir = deterministicFixture('a2');
    try {
      expect(run(['approve', '--node', 'services/orders'], dir).status).toBe(0);
      const { stdout } = run(['check'], dir);
      // No source-drift line should mention services/orders (payments is still
      // unapproved, but that is a different node and a different error kind).
      const sourceDriftForOrders = stdout
        .split('\n')
        .filter((l) => l.includes('drift') && l.includes('services/orders') && l.includes('Source files'));
      expect(sourceDriftForOrders.length).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('A3: a TODO source edit is reported as source drift by check', () => {
    const dir = deterministicFixture('a3');
    try {
      run(['approve', '--node', 'services/orders'], dir);
      run(['approve', '--node', 'services/payments'], dir);
      appendFileSync(ordersFile(dir), '\n// TODO: refactor this later\n');
      const { status, stdout } = run(['check'], dir);
      expect(status).toBe(1);
      expect(stdout).toContain('drift');
      expect(stdout).toContain('services/orders');
      expect(stdout).toContain('Source files changed');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('A4: approve refuses on the enforced no-todo-comments violation (exit 1)', () => {
    const dir = deterministicFixture('a4');
    try {
      run(['approve', '--node', 'services/orders'], dir);
      appendFileSync(ordersFile(dir), '\n// TODO: refactor this later\n');
      const { status, stdout } = run(['approve', '--node', 'services/orders'], dir);
      expect(status).toBe(1);
      expect(stdout).toContain('no-todo-comments');
      expect(stdout).toContain('NOT SATISFIED');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('A5: removing the TODO and re-approving succeeds (exit 0)', () => {
    const dir = deterministicFixture('a5');
    try {
      run(['approve', '--node', 'services/orders'], dir);
      const original = readFileSync(ordersFile(dir), 'utf-8');
      // Introduce then remove the violation.
      appendFileSync(ordersFile(dir), '\n// TODO: refactor this later\n');
      expect(run(['approve', '--node', 'services/orders'], dir).status).toBe(1);
      writeFileSync(ordersFile(dir), original, 'utf-8');
      const { status, stdout } = run(['approve', '--node', 'services/orders'], dir);
      expect(status).toBe(0);
      expect(stdout).toContain('Approved: services/orders');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- B. Status levels ---

  it('B6: advisory requires-named-export violation does not block approve or check', () => {
    const dir = deterministicFixture('b6');
    try {
      // Remove the named exports so the advisory aspect flags the file.
      const stripped = readFileSync(paymentsFile(dir), 'utf-8').replace(/^export /gm, '');
      writeFileSync(paymentsFile(dir), stripped, 'utf-8');
      // Approve the other node clean so the final check has no other errors.
      expect(run(['approve', '--node', 'services/orders'], dir).status).toBe(0);

      const approve = run(['approve', '--node', 'services/payments'], dir);
      expect(approve.status).toBe(0); // advisory does NOT block approve
      expect(approve.stdout).toContain('advisory');
      expect(approve.stdout).toContain('requires-named-export');

      const check = run(['check'], dir);
      expect(check.status).toBe(0); // advisory warning does NOT fail check
      expect(check.stdout).toContain('advisory');
      expect(check.stdout).toContain('requires-named-export');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('B7: draft wip-rule is never evaluated — a WIP line is not flagged as a violation', () => {
    const dir = deterministicFixture('b7');
    try {
      appendFileSync(ordersFile(dir), '\n// WIP marker here\n');
      const { stdout } = run(['approve', '--node', 'services/orders'], dir);
      // The reviewer announces it is skipping the draft aspect...
      expect(stdout).toContain('wip-rule');
      expect(stdout).toContain('skipped');
      expect(stdout).toContain('draft');
      // ...and never reports wip-rule as a violation.
      expect(stdout).not.toContain('wip-rule — NOT SATISFIED');
      // The WIP line itself caused no deterministic refusal (no TODO present).
      expect(stdout).not.toContain('NOT SATISFIED');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- C. Suppress ---

  it('C8: yg-suppress waives the violation; removing it makes approve refuse again', () => {
    const dir = deterministicFixture('c8');
    try {
      run(['approve', '--node', 'services/orders'], dir);

      // Single-line suppress: it covers the immediately-following line.
      const withSuppress =
        readFileSync(ordersFile(dir), 'utf-8') +
        '\n// yg-suppress(no-todo-comments) known debt, tracked in the issue tracker\n' +
        '// TODO: refactor this later\n';
      writeFileSync(ordersFile(dir), withSuppress, 'utf-8');

      const suppressed = run(['approve', '--node', 'services/orders'], dir);
      expect(suppressed.status).toBe(0); // violation waived
      expect(suppressed.stdout).toContain('Approved: services/orders');

      // Remove the suppress marker but keep the TODO line.
      const withoutSuppress = readFileSync(ordersFile(dir), 'utf-8')
        .split('\n')
        .filter((l) => !l.includes('yg-suppress(no-todo-comments)'))
        .join('\n');
      writeFileSync(ordersFile(dir), withoutSuppress, 'utf-8');

      const refused = run(['approve', '--node', 'services/orders'], dir);
      expect(refused.status).toBe(1); // the suppress was what waived it
      expect(refused.stdout).toContain('no-todo-comments');
      expect(refused.stdout).toContain('NOT SATISFIED');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- D. Cascade ---

  it('D9: editing the aspect check.mjs cascades drift; --aspect batch re-approve clears it', () => {
    const dir = deterministicFixture('d9');
    try {
      expect(run(['approve', '--node', 'services/orders'], dir).status).toBe(0);
      expect(run(['approve', '--node', 'services/payments'], dir).status).toBe(0);

      // Trivial no-op change to the aspect's implementation.
      appendFileSync(
        path.join(dir, '.yggdrasil', 'aspects', 'no-todo-comments', 'check.mjs'),
        '\n// cascade-trigger: trivial no-op comment\n',
      );

      const drifted = run(['check'], dir);
      expect(drifted.status).toBe(1);
      // Upstream cascade is reported and names the changed aspect + both nodes.
      expect(drifted.stdout).toContain('cascade');
      expect(drifted.stdout).toContain("aspect 'no-todo-comments' check.mjs changed");

      const reapprove = run(['approve', '--aspect', 'no-todo-comments'], dir);
      expect(reapprove.status).toBe(0);
      expect(reapprove.stdout).toContain('services/orders');
      expect(reapprove.stdout).toContain('services/payments');
      expect(reapprove.stdout).toContain('2 approved');

      // The cascade for this aspect is gone after the batch re-approve.
      const cleared = run(['check'], dir);
      expect(cleared.stdout).not.toContain("aspect 'no-todo-comments' check.mjs changed");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- E. Guards / errors ---

  it('E10: approve with both --node and --aspect is rejected (exit 1)', () => {
    const dir = copyFixture('e10');
    try {
      const { status, all } = run(
        ['approve', '--node', 'services/orders', '--aspect', 'no-todo-comments'],
        dir,
      );
      expect(status).toBe(1);
      expect(all).toContain('Multiple targets specified');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('E11: approve --aspect --dry-run is rejected (dry-run only with --node)', () => {
    const dir = copyFixture('e11');
    try {
      const { status, all } = run(['approve', '--aspect', 'no-todo-comments', '--dry-run'], dir);
      expect(status).toBe(1);
      expect(all).toContain('--dry-run is only supported with --node');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('E12: approve of a nonexistent node returns node-not-found (exit 1)', () => {
    const dir = copyFixture('e12');
    try {
      const { status, all } = run(['approve', '--node', 'does/not/exist'], dir);
      expect(status).toBe(1);
      expect(all).toContain('does not exist');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('E13: tree --depth with a non-numeric value is rejected (exit 1)', () => {
    const dir = copyFixture('e13');
    try {
      const { status, all } = run(['tree', '--depth', 'notanumber'], dir);
      expect(status).toBe(1);
      expect(all).toContain('--depth');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- Reviewer-unreachable fail-closed (#2): an enforced LLM aspect that cannot
  // be verified must refuse, NOT silently commit a structural-only baseline. ---

  it('approve with the LLM reviewer unreachable fails closed (exit 1) and records no baseline', () => {
    const dir = copyFixture('unreachable');
    try {
      killReviewer(dir);
      const { status, all } = run(['approve', '--node', 'services/orders'], dir);
      expect(status).toBe(1);
      expect(all).toContain('unreachable');
      // Fail-closed: no baseline is written, so the node's drift stays visible
      // and a later yg check cannot go green over the unverified LLM aspect.
      expect(existsSync(baselinePath(dir, 'services/orders'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
