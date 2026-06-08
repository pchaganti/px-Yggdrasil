import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, cpSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectAllowedReadsForAspect } from '../../../src/structure/allowed-reads.js';
import { buildTestGraphForStructure } from '../helpers/build-test-graph-structure.js';
import { cleanupTestGraphs } from '../helpers/build-test-graph.js';

/**
 * Branch-coverage bounty for collectAllowedReadsForAspect
 * (source: src/structure/allowed-reads.ts).
 *
 * Each `it` is annotated with the source branch(es) it exercises. The intent is
 * to take BOTH sides of every boolean in the file:
 *   - early-return on missing node
 *   - addMapping: mapping present/absent, normalize truthy/empty
 *   - childPaths collection: child mapping present/absent, normalize truthy/empty
 *   - step 1: own minus child (p truthy/empty; in childPaths / not)
 *   - step 2: relations present/absent; target exists/missing; transitive descendants
 *   - step 3: ancestors (has parent / null)
 *   - parentDirs: lastSlash > 0 true/false (top-level + leading-slash edge)
 *   - siblingCarveOut: shares dir / does not; grandchild never carved
 *   - step 4: descendant entry carved-out / not
 *   - glob entries in mappings (own, relation, ancestor, descendant)
 *
 * E2E: the same gating is reachable through `yg deterministic-test --node`,
 * because the allowed-reads set powers ctx.fs's read gate inside a structure
 * check.mjs. Spawn tests at the bottom confirm relation-target reads pass and
 * unrelated reads are blocked end-to-end.
 */

// ---------------------------------------------------------------------------
// Pure-function branch coverage
// ---------------------------------------------------------------------------

describe('collectAllowedReadsForAspect — pure branch coverage', () => {
  afterEach(() => cleanupTestGraphs());

  // early-return: if (!node) return allowed  (TRUE side)
  it('returns an empty set when the node id is absent from the graph', () => {
    const g = buildTestGraphForStructure({
      nodes: [{ path: 'real', type: 'module', mapping: ['src/real.ts'] }],
    });
    const allowed = collectAllowedReadsForAspect('ghost', g);
    expect(allowed.size).toBe(0);
  });

  // early-return FALSE side + step 1 with no children at all.
  it('returns own mapping for a lone node (node present, no children, no relations)', () => {
    const g = buildTestGraphForStructure({
      nodes: [{ path: 'solo', type: 'module', mapping: ['src/solo.ts', 'src/dir'] }],
    });
    const allowed = collectAllowedReadsForAspect('solo', g);
    expect(allowed.has('src/solo.ts')).toBe(true);
    expect(allowed.has('src/dir')).toBe(true);
    expect(allowed.size).toBe(2);
  });

  // node.meta.mapping ?? []  — mapping UNDEFINED branch (no mapping key).
  // Also step-1 `node.meta.mapping ?? []` undefined branch.
  it('handles a node with no mapping at all (undefined-mapping branch)', () => {
    const g = buildTestGraphForStructure({
      nodes: [{ path: 'empty', type: 'module' }], // no mapping property
    });
    const allowed = collectAllowedReadsForAspect('empty', g);
    expect(allowed.size).toBe(0);
  });

  // mapping present but EMPTY array — distinct from undefined; exercises the
  // loop-body-never-runs path while `?? []` short-circuits on the value side.
  it('handles a node with an explicitly empty mapping array', () => {
    const g = buildTestGraphForStructure({
      nodes: [{ path: 'blank', type: 'module', mapping: [] }],
    });
    const allowed = collectAllowedReadsForAspect('blank', g);
    expect(allowed.size).toBe(0);
  });

  // normalizeMappingPath returns '' for whitespace-only / './' entries:
  // exercises the `if (p)` FALSE branch in addMapping, childPaths, step 1,
  // and parentDirs — those empty entries must be dropped everywhere.
  it('drops entries that normalize to empty string (if (p) false branch)', () => {
    const g = buildTestGraphForStructure({
      nodes: [
        { path: 'normy', type: 'module', mapping: ['   ', './', 'src/keep.ts'] },
      ],
    });
    const allowed = collectAllowedReadsForAspect('normy', g);
    expect(allowed.has('src/keep.ts')).toBe(true);
    expect(allowed.has('')).toBe(false);
    expect(allowed.size).toBe(1);
  });

  // normalize collapses './x' and 'x/' to the same canonical form — the leading
  // './' and trailing '/' strip branches of normalizeMappingPath, observed
  // through the allowed set.
  it('normalizes leading ./ and trailing / before adding to the set', () => {
    const g = buildTestGraphForStructure({
      nodes: [{ path: 'n', type: 'module', mapping: ['./src/a.ts', 'src/dir/'] }],
    });
    const allowed = collectAllowedReadsForAspect('n', g);
    expect(allowed.has('src/a.ts')).toBe(true);
    expect(allowed.has('src/dir')).toBe(true);
  });

  // ---- step 1: own minus child (child wins, exact match) ----

  // childPaths.has(p) TRUE branch: parent lists the exact path a direct child
  // also lists → excluded from parent's own.
  it('excludes a parent own-mapping entry that exactly matches a child entry', () => {
    const g = buildTestGraphForStructure({
      nodes: [
        { path: 'p', type: 'module', mapping: ['src/p/shared.ts', 'src/p/own.ts'] },
        { path: 'p/c', type: 'module', mapping: ['src/p/shared.ts'], parent: 'p' },
      ],
    });
    const allowed = collectAllowedReadsForAspect('p', g);
    // own.ts kept (not a child entry); shared.ts excluded from own contribution.
    expect(allowed.has('src/p/own.ts')).toBe(true);
    // shared.ts still appears because step 4 re-adds it from the child UNLESS
    // sibling carve-out applies. Here parent's own mappings live in dir 'src/p'
    // and the child entry also lives in 'src/p' → carved out in step 4 too.
    expect(allowed.has('src/p/shared.ts')).toBe(false);
  });

  // childPaths.has(p) FALSE branch already covered above ('own.ts'). Make it
  // explicit with a parent whose entries never collide with the child's.
  it('keeps own entries that do not collide with any child entry', () => {
    const g = buildTestGraphForStructure({
      nodes: [
        { path: 'p', type: 'module', mapping: ['src/p/a.ts'] },
        { path: 'p/c', type: 'module', mapping: ['lib/c.ts'], parent: 'p' },
      ],
    });
    const allowed = collectAllowedReadsForAspect('p', g);
    expect(allowed.has('src/p/a.ts')).toBe(true); // own kept
    expect(allowed.has('lib/c.ts')).toBe(true);   // descendant added (different dir)
  });

  // child.meta.mapping ?? [] UNDEFINED branch: a child with no mapping property
  // must not crash and must contribute nothing to childPaths.
  it('tolerates a child node with no mapping (childPaths undefined branch)', () => {
    const g = buildTestGraphForStructure({
      nodes: [
        { path: 'p', type: 'module', mapping: ['src/p/a.ts'] },
        { path: 'p/c', type: 'module', parent: 'p' }, // no mapping
      ],
    });
    const allowed = collectAllowedReadsForAspect('p', g);
    expect(allowed.has('src/p/a.ts')).toBe(true);
    expect(allowed.size).toBe(1);
  });

  // ---- step 2: relation targets + transitive descendants ----

  // relations present; target exists; target has NO children (relStack empty).
  it('includes a relation target mapping (relStack-empty branch)', () => {
    const g = buildTestGraphForStructure({
      nodes: [
        { path: 'A', type: 'module', mapping: ['src/a.ts'], relations: [{ type: 'uses', target: 'B' }] },
        { path: 'B', type: 'module', mapping: ['src/b.ts'] },
      ],
    });
    const allowed = collectAllowedReadsForAspect('A', g);
    expect(allowed.has('src/b.ts')).toBe(true);
  });

  // relations present; target MISSING → `if (!target) continue` TRUE branch.
  it('skips a relation whose target node does not exist (continue branch)', () => {
    const g = buildTestGraphForStructure({
      nodes: [
        { path: 'A', type: 'module', mapping: ['src/a.ts'], relations: [{ type: 'uses', target: 'nope' }] },
      ],
    });
    const allowed = collectAllowedReadsForAspect('A', g);
    expect(allowed.has('src/a.ts')).toBe(true);
    expect(allowed.size).toBe(1); // no crash, nothing extra added
  });

  // relations ABSENT → `node.meta.relations ?? []` empty branch (no relations key).
  it('handles a node with no relations property', () => {
    const g = buildTestGraphForStructure({
      nodes: [{ path: 'A', type: 'module', mapping: ['src/a.ts'] }],
    });
    const allowed = collectAllowedReadsForAspect('A', g);
    expect(allowed.size).toBe(1);
  });

  // relStack while-loop with depth: target's children AND grandchildren are
  // transitively pulled in (the `relStack.push(...n.children)` recursion).
  it('includes relation target descendants transitively (child + grandchild)', () => {
    const g = buildTestGraphForStructure({
      nodes: [
        { path: 'cmd', type: 'module', mapping: ['src/cmd.ts'], relations: [{ type: 'uses', target: 'suite' }] },
        { path: 'suite', type: 'module', mapping: ['tests/root.ts'] },
        { path: 'suite/group', type: 'module', mapping: ['tests/group.ts'], parent: 'suite' },
        { path: 'suite/group/case', type: 'module', mapping: ['tests/case.ts'], parent: 'suite/group' },
      ],
    });
    const allowed = collectAllowedReadsForAspect('cmd', g);
    expect(allowed.has('tests/root.ts')).toBe(true);  // target own
    expect(allowed.has('tests/group.ts')).toBe(true); // target child
    expect(allowed.has('tests/case.ts')).toBe(true);  // target grandchild (recursion)
  });

  // ---- step 3: ancestors ----

  // while (cursor) TRUE side: a multi-level ancestor chain contributes all
  // ancestor mappings; FALSE side is the loop terminating at a null parent.
  it('includes all ancestor mappings up the chain (while-cursor branch)', () => {
    const g = buildTestGraphForStructure({
      nodes: [
        { path: 'gp', type: 'module', mapping: ['src/gp.ts'] },
        { path: 'gp/p', type: 'module', mapping: ['src/p.ts'], parent: 'gp' },
        { path: 'gp/p/leaf', type: 'module', mapping: ['src/leaf.ts'], parent: 'gp/p' },
      ],
    });
    const allowed = collectAllowedReadsForAspect('gp/p/leaf', g);
    expect(allowed.has('src/p.ts')).toBe(true);  // parent
    expect(allowed.has('src/gp.ts')).toBe(true); // grandparent
    expect(allowed.has('src/leaf.ts')).toBe(true); // own
  });

  // while (cursor) FALSE side immediately: a top-level node has parent === null.
  it('top-level node has no ancestors (cursor null immediately)', () => {
    const g = buildTestGraphForStructure({
      nodes: [{ path: 'top', type: 'module', mapping: ['src/top.ts'] }],
    });
    const allowed = collectAllowedReadsForAspect('top', g);
    expect(allowed.has('src/top.ts')).toBe(true);
    expect(allowed.size).toBe(1);
  });

  // ---- parentDirs + step 4 sibling carve-out ----

  // parentDirs `lastSlash > 0` TRUE branch combined with siblingCarveOut
  // parentDirs.has(cpDir) TRUE → a DIRECT child entry sharing the parent's dir
  // is carved out of step 4.
  it('carves out a direct-child entry that shares the parent own-mapping dir', () => {
    const g = buildTestGraphForStructure({
      nodes: [
        { path: 'p', type: 'module', mapping: ['src/p/parent.ts'] }, // parent dir 'src/p'
        { path: 'p/c', type: 'module', mapping: ['src/p/child.ts'], parent: 'p' }, // same dir
      ],
    });
    const allowed = collectAllowedReadsForAspect('p', g);
    expect(allowed.has('src/p/parent.ts')).toBe(true);
    // child shares dir 'src/p' with parent's own mapping → carved out.
    expect(allowed.has('src/p/child.ts')).toBe(false);
  });

  // siblingCarveOut parentDirs.has(cpDir) FALSE branch → direct child in a
  // DIFFERENT dir is NOT carved out (it is added in step 4).
  it('does not carve out a direct-child entry in a different directory', () => {
    const g = buildTestGraphForStructure({
      nodes: [
        { path: 'p', type: 'module', mapping: ['src/p/parent.ts'] }, // dir 'src/p'
        { path: 'p/c', type: 'module', mapping: ['lib/elsewhere.ts'], parent: 'p' }, // dir 'lib'
      ],
    });
    const allowed = collectAllowedReadsForAspect('p', g);
    expect(allowed.has('src/p/parent.ts')).toBe(true);
    expect(allowed.has('lib/elsewhere.ts')).toBe(true); // different dir → kept
  });

  // GRANDCHILD never carved out, even if it shares the parent's dir.
  // (Carve-out only inspects DIRECT children via childPaths.)
  it('never carves out a grandchild entry even if it shares the parent dir', () => {
    const g = buildTestGraphForStructure({
      nodes: [
        { path: 'p', type: 'module', mapping: ['src/p/parent.ts'] }, // dir 'src/p'
        { path: 'p/c', type: 'module', mapping: ['lib/c.ts'], parent: 'p' },
        // grandchild lists an entry in the SAME dir as parent's own mapping:
        { path: 'p/c/gc', type: 'module', mapping: ['src/p/grandchild.ts'], parent: 'p/c' },
      ],
    });
    const allowed = collectAllowedReadsForAspect('p', g);
    expect(allowed.has('src/p/parent.ts')).toBe(true);
    expect(allowed.has('lib/c.ts')).toBe(true);
    // grandchild in 'src/p' is NOT a direct child → not in childPaths → not carved.
    expect(allowed.has('src/p/grandchild.ts')).toBe(true);
  });

  // parentDirs `lastSlash > 0` FALSE branch: a TOP-LEVEL parent own entry (no
  // slash) contributes NO parent dir, so a same-named-dir child is NOT carved.
  it('top-level parent own entry contributes no parentDir (lastSlash <= 0)', () => {
    const g = buildTestGraphForStructure({
      nodes: [
        { path: 'p', type: 'module', mapping: ['toplevel.ts'] }, // no slash → lastSlash = -1
        { path: 'p/c', type: 'module', mapping: ['toplevel-x.ts'], parent: 'p' }, // no slash → no carve
      ],
    });
    const allowed = collectAllowedReadsForAspect('p', g);
    expect(allowed.has('toplevel.ts')).toBe(true);
    expect(allowed.has('toplevel-x.ts')).toBe(true); // child kept (no dir to share)
  });

  // siblingCarveOut `lastSlash > 0` FALSE branch on the CHILD side: a top-level
  // child entry (no slash) is never carved out regardless of parent dirs.
  it('top-level child entry is never carved out (child lastSlash <= 0)', () => {
    const g = buildTestGraphForStructure({
      nodes: [
        { path: 'p', type: 'module', mapping: ['src/p/parent.ts'] }, // has dir
        { path: 'p/c', type: 'module', mapping: ['rootfile.ts'], parent: 'p' }, // no slash
      ],
    });
    const allowed = collectAllowedReadsForAspect('p', g);
    expect(allowed.has('rootfile.ts')).toBe(true);
  });

  // step 4 `if (p && !siblingCarveOut.has(p))` — the !carveOut TRUE side with a
  // multi-child fan-out, plus the depth recursion stack.push(...n.children).
  it('adds non-carved descendant entries across siblings and depth', () => {
    const g = buildTestGraphForStructure({
      nodes: [
        { path: 'root', type: 'module', mapping: ['src/root/r.ts'] }, // dir 'src/root'
        { path: 'root/a', type: 'module', mapping: ['feature/a.ts'], parent: 'root' },
        { path: 'root/b', type: 'module', mapping: ['feature/b.ts'], parent: 'root' },
        { path: 'root/a/deep', type: 'module', mapping: ['feature/deep.ts'], parent: 'root/a' },
      ],
    });
    const allowed = collectAllowedReadsForAspect('root', g);
    expect(allowed.has('feature/a.ts')).toBe(true);
    expect(allowed.has('feature/b.ts')).toBe(true);
    expect(allowed.has('feature/deep.ts')).toBe(true);
  });

  // descendant child with no mapping property → step 4 `n.meta.mapping ?? []`
  // undefined branch.
  it('tolerates a descendant child with no mapping (step 4 undefined branch)', () => {
    const g = buildTestGraphForStructure({
      nodes: [
        { path: 'root', type: 'module', mapping: ['src/root.ts'] },
        { path: 'root/c', type: 'module', parent: 'root' }, // no mapping
        { path: 'root/c/gc', type: 'module', mapping: ['src/gc.ts'], parent: 'root/c' },
      ],
    });
    const allowed = collectAllowedReadsForAspect('root', g);
    expect(allowed.has('src/root.ts')).toBe(true);
    expect(allowed.has('src/gc.ts')).toBe(true); // recursion still reaches grandchild
  });

  // step 4 `if (p ...)` empty-normalize FALSE branch on a descendant: a child
  // entry that normalizes to '' is dropped.
  it('drops a descendant entry that normalizes to empty', () => {
    const g = buildTestGraphForStructure({
      nodes: [
        { path: 'root', type: 'module', mapping: ['src/root.ts'] }, // parent dir 'src'
        // Child entry lives in a DIFFERENT dir ('lib') so it is NOT carved out;
        // this isolates the empty-normalize drop branch ('   ' -> '' -> dropped).
        { path: 'root/c', type: 'module', mapping: ['  ', 'lib/real-c.ts'], parent: 'root' },
      ],
    });
    const allowed = collectAllowedReadsForAspect('root', g);
    expect(allowed.has('lib/real-c.ts')).toBe(true);
    expect(allowed.has('')).toBe(false);
  });

  // ---- glob entries flowing through every step ----

  // Glob in OWN mapping survives normalization (normalize leaves '*' intact)
  // and lands in the allowed set verbatim. childPaths uses the same normalize so
  // a child glob exactly equal to the parent's is carved in step 1.
  it('keeps a glob own-mapping entry verbatim and carves an identical child glob', () => {
    const g = buildTestGraphForStructure({
      nodes: [
        { path: 'p', type: 'module', mapping: ['src/**/*.ts', 'src/p/*.spec.ts'] },
        { path: 'p/c', type: 'module', mapping: ['src/**/*.ts'], parent: 'p' }, // identical glob
      ],
    });
    const allowed = collectAllowedReadsForAspect('p', g);
    // identical glob present in child → excluded from parent's own contribution
    // AND (dir of 'src/**' is 'src' which matches parentDir of 'src/**/*.ts'?).
    // The glob 'src/**/*.ts' has lastSlash at '.../', dir 'src/**'; the child
    // glob shares that exact dir, so it is also carved from step 4 → absent.
    expect(allowed.has('src/**/*.ts')).toBe(false);
    expect(allowed.has('src/p/*.spec.ts')).toBe(true);
  });

  // Glob in a RELATION target mapping is included as-is.
  it('includes a glob relation-target mapping entry', () => {
    const g = buildTestGraphForStructure({
      nodes: [
        { path: 'A', type: 'module', mapping: ['src/a.ts'], relations: [{ type: 'uses', target: 'B' }] },
        { path: 'B', type: 'module', mapping: ['src/b/**/*.ts'] },
      ],
    });
    const allowed = collectAllowedReadsForAspect('A', g);
    expect(allowed.has('src/b/**/*.ts')).toBe(true);
  });

  // Glob in an ANCESTOR mapping is included as-is.
  it('includes a glob ancestor mapping entry', () => {
    const g = buildTestGraphForStructure({
      nodes: [
        { path: 'p', type: 'module', mapping: ['src/p/**/*.ts'] },
        { path: 'p/c', type: 'module', mapping: ['src/c.ts'], parent: 'p' },
      ],
    });
    const allowed = collectAllowedReadsForAspect('p/c', g);
    expect(allowed.has('src/p/**/*.ts')).toBe(true);
  });

  // Glob in a DESCENDANT mapping that does NOT share the parent dir is kept.
  it('includes a glob descendant mapping entry that does not share parent dir', () => {
    const g = buildTestGraphForStructure({
      nodes: [
        { path: 'p', type: 'module', mapping: ['src/p/parent.ts'] }, // dir 'src/p'
        { path: 'p/c', type: 'module', mapping: ['feature/**/*.ts'], parent: 'p' }, // dir 'feature/**'
      ],
    });
    const allowed = collectAllowedReadsForAspect('p', g);
    expect(allowed.has('feature/**/*.ts')).toBe(true);
  });

  // Combined: a single node exercising all four steps at once — own (minus
  // child), relation+descendant, ancestor, and descendant carve/keep.
  it('combines all four steps in one query', () => {
    const g = buildTestGraphForStructure({
      nodes: [
        { path: 'gp', type: 'module', mapping: ['src/gp.ts'] },
        {
          path: 'gp/n', type: 'module',
          mapping: ['src/n/own.ts', 'src/n/shared.ts'],
          relations: [{ type: 'uses', target: 'dep' }],
          parent: 'gp',
        },
        { path: 'gp/n/c', type: 'module', mapping: ['src/n/shared.ts', 'lib/c.ts'], parent: 'gp/n' },
        { path: 'dep', type: 'module', mapping: ['src/dep.ts'] },
        { path: 'dep/sub', type: 'module', mapping: ['src/dep-sub.ts'], parent: 'dep' },
      ],
    });
    const allowed = collectAllowedReadsForAspect('gp/n', g);
    // step 1: own minus child — own.ts kept, shared.ts excluded as child entry.
    expect(allowed.has('src/n/own.ts')).toBe(true);
    // step 3: ancestor
    expect(allowed.has('src/gp.ts')).toBe(true);
    // step 2: relation target + its descendant
    expect(allowed.has('src/dep.ts')).toBe(true);
    expect(allowed.has('src/dep-sub.ts')).toBe(true);
    // step 4: child entry in a different dir kept; shared.ts (dir 'src/n', same
    // as parent's own mapping dir) is carved out.
    expect(allowed.has('lib/c.ts')).toBe(true);
    expect(allowed.has('src/n/shared.ts')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// E2E — allowed-reads gating observed through the spawned CLI.
//
// `yg deterministic-test --node <p> --aspect <id>` runs a structure check.mjs
// whose ctx.fs read gate is built from collectAllowedReadsForAspect(p). A read
// of a path inside the allowed set succeeds; a read outside throws
// `structure-aspect-undeclared-fs-read`, which the check turns into a graph
// violation (exit 1). We model the fixture on the e2e-lifecycle tree.
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'e2e-lifecycle');
const distExists = existsSync(BIN_PATH);

function run(args: string[], cwd: string): { stdout: string; stderr: string; status: number | null; all: string } {
  const result = spawnSync('node', [BIN_PATH, ...args], { cwd, encoding: 'utf-8' });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  return { stdout, stderr, status: result.status, all: stdout + stderr };
}

function copyFixture(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-bounty2-${label}-`));
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

/** Write a structure aspect (deterministic) under .yggdrasil/aspects/<id>/. */
function writeStructureAspect(dir: string, id: string, checkBody: string): void {
  const aspectDir = path.join(dir, '.yggdrasil', 'aspects', id);
  mkdirSync(aspectDir, { recursive: true });
  writeFileSync(
    path.join(aspectDir, 'yg-aspect.yaml'),
    `name: ${id}\ndescription: Branch-coverage probe for allowed-reads gating via ctx.fs.\nreviewer:\n  type: deterministic\nstatus: advisory\n`,
    'utf-8',
  );
  writeFileSync(path.join(aspectDir, 'check.mjs'), checkBody, 'utf-8');
}

/** Rewrite the orders node yaml with the given aspects + relations block. */
function writeOrdersNode(dir: string, aspects: string[], relations: string): void {
  const p = path.join(dir, '.yggdrasil', 'model', 'services', 'orders', 'yg-node.yaml');
  const aspectLines = aspects.map((a) => `  - ${a}`).join('\n');
  writeFileSync(
    p,
    `name: OrdersService\ndescription: Creates and retrieves customer orders.\ntype: service\naspects:\n${aspectLines}\nmapping:\n  - src/services/orders.ts\n${relations}`,
    'utf-8',
  );
}

describe.skipIf(!distExists)('collectAllowedReadsForAspect — E2E via yg deterministic-test', () => {
  // step 2 (relation targets) load-bearing E2E: WITH a relation to payments,
  // ctx.fs.read of the target's mapped file is permitted → no violation, exit 0.
  it('relation-target file is readable through ctx.fs when the relation exists', () => {
    const dir = copyFixture('rel-read');
    try {
      writeStructureAspect(
        dir,
        'rel-read',
        `export function check(ctx) {
  const v = [];
  try { ctx.fs.read('src/services/payments.ts'); }
  catch (e) { v.push({ message: 'blocked: ' + e.message }); }
  return v;
}
`,
      );
      writeOrdersNode(
        dir,
        ['rel-read'],
        'relations:\n  - target: services/payments\n    type: uses\n',
      );
      const res = run(['deterministic-test', '--node', 'services/orders', '--aspect', 'rel-read'], dir);
      expect(res.all).toContain('No violations.');
      expect(res.status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // step 2 negative side: WITHOUT the relation, the same read is outside the
  // allowed set → blocked end-to-end (exit 1, undeclared-fs-read message).
  it('relation-target file is blocked when no relation is declared', () => {
    const dir = copyFixture('no-rel');
    try {
      writeStructureAspect(
        dir,
        'no-rel',
        `export function check(ctx) {
  const v = [];
  try { ctx.fs.read('src/services/payments.ts'); }
  catch (e) { v.push({ message: 'blocked: ' + e.message }); }
  return v;
}
`,
      );
      // No relations block.
      writeOrdersNode(dir, ['no-rel'], '');
      const res = run(['deterministic-test', '--node', 'services/orders', '--aspect', 'no-rel'], dir);
      expect(res.all).toContain('structure-aspect-undeclared-fs-read');
      expect(res.all).toContain('src/services/payments.ts');
      expect(res.status).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The OWN mapping is always inside the allowed set (step 1) — reading the
  // node's own mapped file succeeds end-to-end regardless of relations.
  it('own mapped file is always readable through ctx.fs (step 1)', () => {
    const dir = copyFixture('own-read');
    try {
      writeStructureAspect(
        dir,
        'own-read',
        `export function check(ctx) {
  const v = [];
  try { ctx.fs.read('src/services/orders.ts'); }
  catch (e) { v.push({ message: 'blocked own: ' + e.message }); }
  return v;
}
`,
      );
      writeOrdersNode(dir, ['own-read'], '');
      const res = run(['deterministic-test', '--node', 'services/orders', '--aspect', 'own-read'], dir);
      expect(res.all).toContain('No violations.');
      expect(res.status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // A wholly-unrelated, non-existent path is outside any of the four steps →
  // blocked end-to-end. Confirms the gate's default-deny.
  it('a path matched by no step is blocked through ctx.fs (default deny)', () => {
    const dir = copyFixture('deny');
    try {
      writeStructureAspect(
        dir,
        'deny-read',
        `export function check(ctx) {
  const v = [];
  try { ctx.fs.read('src/elsewhere/secret.ts'); v.push({ message: 'UNEXPECTED read succeeded' }); }
  catch (e) { v.push({ message: 'blocked: ' + e.message }); }
  return v;
}
`,
      );
      writeOrdersNode(dir, ['deny-read'], '');
      const res = run(['deterministic-test', '--node', 'services/orders', '--aspect', 'deny-read'], dir);
      expect(res.all).toContain('structure-aspect-undeclared-fs-read');
      expect(res.all).not.toContain('UNEXPECTED read succeeded');
      expect(res.status).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
