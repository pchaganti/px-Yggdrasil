// =============================================================================
// `yg impact` RE-SOURCED FROM THE LOCK — end-to-end through the spawned binary.
//
// The verdict-lock redesign re-sources `yg impact` from the committed lock
// (design §8): the refused-verdict annotation, the per-pair fill-cost lines, and
// the cross-node deterministic `touched`-map cascade are all read off an on-disk
// `yg-lock.json`. Those three paths had only in-memory unit coverage
// (tests/unit/cli/impact.test.ts, tests/unit/core/impact.test.ts) — the spawned
// `yg` child reading a REAL on-disk lock was never exercised. This suite closes
// the "## E2E gaps" impact entries from the bounty findings.
//
// HERMETIC: every test builds a fresh mkdtemp copy of the e2e-lifecycle fixture,
// mutates it in place, and removes it in afterEach. No fixed ports, no clock /
// random assertions. `yg impact` is a PURE READ (no reviewer, no LLM call), so
// the lock is either hand-written or produced by a deterministic-only
// `yg check --approve` (no network) — never by a live reviewer.
// =============================================================================

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  rmSync,
  cpSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '..', '..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'e2e-lifecycle');
const distExists = existsSync(BIN_PATH);

// Track every tmp dir so afterEach can clean up even if an assertion throws.
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function run(args: string[], cwd: string): { stdout: string; stderr: string; all: string; status: number | null } {
  const r = spawnSync('node', [BIN_PATH, ...args], { cwd, encoding: 'utf-8' });
  const stdout = r.stdout ?? '';
  const stderr = r.stderr ?? '';
  return { stdout, stderr, all: stdout + stderr, status: r.status };
}

const archPath = (d: string) => path.join(d, '.yggdrasil', 'yg-architecture.yaml');
const configPath = (d: string) => path.join(d, '.yggdrasil', 'yg-config.yaml');
const lockPath = (d: string) => path.join(d, '.yggdrasil', 'yg-lock.json');
const nodeYaml = (d: string, n: string) => path.join(d, '.yggdrasil', 'model', ...n.split('/'), 'yg-node.yaml');
const aspectDir = (d: string, a: string) => path.join(d, '.yggdrasil', 'aspects', a);

/** Fresh hermetic copy of the e2e-lifecycle fixture, auto-cleaned in afterEach. */
function fixture(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-impact-lock-${label}-`));
  cpSync(FIXTURE, dir, { recursive: true });
  dirs.push(dir);
  return dir;
}

/**
 * Drop the LLM `has-doc-comment` default from the service type and delete the
 * aspect so a `yg check --approve` is deterministic-only (no reviewer, no
 * network). Used by the tests that need a REAL lock from `--approve`.
 */
function dropLlmDefault(dir: string): void {
  const arch = readFileSync(archPath(dir), 'utf-8')
    .split('\n')
    .filter((l) => l.trim() !== '- has-doc-comment')
    .join('\n');
  writeFileSync(archPath(dir), arch, 'utf-8');
  rmSync(aspectDir(dir, 'has-doc-comment'), { recursive: true, force: true });
}

function writeLock(dir: string, lock: unknown): void {
  writeFileSync(lockPath(dir), JSON.stringify(lock, null, 2) + '\n', 'utf-8');
}

describe.skipIf(!distExists)('CLI E2E — yg impact re-sourced from the lock', () => {
  // ===========================================================================
  // (1) impact --aspect refused annotation — node: AND file: unit keys.
  //
  // A node holding a `refused` verdict for the aspect is tagged [refused] in the
  // affected list; a node with an `approved` verdict is NOT. Two unit-key shapes
  // are exercised end-to-end: node:<path> (direct) and file:<mapped> (resolved to
  // its owning node through the graph mapping — the file→owner path).
  //
  // `no-todo-comments` is effective on BOTH services/orders and services/payments
  // (service-type default + the order-processing flow). We refuse exactly one and
  // assert the sibling stays untagged.
  // ===========================================================================

  it('tags a node:<path> refused verdict with [refused]; the approved sibling is untagged', () => {
    const dir = fixture('refused-node');
    writeLock(dir, {
      version: 1,
      verdicts: {
        'no-todo-comments': {
          'node:services/orders': { verdict: 'refused', hash: 'deadbeef', reason: 'TODO comment found' },
          'node:services/payments': { verdict: 'approved', hash: 'cafef00d' },
        },
      },
      nodes: {},
    });

    const { stdout, status } = run(['impact', '--aspect', 'no-todo-comments'], dir);
    expect(status).toBe(0);
    // The refused node carries the [refused] tag after its [status] tag.
    expect(stdout).toMatch(/services\/orders \([^)]+\) \[enforced\] \[refused\]/);
    // The approved sibling is affected (same flow/type) but NOT tagged refused.
    expect(stdout).toMatch(/^ {2}services\/payments \([^)]+\) \[enforced\]$/m);
    expect(stdout).not.toMatch(/services\/payments[^\n]*\[refused\]/);
  });

  it('resolves a file:<mapped> refused unit key to its owning node and tags it [refused]', () => {
    const dir = fixture('refused-file');
    // The unit key is a file path mapped to services/orders (src/services/orders.ts).
    // Impact must resolve file→owner through the graph and tag services/orders.
    writeLock(dir, {
      version: 1,
      verdicts: {
        'no-todo-comments': {
          'file:src/services/orders.ts': { verdict: 'refused', hash: 'deadbeef', reason: 'TODO' },
        },
      },
      nodes: {},
    });

    const { stdout, status } = run(['impact', '--aspect', 'no-todo-comments'], dir);
    expect(status).toBe(0);
    // file:src/services/orders.ts → owner services/orders → [refused].
    expect(stdout).toMatch(/services\/orders \([^)]+\) \[enforced\] \[refused\]/);
    // services/payments holds no refused entry → untagged.
    expect(stdout).not.toMatch(/services\/payments[^\n]*\[refused\]/);
  });

  // ===========================================================================
  // (2) impact --aspect cost lines — per-pair, re-sourced; lock vocabulary only.
  //
  // LLM aspect: reviewer calls = resolved-tier consensus × affected units. With a
  // consensus-3 tier over 2 effective units the line must print 6 reviewer calls.
  // Deterministic aspect: free — no reviewer calls. Neither line uses drift words.
  // ===========================================================================

  it('LLM aspect: cost line = consensus × units reviewer calls (consensus included)', () => {
    const dir = fixture('cost-llm');
    // Bump the default tier consensus to 3. has-doc-comment (LLM) is effective on
    // BOTH service nodes (type default) → 2 units → 2 × 3 = 6 reviewer calls.
    writeFileSync(
      configPath(dir),
      [
        'version: "5.1.0"',
        '',
        'quality:',
        '  max_direct_relations: 10',
        '',
        'reviewer:',
        '  default: standard',
        '  tiers:',
        '    standard:',
        '      provider: ollama',
        '      consensus: 3',
        '      config:',
        '        model: "qwen2.5-coder:0.5b"',
        '        endpoint: "http://host.docker.internal:11434"',
        '',
      ].join('\n'),
      'utf-8',
    );

    const { stdout, status } = run(['impact', '--aspect', 'has-doc-comment'], dir);
    expect(status).toBe(0);
    // 2 affected service nodes, 2 pairs, 6 reviewer calls (2 units × consensus 3).
    expect(stdout).toContain('Directly affected (2):');
    expect(stdout).toContain('2 affected node(s) (2 pair(s))');
    expect(stdout).toContain('6 reviewer call(s) (consensus included)');
    // Lock vocabulary — never "drift".
    expect(stdout).toContain('would become unverified');
    expect(stdout.toLowerCase()).not.toContain('drift');
  });

  it('deterministic aspect: cost line is free — no reviewer calls, no drift words', () => {
    const dir = fixture('cost-det');
    // no-todo-comments is deterministic, effective on both service nodes.
    const { stdout, status } = run(['impact', '--aspect', 'no-todo-comments'], dir);
    expect(status).toBe(0);
    expect(stdout).toContain('Directly affected (2):');
    expect(stdout).toContain('2 affected node(s) (2 pair(s))');
    expect(stdout).toContain('re-verified for free by yg check --approve (deterministic, no reviewer calls)');
    expect(stdout).not.toContain('reviewer call(s) (consensus included)');
    expect(stdout.toLowerCase()).not.toContain('drift');
  });

  // ===========================================================================
  // (3) impact --file touched-key CROSS-NODE cascade.
  //
  // A deterministic aspect on node A (services/orders) OBSERVES a file owned by a
  // DIFFERENT node B (services/payments) via ctx.fs.list / ctx.fs.read / ctx.graph
  // — recorded in A's lock entry `touched` as read:/list:/graph: keys. Editing B's
  // file must list A under "Nodes whose deterministic aspects observe <file>
  // [structure]" sourced from the on-disk touched map (precise, NOT [structure,
  // potential]). With NO lock, the cold-start fallback lists A pessimistically via
  // collectAllowedReadsForAspect as [structure, potential].
  // ===========================================================================

  /**
   * Builds a deterministic-only graph where services/orders carries an obs-rule
   * check that observes services/payments cross-node (read of payments.ts via
   * ctx.graph.node, plus a list: of src/services). Returns the dir; if `approve`
   * is true a real lock with the touched map is produced.
   */
  function obsRuleFixture(label: string, approve: boolean): string {
    const dir = fixture(label);
    dropLlmDefault(dir);
    // Broaden the service when so a directory-mapped helper node validates.
    writeFileSync(
      archPath(dir),
      readFileSync(archPath(dir), 'utf-8').replace('path: "src/services/**"', 'path: "src/**"'),
      'utf-8',
    );

    // Helper node services/extras mapping src/extras (so a negative exists probe
    // under it is INSIDE the allowed-reads set).
    mkdirSync(path.join(dir, 'src', 'extras'), { recursive: true });
    writeFileSync(path.join(dir, 'src', 'extras', 'placeholder.ts'), '// placeholder\nexport const p = 1;\n', 'utf-8');
    mkdirSync(path.join(dir, '.yggdrasil', 'model', 'services', 'extras'), { recursive: true });
    writeFileSync(
      nodeYaml(dir, 'services/extras'),
      ['name: ExtrasService', 'description: Auxiliary extras directory.', 'type: service', 'mapping:', '  - src/extras', ''].join('\n'),
      'utf-8',
    );

    // obs-rule deterministic aspect: lists src/services, reads payments via
    // ctx.graph.node (folds read:src/services/payments.ts + graph:services/payments),
    // and negatively probes src/extras/secret.ts.
    const obs = aspectDir(dir, 'obs-rule');
    mkdirSync(obs, { recursive: true });
    writeFileSync(
      path.join(obs, 'yg-aspect.yaml'),
      ['name: ObsRule', 'description: A graph-aware observation rule for cross-node impact.', 'reviewer:', '  type: deterministic', 'status: enforced', ''].join('\n'),
      'utf-8',
    );
    writeFileSync(
      path.join(obs, 'check.mjs'),
      [
        'export function check(ctx) {',
        "  ctx.fs.list('src/services');",
        "  const secret = ctx.fs.exists('src/extras/secret.ts');",
        "  let payType = 'none';",
        "  try { payType = ctx.graph.node('services/payments').type; } catch (e) { payType = 'ERR'; }",
        '  const v = [];',
        "  if (secret !== false) v.push({ message: 'secret.ts must not exist' });",
        "  if (payType !== 'service') v.push({ message: 'payments must be a service' });",
        '  return v;',
        '}',
        '',
      ].join('\n'),
      'utf-8',
    );

    // services/orders: attach obs-rule + relations (so payments.ts is in its
    // allowed-reads for the cold-start fallback too).
    writeFileSync(
      nodeYaml(dir, 'services/orders'),
      [
        'name: OrdersService',
        'description: Creates and retrieves customer orders.',
        'type: service',
        'aspects:',
        '  - obs-rule',
        'relations:',
        '  - target: services/payments',
        '    type: uses',
        '  - target: services/extras',
        '    type: uses',
        'mapping:',
        '  - src/services/orders.ts',
        '',
      ].join('\n'),
      'utf-8',
    );

    if (approve) {
      const fill = run(['check', '--approve'], dir);
      // Deterministic-only fill — no reviewer, must succeed and record obs-rule.
      expect(fill.all).toContain('[det] obs-rule on node:services/orders — approved');
      // Sanity: the touched map really references payments.ts cross-node.
      const lock = JSON.parse(readFileSync(lockPath(dir), 'utf-8'));
      const touched: Array<[string, string]> = lock.verdicts['obs-rule']['node:services/orders'].touched;
      const keys = touched.map((t) => t[0]);
      expect(keys).toContain('read:src/services/payments.ts');
      expect(keys).toContain('list:src/services');
    }
    return dir;
  }

  it('precise (lock-sourced): editing a cross-node observed file lists the OBSERVING node under [structure]', () => {
    const dir = obsRuleFixture('xnode-precise', true);
    // payments.ts is owned by services/payments, but observed cross-node by
    // services/orders' obs-rule (recorded in the lock's touched map).
    const { stdout, status } = run(['impact', '--file', 'src/services/payments.ts'], dir);
    expect(status).toBe(0);
    expect(stdout).toContain('Nodes whose deterministic aspects observe src/services/payments.ts [structure]:');
    // PRECISE mode — the OBSERVING node (not the structural owner) is listed
    // WITHOUT the ", potential" suffix, proving it came from the on-disk touched
    // map and not a cold-start allowed-reads guess.
    expect(stdout).toMatch(/^ {2}services\/orders \[structure\]$/m);
    expect(stdout).not.toContain('services/orders [structure, potential]');
    expect(stdout).toContain('Blast radius via deterministic aspects: 1 node(s)');
    // The structural owner section still renders below the cascade.
    expect(stdout).toContain('src/services/payments.ts -> services/payments');
  });

  it('cold-start fallback (no lock): the observing node is listed pessimistically as [structure, potential]', () => {
    const dir = obsRuleFixture('xnode-coldstart', false);
    // No lock at all → collectStructureCascade falls back to
    // collectAllowedReadsForAspect (payments.ts is in services/orders'
    // allowed-reads via the uses relation) → potential mode.
    expect(existsSync(lockPath(dir))).toBe(false);
    const { stdout, status } = run(['impact', '--file', 'src/services/payments.ts'], dir);
    expect(status).toBe(0);
    expect(stdout).toContain('Nodes whose deterministic aspects observe src/services/payments.ts [structure]:');
    expect(stdout).toMatch(/^ {2}services\/orders \[structure, potential\]$/m);
    expect(stdout).toContain('Blast radius via deterministic aspects: 1 node(s)');
  });
});
