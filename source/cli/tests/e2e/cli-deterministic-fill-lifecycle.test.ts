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
// CLI E2E — the DETERMINISTIC FILL LIFECYCLE (verdict-lock model).
//
// The lifecycle is now: cold `yg check` (unverified, exit 1) → `yg check
// --approve` (deterministic fill, writes .yggdrasil/yg-lock.json) → `yg check`
// (verified, exit 0) → source edit → unverified → `yg check --approve` (refused
// or approved) → fix → fill → verified. There is no `yg approve` command, no
// `.drift-state/`, and no drift/baseline vocabulary — state lives entirely in
// .yggdrasil/yg-lock.json and the states are verified / unverified / refused.
//
// Hermetic — no LLM, no network dependency: the fixture's LLM aspect is stripped
// so the deterministic `no-todo-comments` (enforced) and `requires-named-export`
// (advisory) checks drive every refuse/pass outcome. Each test builds its own
// temp copy of the committed e2e-lifecycle fixture and removes it in a finally.
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'e2e-lifecycle');

const distExists = existsSync(BIN_PATH);

// A dead loopback endpoint. Pointing the reviewer at this makes the LLM aspect
// path unreachable, so a fill records deterministic-only verdicts and never
// produces an unreliable (or environment-dependent) LLM verdict. The
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
  const dir = mkdtempSync(path.join(tmpdir(), `yg-fill-${label}-`));
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

/**
 * Copy the fixture and strip the LLM aspect (`has-doc-comment`) so the node's
 * effective aspects are purely deterministic. This makes the fill lifecycle
 * hermetic: no network, no LLM verdict, fully reproducible — the
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

/** The single state file of the verdict-lock model (replaces .drift-state/<node>.json). */
const lockPath = (dir: string) => path.join(dir, '.yggdrasil', 'yg-lock.json');

interface LockEntry {
  hash: string;
  verdict: 'approved' | 'refused';
  reason?: string;
  touched?: unknown[];
}
interface Lock {
  version: number;
  verdicts: Record<string, Record<string, LockEntry>>;
  nodes: Record<string, { source?: string }>;
}

/** Parse the lock file. */
function readLock(dir: string): Lock {
  return JSON.parse(readFileSync(lockPath(dir), 'utf-8')) as Lock;
}

/** The stored verdict for an (aspect, node) pair, or undefined if absent. */
function verdictFor(lock: Lock, aspectId: string, node: string): LockEntry | undefined {
  return lock.verdicts[aspectId]?.[`node:${node}`];
}

// ---------------------------------------------------------------------------
// A–E: Deterministic fill lifecycle. Hermetic — no LLM, no network dependency.
// ---------------------------------------------------------------------------

describe.skipIf(!distExists)('CLI E2E — deterministic fill/verify/refuse/status/suppress lifecycle', () => {
  // --- A. Fill + verify lifecycle ---

  it('A1: cold check is unverified (exit 1); the fill writes the lock and a later check is verified (exit 0)', () => {
    const dir = deterministicFixture('a1');
    try {
      // Cold start: no lock yet → every pair is unverified, check fails.
      const cold = run(['check'], dir);
      expect(cold.status).toBe(1);
      expect(cold.stdout).toContain('unverified');
      expect(cold.stdout).toContain('services/orders');
      expect(existsSync(lockPath(dir))).toBe(false);

      // Fill: deterministic checks run locally and record approved verdicts.
      const fill = run(['check', '--approve'], dir);
      expect(fill.status).toBe(0);
      expect(fill.stdout).toContain('[det] no-todo-comments on node:services/orders — approved');
      expect(fill.stdout).toContain('yg check: PASS');
      // The fill writes the verdict lock with an approved entry for the pair.
      expect(existsSync(lockPath(dir))).toBe(true);
      const lock = readLock(dir);
      expect(verdictFor(lock, 'no-todo-comments', 'services/orders')?.verdict).toBe('approved');

      // A subsequent plain check sees valid verdicts and passes with no fill.
      const verified = run(['check'], dir);
      expect(verified.status).toBe(0);
      expect(verified.stdout).toContain('yg check: PASS');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('A2: after a fill, check reports no unverified pair for that node', () => {
    const dir = deterministicFixture('a2');
    try {
      expect(run(['check', '--approve'], dir).status).toBe(0);
      const { stdout } = run(['check'], dir);
      // No unverified line should mention services/orders.
      const unverifiedForOrders = stdout
        .split('\n')
        .filter((l) => l.includes('unverified') && l.includes('services/orders'));
      expect(unverifiedForOrders.length).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('A3: a TODO source edit invalidates the verdict — check reports the pair as unverified (exit 1)', () => {
    const dir = deterministicFixture('a3');
    try {
      expect(run(['check', '--approve'], dir).status).toBe(0);
      appendFileSync(ordersFile(dir), '\n// TODO: refactor this later\n');
      const { status, stdout } = run(['check'], dir);
      expect(status).toBe(1);
      // The source hash changed, so the stored verdict no longer hashes-valid.
      expect(stdout).toContain('unverified');
      expect(stdout).toContain('services/orders');
      expect(stdout).toContain("No valid verdict for aspect 'no-todo-comments' on node:services/orders.");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('A4: filling with the enforced no-todo-comments violation present records a refused verdict (exit 1)', () => {
    const dir = deterministicFixture('a4');
    try {
      expect(run(['check', '--approve'], dir).status).toBe(0);
      appendFileSync(ordersFile(dir), '\n// TODO: refactor this later\n');
      const fill = run(['check', '--approve'], dir);
      expect(fill.status).toBe(1);
      // The fill line records the refusal, and the check renderer surfaces the
      // enforced refusal as a blocking error (first line of the stored `what`).
      expect(fill.stdout).toContain('[det] no-todo-comments on node:services/orders — refused');
      expect(fill.stdout).toContain(
        "Aspect 'no-todo-comments' is refused on node:services/orders by a deterministic check.",
      );
      // The lock records the refused verdict (with the violation text in reason).
      const lock = readLock(dir);
      expect(verdictFor(lock, 'no-todo-comments', 'services/orders')?.verdict).toBe('refused');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('A5: removing the TODO and re-filling records an approved verdict again (exit 0)', () => {
    const dir = deterministicFixture('a5');
    try {
      expect(run(['check', '--approve'], dir).status).toBe(0);
      const original = readFileSync(ordersFile(dir), 'utf-8');
      // Introduce then remove the violation.
      appendFileSync(ordersFile(dir), '\n// TODO: refactor this later\n');
      expect(run(['check', '--approve'], dir).status).toBe(1);
      writeFileSync(ordersFile(dir), original, 'utf-8');
      const fill = run(['check', '--approve'], dir);
      expect(fill.status).toBe(0);
      expect(fill.stdout).toContain('[det] no-todo-comments on node:services/orders — approved');
      expect(fill.stdout).toContain('yg check: PASS');
      const lock = readLock(dir);
      expect(verdictFor(lock, 'no-todo-comments', 'services/orders')?.verdict).toBe('approved');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- B. Status levels ---

  it('B6: an advisory requires-named-export refusal is a non-blocking warning — fill and check both exit 0', () => {
    const dir = deterministicFixture('b6');
    try {
      // Remove the named exports so the advisory aspect flags the file.
      const stripped = readFileSync(paymentsFile(dir), 'utf-8').replace(/^export /gm, '');
      writeFileSync(paymentsFile(dir), stripped, 'utf-8');

      const fill = run(['check', '--approve'], dir);
      expect(fill.status).toBe(0); // advisory refusal does NOT block the fill
      // The advisory pair is recorded refused, but the check renders it as a warning.
      expect(fill.stdout).toContain('[det] requires-named-export on node:services/payments — refused');
      expect(fill.stdout).toContain('advisory');
      expect(fill.stdout).toContain('requires-named-export');

      const check = run(['check'], dir);
      expect(check.status).toBe(0); // advisory warning does NOT fail check
      expect(check.stdout).toContain('advisory');
      expect(check.stdout).toContain('requires-named-export');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('B7: a draft wip-rule is never evaluated — a WIP line is not flagged and produces no pair', () => {
    const dir = deterministicFixture('b7');
    try {
      appendFileSync(ordersFile(dir), '\n// WIP marker here\n');
      const fill = run(['check', '--approve'], dir);
      // The draft aspect never produces a pair, so the fill never mentions it...
      expect(fill.stdout).not.toContain('[det] wip-rule');
      // ...and the WIP line itself caused no deterministic refusal (no TODO present).
      expect(fill.stdout).not.toContain('refused');
      expect(fill.status).toBe(0);
      // The draft is still counted in the header metrics.
      expect(fill.stdout).toContain('1 draft');
      // No verdict is recorded for the draft aspect.
      const lock = readLock(dir);
      expect(lock.verdicts['wip-rule']).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- C. Suppress ---

  it('C8: yg-suppress waives the violation; removing it makes the fill refuse again', () => {
    const dir = deterministicFixture('c8');
    try {
      expect(run(['check', '--approve'], dir).status).toBe(0);

      // Single-line suppress: it covers the immediately-following line.
      const withSuppress =
        readFileSync(ordersFile(dir), 'utf-8') +
        '\n// yg-suppress(no-todo-comments) known debt, tracked in the issue tracker\n' +
        '// TODO: refactor this later\n';
      writeFileSync(ordersFile(dir), withSuppress, 'utf-8');

      const suppressed = run(['check', '--approve'], dir);
      expect(suppressed.status).toBe(0); // violation waived
      expect(suppressed.stdout).toContain('[det] no-todo-comments on node:services/orders — approved');
      expect(suppressed.stdout).toContain('yg check: PASS');

      // Remove the suppress marker but keep the TODO line.
      const withoutSuppress = readFileSync(ordersFile(dir), 'utf-8')
        .split('\n')
        .filter((l) => !l.includes('yg-suppress(no-todo-comments)'))
        .join('\n');
      writeFileSync(ordersFile(dir), withoutSuppress, 'utf-8');

      const refused = run(['check', '--approve'], dir);
      expect(refused.status).toBe(1); // the suppress was what waived it
      expect(refused.stdout).toContain('[det] no-todo-comments on node:services/orders — refused');
      expect(refused.stdout).toContain(
        "Aspect 'no-todo-comments' is refused on node:services/orders by a deterministic check.",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- D. Aspect change invalidates verdicts (the upstream-input change) ---

  it('D9: editing the aspect check.mjs invalidates both nodes (unverified); a re-fill restores them', () => {
    const dir = deterministicFixture('d9');
    try {
      expect(run(['check', '--approve'], dir).status).toBe(0);

      // Trivial no-op change to the aspect's implementation. The aspect bytes are
      // an input to the pair hash, so both nodes' no-todo-comments verdicts go stale.
      appendFileSync(
        path.join(dir, '.yggdrasil', 'aspects', 'no-todo-comments', 'check.mjs'),
        '\n// trivial no-op comment\n',
      );

      const drifted = run(['check'], dir);
      expect(drifted.status).toBe(1);
      // Both nodes report the no-todo-comments pair as unverified.
      expect(drifted.stdout).toContain('unverified');
      expect(drifted.stdout).toContain("No valid verdict for aspect 'no-todo-comments' on node:services/orders.");
      expect(drifted.stdout).toContain("No valid verdict for aspect 'no-todo-comments' on node:services/payments.");

      const refill = run(['check', '--approve'], dir);
      expect(refill.status).toBe(0);
      expect(refill.stdout).toContain('[det] no-todo-comments on node:services/orders — approved');
      expect(refill.stdout).toContain('[det] no-todo-comments on node:services/payments — approved');

      // The pairs are valid again after the re-fill.
      const cleared = run(['check'], dir);
      expect(cleared.status).toBe(0);
      expect(cleared.stdout).toContain('yg check: PASS');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- E. Guards / errors ---
  //
  // The old E10/E11 guards (`approve --node + --aspect` multi-target, `approve
  // --aspect --dry-run`) targeted the removed `yg approve` command and its
  // batch-targeting / dry-run flags. Fill is repo-wide with no scoping and no
  // dry-run, so those guards no longer exist. E12 (approve of a nonexistent
  // node) is re-pointed onto `yg aspect-test --node`, which keeps the
  // node-not-found contract. E13 (tree numeric validation) is unchanged.

  it('E12: aspect-test of a nonexistent node returns node-not-found (exit 1)', () => {
    const dir = copyFixture('e12');
    try {
      const { status, all } = run(['aspect-test', '--aspect', 'no-todo-comments', '--node', 'does/not/exist'], dir);
      expect(status).toBe(1);
      expect(all).toContain("Node 'does/not/exist' not found.");
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

  // --- Reviewer-unreachable fail-closed: an enforced LLM aspect that cannot be
  // verified must leave its pair unverified, NOT silently record an approved
  // verdict over code the reviewer never saw. ---

  it('the LLM reviewer being unreachable during a fill fails closed (exit 1) and records no LLM verdict', () => {
    const dir = copyFixture('unreachable');
    try {
      killReviewer(dir);
      const fill = run(['check', '--approve'], dir);
      expect(fill.status).toBe(1);
      expect(fill.all).toContain('unreachable');
      // Fail-closed: the LLM pair is left unverified, no verdict written for it,
      // so a later check cannot go green over the unverified LLM aspect.
      const lock = readLock(dir);
      expect(lock.verdicts['has-doc-comment']).toBeUndefined();
      // The deterministic pairs DID fill (they need no reviewer).
      expect(verdictFor(lock, 'no-todo-comments', 'services/orders')?.verdict).toBe('approved');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
