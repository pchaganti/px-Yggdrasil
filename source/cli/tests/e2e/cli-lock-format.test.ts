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
// LOCK FILE FORMAT — `.yggdrasil/yg-lock.json`.
//
// This suite proves the on-disk shape and the read-boundary gate of the single
// state file the runtime keeps: `.yggdrasil/yg-lock.json`. (The pre-v… typed
// per-node `.drift-state/<node>.json` format this file used to assert is REMOVED
// surface — there is no per-node baseline file anymore; all verdict state lives
// in one lock — so those assertions are replaced WHOLESALE with lock-format
// assertions.)
//
// What is pinned here:
//   * Absent lock = cold start — every pair reports `unverified`, nothing is
//     silently treated as valid.
//   * After a fill the lock is valid JSON: version 1, keys sorted at every
//     level, one verdict entry per line, a trailing newline, unitKeys prefixed
//     `node:`/`file:`, verdict entries carry `hash`+`verdict` (+`touched` on
//     deterministic entries, +`reason` on refused ones), and `nodes.<path>.source`
//     appears only at positive closure (all enforced pairs approved).
//   * A garbled / conflict-markered / unknown-version lock is refused at the read
//     boundary with `lock-invalid` (exit 1) and a copy-pasteable recovery `next:`
//     (git checkout restore, or delete-and-refill).
//   * Deleting the lock returns the repo to a clean cold start that re-fills.
//
// Hermetic: every test copies the e2e-lifecycle fixture into a FRESH mkdtemp dir,
// strips the LLM `has-doc-comment` aspect so every effective aspect is
// deterministic (no network, no LLM), mutates only that copy, and rmSync's it in
// a finally. Every refuse/pass is driven solely by the deterministic check.mjs
// aspects (`no-todo-comments` enforced, `requires-named-export` advisory).
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'e2e-lifecycle');

const distExists = existsSync(BIN_PATH);

function run(
  args: string[],
  cwd: string,
): { stdout: string; stderr: string; status: number | null; all: string } {
  const result = spawnSync('node', [BIN_PATH, ...args], { cwd, encoding: 'utf-8' });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  return { stdout, stderr, status: result.status, all: stdout + stderr };
}

/**
 * Copy the fixture and strip the LLM aspect (`has-doc-comment`) so every node's
 * effective aspects are purely deterministic. Fully hermetic — no network, no
 * LLM verdict; the `no-todo-comments` (enforced) and `requires-named-export`
 * (advisory) deterministic aspects drive every outcome.
 */
function deterministicFixture(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-lock-${label}-`));
  cpSync(FIXTURE, dir, { recursive: true });
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

const lockPath = (dir: string) => path.join(dir, '.yggdrasil', 'yg-lock.json');
const ordersFile = (dir: string) => path.join(dir, 'src', 'services', 'orders.ts');

/** A lock-invalid error is a recoverable STATE problem, never a CLI bug. */
function expectCleanLockError(all: string): void {
  expect(all).not.toContain('Unexpected error');
  expect(all).not.toContain('This is a bug');
  expect(all).not.toContain('file an issue');
}

describe.skipIf(!distExists)('CLI E2E — yg-lock.json format and read-boundary gate', () => {
  // --- 1. Absent lock = cold start: every pair is unverified. ---

  it('1: with no lock present, check is a cold start — every pair reports unverified (exit 1)', () => {
    const dir = deterministicFixture('cold');
    try {
      // The fixture ships NO lock — confirm the cold-start precondition.
      expect(existsSync(lockPath(dir))).toBe(false);

      const cold = run(['check'], dir);
      expect(cold.status).toBe(1);
      expect(cold.all).toContain('unverified');
      // Both deterministic-effective nodes report unverified for the enforced
      // aspect — no entry exists for any pair yet.
      expect(cold.all).toContain("No valid verdict for aspect 'no-todo-comments' on node:services/orders");
      expect(cold.all).toContain("No valid verdict for aspect 'no-todo-comments' on node:services/payments");
      expect(cold.all).toContain('Next: yg check --approve');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- 2. After a fill: the lock is well-formed JSON with the documented shape. ---

  it('2: after a fill the lock is valid JSON — version 1, keys sorted at every level, trailing newline', () => {
    const dir = deterministicFixture('shape');
    try {
      expect(run(['check', '--approve'], dir).status).toBe(0);
      expect(existsSync(lockPath(dir))).toBe(true);

      const raw = readFileSync(lockPath(dir), 'utf-8');
      // Trailing newline.
      expect(raw.endsWith('\n')).toBe(true);

      const parsed = JSON.parse(raw) as {
        version: number;
        verdicts: Record<string, Record<string, Record<string, unknown>>>;
        nodes: Record<string, { source?: string }>;
      };
      expect(parsed.version).toBe(1);

      // Top-level keys are exactly version/verdicts/nodes (and in sorted order
      // when iterated, JSON.stringify preserves insertion order — verify sort).
      const sorted = (keys: string[]): boolean =>
        JSON.stringify(keys) === JSON.stringify([...keys].sort());
      expect(sorted(Object.keys(parsed.verdicts))).toBe(true);
      expect(sorted(Object.keys(parsed.nodes))).toBe(true);
      for (const aspectId of Object.keys(parsed.verdicts)) {
        const byUnit = parsed.verdicts[aspectId];
        expect(sorted(Object.keys(byUnit))).toBe(true);
        for (const unitKey of Object.keys(byUnit)) {
          // Entry field keys are themselves sorted (hash, [reason,] touched, verdict).
          expect(sorted(Object.keys(byUnit[unitKey]))).toBe(true);
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- 3. unitKeys are prefixed; deterministic verdict entries carry hash + verdict + touched. ---

  it('3: deterministic verdict entries carry hash + verdict + touched; unitKeys are node:/file: prefixed', () => {
    const dir = deterministicFixture('entries');
    try {
      expect(run(['check', '--approve'], dir).status).toBe(0);
      const parsed = JSON.parse(readFileSync(lockPath(dir), 'utf-8')) as {
        verdicts: Record<string, Record<string, Record<string, unknown>>>;
      };

      const todo = parsed.verdicts['no-todo-comments'];
      const unitKeys = Object.keys(todo);
      expect(unitKeys).toContain('node:services/orders');
      expect(unitKeys).toContain('node:services/payments');
      // Every unitKey is prefixed `node:` or `file:`.
      for (const k of unitKeys) {
        expect(k.startsWith('node:') || k.startsWith('file:')).toBe(true);
      }

      const entry = todo['node:services/orders'];
      // A clean deterministic verdict: hash + verdict + touched (no reason).
      expect(typeof entry.hash).toBe('string');
      expect(entry.verdict).toBe('approved');
      expect(Array.isArray(entry.touched)).toBe(true);
      // `touched` is empty when the check observed nothing outside its subject.
      expect(entry.touched).toEqual([]);
      expect('reason' in entry).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- 4. nodes.<path>.source is written at positive closure; refused entries carry reason. ---
  //
  // A refused enforced pair leaves the node short of positive closure, so NO
  // `nodes.<path>.source` is recorded for it — while a refused verdict entry
  // carries a human-readable `reason`. The sibling node, which DID reach closure,
  // gets its `source`.

  it('4: nodes.<path>.source appears only at positive closure; a refused entry carries hash + reason + verdict', () => {
    const dir = deterministicFixture('closure');
    try {
      // orders violates the enforced no-todo aspect; payments stays clean.
      appendFileSync(ordersFile(dir), '\n// TODO: this refuses on purpose\n');

      const fill = run(['check', '--approve'], dir);
      // The fill itself completes (det runs, nothing to retry), but the resulting
      // enforced refusal makes the post-fill check FAIL.
      expect(fill.status).toBe(1);
      expect(fill.all).toContain('[det] no-todo-comments on node:services/orders — refused');
      expect(fill.all).toContain('[det] no-todo-comments on node:services/payments — approved');

      const parsed = JSON.parse(readFileSync(lockPath(dir), 'utf-8')) as {
        verdicts: Record<string, Record<string, Record<string, unknown>>>;
        nodes: Record<string, { source?: string }>;
      };

      // The refused entry: hash + reason + touched + verdict, sorted.
      const refused = parsed.verdicts['no-todo-comments']['node:services/orders'];
      expect(refused.verdict).toBe('refused');
      expect(typeof refused.hash).toBe('string');
      expect(typeof refused.reason).toBe('string');
      expect(String(refused.reason)).toContain('TODO comment found');

      // Closure: payments reached all-enforced-approved → has source; orders did
      // NOT reach closure (refused enforced pair) → no source entry.
      expect(typeof parsed.nodes['services/payments']?.source).toBe('string');
      expect(parsed.nodes['services/orders']).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- 5. file: unitKeys for a per:file aspect; the entry is one per subject file. ---

  it('5: a per:file aspect records file: unitKeys, one verdict entry per subject file', () => {
    const dir = deterministicFixture('perfile');
    try {
      // Author a per:file deterministic aspect attached to orders.
      const aspectDir = path.join(dir, '.yggdrasil', 'aspects', 'no-todo-scoped');
      cpSync(path.join(dir, '.yggdrasil', 'aspects', 'no-todo-comments'), aspectDir, { recursive: true });
      writeFileSync(
        path.join(aspectDir, 'yg-aspect.yaml'),
        [
          'name: NoTodoScoped',
          'description: Source files (excluding tests) must not contain TODO comments.',
          'reviewer:',
          '  type: deterministic',
          'status: enforced',
          'scope:',
          '  per: file',
          '  files:',
          '    all_of:',
          '      - path: "src/**/*.ts"',
          '      - not: { path: "**/*.test.ts" }',
          '',
        ].join('\n'),
        'utf-8',
      );
      writeFileSync(
        path.join(dir, '.yggdrasil', 'model', 'services', 'orders', 'yg-node.yaml'),
        [
          'name: OrdersService',
          'description: Creates and retrieves customer orders.',
          'type: service',
          'aspects:',
          '  - wip-rule',
          '  - no-todo-scoped',
          'mapping:',
          '  - src/services/orders.ts',
          '',
        ].join('\n'),
        'utf-8',
      );

      expect(run(['check', '--approve'], dir).status).toBe(0);
      const parsed = JSON.parse(readFileSync(lockPath(dir), 'utf-8')) as {
        verdicts: Record<string, Record<string, Record<string, unknown>>>;
      };

      const scoped = parsed.verdicts['no-todo-scoped'];
      const keys = Object.keys(scoped);
      // The per:file unitKey is the repo-relative POSIX path, `file:`-prefixed.
      expect(keys).toEqual(['file:src/services/orders.ts']);
      expect(scoped['file:src/services/orders.ts'].verdict).toBe('approved');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- 6. Garbled JSON → lock-invalid at the read boundary, with recovery next. ---

  it('6: an unparseable lock is refused with lock-invalid + a copy-pasteable recovery next (exit 1)', () => {
    const dir = deterministicFixture('garbled');
    try {
      expect(run(['check', '--approve'], dir).status).toBe(0);
      writeFileSync(lockPath(dir), 'this is not json {{{', 'utf-8');

      const check = run(['check'], dir);
      expect(check.status).toBe(1);
      expect(check.all).toContain('lock-invalid');
      expect(check.all).toContain('yg-lock.json contains unparseable JSON');
      // Recovery: restore from git OR delete-and-refill.
      expect(check.all).toContain('git checkout HEAD -- .yggdrasil/yg-lock.json');
      expect(check.all).toContain('yg check --approve');
      expectCleanLockError(check.all);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- 7. Unresolved git conflict markers → lock-invalid with the merge-recovery next. ---

  it('7: a conflict-markered lock is refused with lock-invalid + the take-one-side recovery (exit 1)', () => {
    const dir = deterministicFixture('conflict');
    try {
      expect(run(['check', '--approve'], dir).status).toBe(0);
      writeFileSync(
        lockPath(dir),
        [
          '<<<<<<< HEAD',
          '{ "version": 1, "verdicts": {}, "nodes": {} }',
          '=======',
          '{ "version": 1, "verdicts": {}, "nodes": {} }',
          '>>>>>>> other',
          '',
        ].join('\n'),
        'utf-8',
      );

      const check = run(['check'], dir);
      expect(check.status).toBe(1);
      expect(check.all).toContain('lock-invalid');
      expect(check.all).toContain('yg-lock.json contains git conflict markers');
      // The merge-recovery takes one side wholesale, then re-fills.
      expect(check.all).toContain('git checkout --ours -- .yggdrasil/yg-lock.json');
      expect(check.all).toContain('git checkout --theirs -- .yggdrasil/yg-lock.json');
      expect(check.all).toContain('yg check --approve');
      expectCleanLockError(check.all);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- 8. Unknown version → lock-invalid with the migration-style recovery. ---

  it('8: a lock with an unsupported version (99) is refused with lock-invalid (exit 1)', () => {
    const dir = deterministicFixture('version');
    try {
      expect(run(['check', '--approve'], dir).status).toBe(0);
      const parsed = JSON.parse(readFileSync(lockPath(dir), 'utf-8')) as { version: number };
      parsed.version = 99;
      writeFileSync(lockPath(dir), `${JSON.stringify(parsed, null, 2)}\n`, 'utf-8');

      const check = run(['check'], dir);
      expect(check.status).toBe(1);
      expect(check.all).toContain('lock-invalid');
      expect(check.all).toContain('yg-lock.json has unsupported version 99 (this CLI reads version 1)');
      expect(check.all).toContain('git checkout HEAD -- .yggdrasil/yg-lock.json');
      expectCleanLockError(check.all);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- 9. Deleting the lock returns to a clean cold start that re-fills. ---

  it('9: deleting the lock returns to cold start — check goes unverified, a re-fill restores green', () => {
    const dir = deterministicFixture('delete');
    try {
      expect(run(['check', '--approve'], dir).status).toBe(0);
      expect(run(['check'], dir).status).toBe(0);

      // Delete the lock entirely — the repo is back to cold start.
      rmSync(lockPath(dir), { force: true });
      const cold = run(['check'], dir);
      expect(cold.status).toBe(1);
      expect(cold.all).toContain('unverified');

      // Re-fill writes a fresh lock and the repo is green again.
      expect(run(['check', '--approve'], dir).status).toBe(0);
      expect(existsSync(lockPath(dir))).toBe(true);
      expect(run(['check'], dir).status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- 10. Hand-edited verdict hash degrades to unverified — never silently green. ---
  //
  // Tampering with a stored verdict's input hash (the v… per-node
  // baseline-integrity-tamper code is REMOVED surface) does NOT produce a distinct
  // error: the pair simply no longer hashes to the stored value, so it degrades to
  // `unverified`. The load-bearing guarantee is that a tampered verdict NEVER
  // passes as valid — it is re-verified, not trusted.

  it('10: hand-editing a stored verdict hash degrades that pair to unverified — never silently green', () => {
    const dir = deterministicFixture('tamper');
    try {
      expect(run(['check', '--approve'], dir).status).toBe(0);
      expect(run(['check'], dir).status).toBe(0);

      // Overwrite the recorded input hash for one enforced pair with a bogus value.
      const parsed = JSON.parse(readFileSync(lockPath(dir), 'utf-8')) as {
        verdicts: Record<string, Record<string, { hash: string }>>;
      };
      parsed.verdicts['no-todo-comments']['node:services/orders'].hash =
        '0000000000000000000000000000000000000000000000000000000000000000';
      writeFileSync(lockPath(dir), `${JSON.stringify(parsed, null, 2)}\n`, 'utf-8');

      const check = run(['check'], dir);
      expect(check.status).toBe(1);
      // The tampered pair is re-flagged unverified, not accepted.
      expect(check.all).toContain("No valid verdict for aspect 'no-todo-comments' on node:services/orders");
      expect(check.all).toContain('Next: yg check --approve');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
