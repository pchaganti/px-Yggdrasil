/**
 * Bug-bounty (branch coverage): EXHAUSTIVE coverage of the file-matching logic
 * inside src/core/graph/files.ts — specifically the `isOwnedByMapping` ownership
 * closure and the parts of `collectTrackedFiles` that depend on it:
 *
 *   - SOURCE step (lines 236–238): every mapping entry becomes a 'source'/'source'
 *     TrackedFile; dedup via the `seen` set; an empty/whitespace mapping produces
 *     no SOURCE entry.
 *
 *   - REFERENCES skip (lines 157–162, LLM-only): an aspect reference whose path is
 *     OWNED by the node's mapping is skipped (claimed by SOURCE); a NON-owned
 *     reference is added as 'graph'/'aspects'. Both sides of `isOwnedByMapping`,
 *     plus the `reviewer.type === 'llm'` guard and the `references ?? []` nullish.
 *
 *   - CHECK-TOUCHED carry-in (lines 182–194):
 *       * baseline absent / identity absent / aspects absent → whole block skipped.
 *       * a prior aspect with NO checkTouched map (`!pathMap`) → continue.
 *       * a prior checkTouched aspect that is NO LONGER EFFECTIVE (`!current`) →
 *         its checkTouched is DROPPED from the returned identity (the key vanishes).
 *       * a touched path OWNED by this node's mapping → NOT added as a tracked file
 *         (the SOURCE step owns it under 'source'); the checkTouched map still
 *         summarizes it.
 *       * a CROSS-node touched path (owned by a related node, not this one) → added
 *         as a real 'source'/'check-touched' tracked file.
 *       * an effective aspect always gets `current.checkTouched = pathMap` carried.
 *
 * Plus direct unit coverage of `isOwnedByMapping`'s underlying matcher
 * (mappingEntryMatchesFile) for every documented branch, and E2E confirmation
 * through `yg owner` (which routes through the same shared matcher).
 *
 * FS hygiene: every E2E test runs in a fresh mkdtemp tree under os.tmpdir() and
 * is rmSync'd in a finally. The unit tests are pure (no disk) but use synthetic
 * absolute project roots that never touch the repo. No randomness; no wall-clock
 * reads inside assertions.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, cpSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  Graph,
  GraphNode,
  AspectDef,
} from '../../../src/model/graph.js';
import type { DriftNodeState } from '../../../src/model/drift.js';
import { DRIFT_STATE_SCHEMA_VERSION } from '../../../src/model/drift.js';
import { collectTrackedFiles } from '../../../src/core/graph/files.js';
import { mappingEntryMatchesFile } from '../../../src/utils/mapping-path.js';

// ─────────────────────────────────────────────────────────────────────────────
// In-memory graph builders. collectTrackedFiles is synchronous and does NO disk
// I/O — it reads the loaded Graph only. rootPath is a synthetic absolute path; no
// file under it is ever created or read by these unit tests.
// ─────────────────────────────────────────────────────────────────────────────

const ROOT = '/synthetic/project';

function llmAspect(id: string, refs?: string[]): AspectDef {
  return {
    id,
    name: id,
    reviewer: { type: 'llm' },
    artifacts: [
      { filename: 'content.md', content: 'rule' },
      { filename: 'yg-aspect.yaml', content: '' },
    ],
    ...(refs ? { references: refs.map((p) => ({ path: p })) } : {}),
  } as AspectDef;
}

function detAspect(id: string): AspectDef {
  return {
    id,
    name: id,
    reviewer: { type: 'deterministic' },
    artifacts: [
      { filename: 'check.mjs', content: '' },
      { filename: 'yg-aspect.yaml', content: '' },
    ],
  } as AspectDef;
}

interface NodeSpec {
  path: string;
  aspects?: string[];
  mapping?: string[];
}

function makeNode(spec: NodeSpec): GraphNode {
  return {
    path: spec.path,
    meta: {
      name: spec.path,
      type: 'service',
      description: '',
      aspects: spec.aspects ?? [],
      relations: [],
      mapping: spec.mapping,
    },
    children: [],
    parent: null,
  } as GraphNode;
}

function makeGraph(nodes: GraphNode[], aspects: AspectDef[]): Graph {
  return {
    config: {
      reviewer: {
        default: 'standard',
        tiers: { standard: { provider: 'ollama', model: 'm', temperature: 0, consensus: 1 } },
      },
    },
    architecture: { node_types: { service: { description: 's' } } },
    nodes: new Map(nodes.map((n) => [n.path, n])),
    aspects,
    flows: [],
    schemas: [],
    rootPath: `${ROOT}/.yggdrasil`,
  } as unknown as Graph;
}

/** One self-owning node + its graph. */
function singleNodeGraph(spec: NodeSpec, aspects: AspectDef[]): { graph: Graph; node: GraphNode } {
  const node = makeNode(spec);
  return { graph: makeGraph([node], aspects), node };
}

const pathsOf = (g: Graph, n: GraphNode, baseline?: DriftNodeState): string[] =>
  collectTrackedFiles(n, g, baseline).trackedFiles.map((t) => t.path);

// ═════════════════════════════════════════════════════════════════════════════
// isOwnedByMapping — the underlying matcher (mappingEntryMatchesFile). Both sides
// of every boolean branch the closure can take.
// ═════════════════════════════════════════════════════════════════════════════

describe('isOwnedByMapping matcher — both sides of every branch', () => {
  it('empty entry owns nothing (e === "" → false)', () => {
    expect(mappingEntryMatchesFile('', 'src/a.ts')).toBe(false);
  });

  it('plain exact match (f === e → true)', () => {
    expect(mappingEntryMatchesFile('src/a.ts', 'src/a.ts')).toBe(true);
  });

  it('plain non-match (neither exact nor prefix → false)', () => {
    expect(mappingEntryMatchesFile('src/a.ts', 'src/b.ts')).toBe(false);
  });

  it('directory-prefix match (f.startsWith(e + "/") → true)', () => {
    expect(mappingEntryMatchesFile('src/dir', 'src/dir/child.ts')).toBe(true);
  });

  it('non-boundary prefix does NOT match (false)', () => {
    expect(mappingEntryMatchesFile('src/han', 'src/handlers/x.ts')).toBe(false);
  });

  it('glob entry that matches (isGlobPattern → globMatch true)', () => {
    expect(mappingEntryMatchesFile('src/*.ts', 'src/a.ts')).toBe(true);
  });

  it('glob entry that does NOT match (globMatch false)', () => {
    expect(mappingEntryMatchesFile('src/*.ts', 'src/sub/a.ts')).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// SOURCE step — every mapping entry is tracked as source/source.
// ═════════════════════════════════════════════════════════════════════════════

describe('collectTrackedFiles — SOURCE step (mapping → source/source)', () => {
  it('each mapping entry becomes a source/source TrackedFile', () => {
    const { graph, node } = singleNodeGraph({ path: 'svc', mapping: ['src/a.ts', 'src/b'] }, []);
    const tracked = collectTrackedFiles(node, graph).trackedFiles;
    const a = tracked.find((t) => t.path === 'src/a.ts');
    const b = tracked.find((t) => t.path === 'src/b');
    expect(a).toEqual({ path: 'src/a.ts', category: 'source', layer: 'source' });
    expect(b).toEqual({ path: 'src/b', category: 'source', layer: 'source' });
  });

  it('a node with NO mapping yields no source entries (empty mappingPathsList)', () => {
    const { graph, node } = singleNodeGraph({ path: 'svc' }, []);
    const tracked = collectTrackedFiles(node, graph).trackedFiles;
    expect(tracked.filter((t) => t.layer === 'source')).toHaveLength(0);
  });

  it('blank / whitespace-only mapping entries are normalized out (no source entry)', () => {
    const { graph, node } = singleNodeGraph({ path: 'svc', mapping: ['', '   ', 'src/real.ts'] }, []);
    const tracked = collectTrackedFiles(node, graph).trackedFiles;
    const sources = tracked.filter((t) => t.layer === 'source');
    expect(sources).toHaveLength(1);
    expect(sources[0].path).toBe('src/real.ts');
  });

  it('a glob mapping entry is tracked verbatim as a single source entry', () => {
    const { graph, node } = singleNodeGraph({ path: 'svc', mapping: ['src/**/*.ts'] }, []);
    const tracked = collectTrackedFiles(node, graph).trackedFiles;
    const g = tracked.find((t) => t.path === 'src/**/*.ts');
    expect(g?.layer).toBe('source');
    expect(g?.category).toBe('source');
  });

  it('duplicate mapping entries are deduped via the `seen` set', () => {
    const { graph, node } = singleNodeGraph({ path: 'svc', mapping: ['src/a.ts', 'src/a.ts'] }, []);
    const tracked = collectTrackedFiles(node, graph).trackedFiles;
    expect(tracked.filter((t) => t.path === 'src/a.ts')).toHaveLength(1);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// REFERENCES — owned-by-mapping skipped vs non-owned added. Exercises BOTH sides
// of isOwnedByMapping in the references loop, plus the LLM guard.
// ═════════════════════════════════════════════════════════════════════════════

describe('collectTrackedFiles — reference ownership (isOwnedByMapping in refs loop)', () => {
  it('reference OWNED by an exact file mapping → skipped (claimed by SOURCE)', () => {
    const aspect = llmAspect('a', ['src/own.ts', 'docs/ext.md']);
    const { graph, node } = singleNodeGraph({ path: 'svc', aspects: ['a'], mapping: ['src/own.ts'] }, [aspect]);
    const tracked = collectTrackedFiles(node, graph).trackedFiles;
    // Owned ref → only the SOURCE entry exists for it (no aspects-layer dup).
    const own = tracked.filter((t) => t.path === 'src/own.ts');
    expect(own).toHaveLength(1);
    expect(own[0].layer).toBe('source');
    // Non-owned ref → tracked as graph/aspects.
    const ext = tracked.find((t) => t.path === 'docs/ext.md');
    expect(ext?.category).toBe('graph');
    expect(ext?.layer).toBe('aspects');
  });

  it('reference OWNED by a directory mapping (prefix) → skipped', () => {
    const aspect = llmAspect('a', ['src/dir/ref.md']);
    const { graph, node } = singleNodeGraph({ path: 'svc', aspects: ['a'], mapping: ['src/dir'] }, [aspect]);
    const tracked = collectTrackedFiles(node, graph).trackedFiles;
    expect(tracked.find((t) => t.path === 'src/dir/ref.md')).toBeUndefined();
  });

  it('reference OWNED by a glob mapping → skipped', () => {
    const aspect = llmAspect('a', ['src/db/FooRepository.cs', 'docs/p.md']);
    const { graph, node } = singleNodeGraph(
      { path: 'svc', aspects: ['a'], mapping: ['src/db/*Repository.cs'] },
      [aspect],
    );
    const paths = pathsOf(graph, node);
    expect(paths).not.toContain('src/db/FooRepository.cs');
    expect(paths).toContain('docs/p.md');
  });

  it('reference NOT owned (non-boundary prefix overlap) → tracked', () => {
    const aspect = llmAspect('a', ['src/handlers/ref.md']);
    const { graph, node } = singleNodeGraph({ path: 'svc', aspects: ['a'], mapping: ['src/handle'] }, [aspect]);
    expect(pathsOf(graph, node)).toContain('src/handlers/ref.md');
  });

  it('deterministic aspect references are NOT tracked (LLM guard, reviewer.type !== "llm")', () => {
    // Defensive guard: parser rejects refs on deterministic aspects, but the code
    // path gates the references loop behind `reviewer.type === 'llm'`.
    const aspect = { ...detAspect('d'), references: [{ path: 'docs/ext.md' }] } as AspectDef;
    const { graph, node } = singleNodeGraph({ path: 'svc', aspects: ['d'] }, [aspect]);
    expect(pathsOf(graph, node)).not.toContain('docs/ext.md');
  });

  it('LLM aspect with NO references → references ?? [] empty, no extra entries', () => {
    const aspect = llmAspect('a'); // no refs
    const { graph, node } = singleNodeGraph({ path: 'svc', aspects: ['a'] }, [aspect]);
    const tracked = collectTrackedFiles(node, graph).trackedFiles;
    expect(tracked.find((t) => t.layer === 'aspects' && t.path.startsWith('docs/'))).toBeUndefined();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// CHECK-TOUCHED — the baseline carry-in block (lines 182–194). Each early-exit
// branch and both sides of isOwnedByMapping for a touched path.
// ═════════════════════════════════════════════════════════════════════════════

function baselineWith(aspects: Record<string, { checkTouched?: Record<string, string> }>): DriftNodeState {
  return {
    schemaVersion: DRIFT_STATE_SCHEMA_VERSION,
    hash: 'h',
    files: {},
    identity: { ownSubset: 'x', ports: {}, aspects: aspects as DriftNodeState['identity']['aspects'] },
    aspectVerdicts: {},
  };
}

describe('collectTrackedFiles — check-touched carry-in (baseline branches)', () => {
  it('NO baseline → block skipped entirely; no check-touched entries', () => {
    const aspect = detAspect('d');
    const { graph, node } = singleNodeGraph({ path: 'svc', aspects: ['d'], mapping: ['src/a.ts'] }, [aspect]);
    const ctx = collectTrackedFiles(node, graph); // baseline undefined
    expect(ctx.trackedFiles.find((t) => t.layer === 'check-touched')).toBeUndefined();
    // No checkTouched carried into identity.
    expect(ctx.identity.aspects['d'].checkTouched).toBeUndefined();
  });

  it('baseline present but identity.aspects empty → nothing carried', () => {
    const aspect = detAspect('d');
    const { graph, node } = singleNodeGraph({ path: 'svc', aspects: ['d'], mapping: ['src/a.ts'] }, [aspect]);
    const ctx = collectTrackedFiles(node, graph, baselineWith({}));
    expect(ctx.identity.aspects['d'].checkTouched).toBeUndefined();
    expect(ctx.trackedFiles.find((t) => t.layer === 'check-touched')).toBeUndefined();
  });

  it('prior aspect with NO checkTouched map (!pathMap) → continue, nothing carried', () => {
    const aspect = detAspect('d');
    const { graph, node } = singleNodeGraph({ path: 'svc', aspects: ['d'], mapping: ['src/a.ts'] }, [aspect]);
    // The prior entry has meta but no checkTouched key.
    const ctx = collectTrackedFiles(node, graph, baselineWith({ d: {} }));
    expect(ctx.identity.aspects['d'].checkTouched).toBeUndefined();
  });

  it('prior checkTouched aspect NO LONGER EFFECTIVE (!current) → its checkTouched is DROPPED', () => {
    // The node's effective aspects are [d]; the baseline also records a prior
    // checkTouched for 'gone' which is not effective anymore. 'gone' must NOT
    // appear in the returned identity at all, and its cross-node path must NOT be
    // tracked.
    const aspect = detAspect('d');
    const { graph, node } = singleNodeGraph({ path: 'svc', aspects: ['d'], mapping: ['src/a.ts'] }, [aspect]);
    const ctx = collectTrackedFiles(
      node,
      graph,
      baselineWith({
        d: { checkTouched: {} },
        gone: { checkTouched: { 'other/dropped.ts': 'hashx' } },
      }),
    );
    // The dropped aspect leaves no identity entry.
    expect(ctx.identity.aspects['gone']).toBeUndefined();
    // Its cross-node touched path is NOT tracked (it was dropped before addFile).
    expect(ctx.trackedFiles.find((t) => t.path === 'other/dropped.ts')).toBeUndefined();
    // The effective aspect still carries its (empty) checkTouched map.
    expect(ctx.identity.aspects['d'].checkTouched).toEqual({});
  });

  it('touched path OWNED by this node mapping → NOT a tracked file, but stays in checkTouched map', () => {
    const aspect = detAspect('d');
    const { graph, node } = singleNodeGraph({ path: 'svc', aspects: ['d'], mapping: ['src/a.ts'] }, [aspect]);
    const pathMap = { 'src/a.ts': 'hashOwned' };
    const ctx = collectTrackedFiles(node, graph, baselineWith({ d: { checkTouched: pathMap } }));
    // src/a.ts is owned by the mapping → only the SOURCE entry, no check-touched dup.
    const aEntries = ctx.trackedFiles.filter((t) => t.path === 'src/a.ts');
    expect(aEntries).toHaveLength(1);
    expect(aEntries[0].layer).toBe('source');
    // But the checkTouched map summarizing the full read-set still includes it.
    expect(ctx.identity.aspects['d'].checkTouched).toEqual(pathMap);
  });

  it('CROSS-node touched path (not owned by this node) → added as source/check-touched', () => {
    const aspect = detAspect('d');
    const { graph, node } = singleNodeGraph({ path: 'svc', aspects: ['d'], mapping: ['src/a.ts'] }, [aspect]);
    const pathMap = { 'other/x.ts': 'hashCross' };
    const ctx = collectTrackedFiles(node, graph, baselineWith({ d: { checkTouched: pathMap } }));
    const cross = ctx.trackedFiles.find((t) => t.path === 'other/x.ts');
    expect(cross).toEqual({ path: 'other/x.ts', category: 'source', layer: 'check-touched' });
    expect(ctx.identity.aspects['d'].checkTouched).toEqual(pathMap);
  });

  it('mixed read-set: own-mapping path skipped AND cross-node path added in one map', () => {
    const aspect = detAspect('d');
    const { graph, node } = singleNodeGraph({ path: 'svc', aspects: ['d'], mapping: ['src/owned'] }, [aspect]);
    const pathMap = { 'src/owned/inside.ts': 'h1', 'far/away.ts': 'h2' };
    const ctx = collectTrackedFiles(node, graph, baselineWith({ d: { checkTouched: pathMap } }));
    // Owned (under directory mapping) → not added as check-touched.
    expect(ctx.trackedFiles.find((t) => t.path === 'src/owned/inside.ts')).toBeUndefined();
    // Cross-node → added.
    const far = ctx.trackedFiles.find((t) => t.path === 'far/away.ts');
    expect(far?.layer).toBe('check-touched');
    // The map still summarizes BOTH (membership change drift).
    expect(ctx.identity.aspects['d'].checkTouched).toEqual(pathMap);
  });

  it('a cross-node check-touched path is deduped against the SOURCE/reference sets', () => {
    // The same path appears both as a non-owned reference (graph/aspects) AND in a
    // deterministic aspect's checkTouched. First-writer-wins: the reference entry
    // (added earlier) keeps the path; check-touched does not create a second entry.
    const det = detAspect('d');
    const llm = llmAspect('l', ['shared/cross.ts']);
    const node = makeNode({ path: 'svc', aspects: ['d', 'l'], mapping: ['src/a.ts'] });
    const graph = makeGraph([node], [det, llm]);
    const pathMap = { 'shared/cross.ts': 'h' };
    const ctx = collectTrackedFiles(node, graph, baselineWith({ d: { checkTouched: pathMap } }));
    const entries = ctx.trackedFiles.filter((t) => t.path === 'shared/cross.ts');
    expect(entries).toHaveLength(1);
    // The earlier-added reference layer wins.
    expect(entries[0].layer).toBe('aspects');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// E2E — `yg owner` routes through the SAME shared matcher (mappingEntryMatchesFile)
// that backs isOwnedByMapping. We spawn the built binary against a temp copy of
// the e2e-lifecycle fixture and assert exact/glob/directory-prefix/unmapped
// resolution. (collectTrackedFiles itself is internal — owner is its reachable
// CLI surface for the matcher.)
// ═════════════════════════════════════════════════════════════════════════════

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'e2e-lifecycle');
const distExists = existsSync(BIN_PATH);

function copyFixture(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-bounty2-${label}-`));
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

function ordersNodePath(dir: string): string {
  return path.join(dir, '.yggdrasil', 'model', 'services', 'orders', 'yg-node.yaml');
}

function setOrdersMapping(dir: string, mappingLine: string): void {
  const p = ordersNodePath(dir);
  const y = readFileSync(p, 'utf-8').replace('src/services/orders.ts', mappingLine);
  writeFileSync(p, y, 'utf-8');
}

function runOwner(dir: string, file: string): { status: number | null; out: string } {
  const r = spawnSync('node', [BIN_PATH, 'owner', '--file', file], { cwd: dir, encoding: 'utf-8' });
  return { status: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') };
}

describe.skipIf(!distExists)('E2E yg owner — shared matcher (exact/glob/prefix/unmapped)', () => {
  it('exact file mapping → owned, direct (no "no direct mapping" note)', () => {
    const dir = copyFixture('exact');
    try {
      const { out } = runOwner(dir, 'src/services/orders.ts');
      expect(out).toContain('src/services/orders.ts -> services/orders');
      expect(out).not.toContain('no direct mapping');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('glob mapping → the glob OWNS the matching file', () => {
    const dir = copyFixture('glob');
    try {
      setOrdersMapping(dir, 'src/services/order*.ts');
      const { out } = runOwner(dir, 'src/services/orders.ts');
      expect(out).toContain('src/services/orders.ts -> services/orders');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('glob mapping does NOT own a non-qualifying file in the same directory', () => {
    const dir = copyFixture('glob-neg');
    try {
      // orders globs only order*.ts; payments.ts keeps its own exact owner.
      setOrdersMapping(dir, 'src/services/order*.ts');
      const { out } = runOwner(dir, 'src/services/payments.ts');
      // payments.ts is owned by the payments node (its own exact mapping), NOT orders.
      expect(out).toContain('src/services/payments.ts -> services/payments');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('directory-prefix mapping → owned but INDIRECT (emits the no-direct-mapping note)', () => {
    const dir = copyFixture('dir');
    try {
      setOrdersMapping(dir, 'src/services');
      const { out } = runOwner(dir, 'src/services/orders.ts');
      expect(out).toContain('src/services/orders.ts -> services/orders');
      expect(out).toContain('File has no direct mapping.');
      expect(out).toContain("ancestor directory 'src/services'");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a file matched by NO mapping (and absent on disk) → no graph coverage', () => {
    const dir = copyFixture('unmapped');
    try {
      const { out } = runOwner(dir, 'src/nope/ghost.ts');
      expect(out).toContain('no graph coverage');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
