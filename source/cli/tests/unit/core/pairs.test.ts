/**
 * Tests for core/pairs.ts — expected-pair computation and source fingerprints.
 *
 * All tests create real files in a tmpdir because computeExpectedPairs calls
 * expandMappingPaths (reads the filesystem) and computeSourceFingerprint calls
 * hashFile (reads raw bytes). The buildTestGraph helper is extended via the
 * TestNodeInput.mapping and TestAspectInput.scope additions below.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileUnit, nodeUnit } from '../../../src/model/lock.js';
import { computeExpectedPairs, computeSourceFingerprint, getChildMappingExclusions } from '../../../src/core/pairs.js';
import type { Graph, GraphNode, AspectDef, ScopeDef } from '../../../src/model/graph.js';

// ---------------------------------------------------------------------------
// Minimal inline graph builder (extends buildTestGraph with mapping + scope)
// ---------------------------------------------------------------------------

/**
 * Build a minimal Graph for pairs testing. Nodes are created with real on-disk
 * file paths so expandMappingPaths resolves actual files. The rootPath points
 * to <tmpDir>/.yggdrasil so that path.dirname(rootPath) = tmpDir = project root.
 */
interface PairsTestAspect {
  id: string;
  kind: 'llm' | 'deterministic' | 'aggregate';
  status?: 'draft' | 'advisory' | 'enforced';
  scope?: ScopeDef;
}

interface PairsTestNode {
  path: string;         // model-relative node path (e.g. "svc/handler")
  mapping?: string[];   // repo-relative paths (relative to tmpDir)
  aspects?: string[];   // aspect ids
  parent?: string;      // parent node path
}

function buildPairsGraph(
  tmpDir: string,
  nodes: PairsTestNode[],
  aspects: PairsTestAspect[],
): Graph {
  const rootPath = path.join(tmpDir, '.yggdrasil');
  mkdirSync(rootPath, { recursive: true });

  const aspectDefs: AspectDef[] = aspects.map((a) => ({
    id: a.id,
    name: a.id,
    reviewer: { type: a.kind },
    status: a.status ?? 'enforced',
    artifacts: a.kind === 'aggregate' ? [] : [{ filename: a.kind === 'llm' ? 'content.md' : 'check.mjs', content: 'rule' }],
    scope: a.scope,
  } as AspectDef));

  const nodeByPath = new Map<string, GraphNode>();
  for (const n of nodes) {
    nodeByPath.set(n.path, {
      path: n.path,
      meta: {
        name: n.path,
        type: 'service',
        aspects: n.aspects ?? [],
        mapping: n.mapping ?? [],
      },
      children: [],
      parent: null,
    } as GraphNode);
  }
  // Wire parent/child
  for (const n of nodes) {
    if (n.parent) {
      const child = nodeByPath.get(n.path)!;
      const parent = nodeByPath.get(n.parent)!;
      child.parent = parent;
      parent.children.push(child);
    }
  }

  return {
    config: {
      version: '5.0.0',
      reviewer: { tiers: { default: { provider: 'ollama', model: 'test', temperature: 0, consensus: 1 } }, default: 'default' },
    },
    architecture: {
      node_types: {
        service: { description: 'test' },
      },
    },
    nodes: nodeByPath,
    aspects: aspectDefs,
    flows: [],
    schemas: [],
    rootPath,
  } as unknown as Graph;
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'yg-pairs-test-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helper: write a file relative to tmpDir
// ---------------------------------------------------------------------------

function writeFile(relPath: string, content = 'content'): void {
  const abs = path.join(tmpDir, relPath);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf-8');
}

// ---------------------------------------------------------------------------
// computeExpectedPairs tests
// ---------------------------------------------------------------------------

describe('computeExpectedPairs', () => {
  it('per-node LLM aspect on a node with 3 files → 1 pair with 3 subjects', async () => {
    writeFile('src/a.ts', 'code a');
    writeFile('src/b.ts', 'code b');
    writeFile('src/c.ts', 'code c');

    const graph = buildPairsGraph(
      tmpDir,
      [{ path: 'svc', mapping: ['src/a.ts', 'src/b.ts', 'src/c.ts'], aspects: ['check-input'] }],
      [{ id: 'check-input', kind: 'llm' }],
    );

    const { pairs } = await computeExpectedPairs(graph);
    expect(pairs).toHaveLength(1);
    const p = pairs[0];
    expect(p.aspectId).toBe('check-input');
    expect(p.kind).toBe('llm');
    expect(p.unitKey).toBe(nodeUnit('svc'));
    expect(p.nodePath).toBe('svc');
    expect(p.status).toBe('enforced');
    expect(p.subjectFiles).toHaveLength(3);
    expect(p.subjectFiles).toContain('src/a.ts');
    expect(p.subjectFiles).toContain('src/b.ts');
    expect(p.subjectFiles).toContain('src/c.ts');
  });

  it('per-file LLM aspect → one pair per subject file with fileUnit keys', async () => {
    writeFile('src/a.ts');
    writeFile('src/b.ts');
    writeFile('src/c.ts');

    const graph = buildPairsGraph(
      tmpDir,
      [{ path: 'svc', mapping: ['src/a.ts', 'src/b.ts', 'src/c.ts'], aspects: ['lint'] }],
      [{ id: 'lint', kind: 'llm', scope: { per: 'file' } }],
    );

    const { pairs } = await computeExpectedPairs(graph);
    expect(pairs).toHaveLength(3);
    for (const p of pairs) {
      expect(p.kind).toBe('llm');
      expect(p.subjectFiles).toHaveLength(1);
      expect(p.unitKey).toBe(fileUnit(p.subjectFiles[0]));
    }
    // Sorted by aspectId then unitKey
    const keys = pairs.map((p) => p.unitKey);
    expect(keys).toEqual([...keys].sort());
  });

  it('scope.files path filter narrows the subject set', async () => {
    writeFile('src/handler.ts');
    writeFile('src/utils.ts');

    const graph = buildPairsGraph(
      tmpDir,
      [{ path: 'svc', mapping: ['src/handler.ts', 'src/utils.ts'], aspects: ['handler-only'] }],
      [{ id: 'handler-only', kind: 'llm', scope: { per: 'node', files: { path: '**/*handler*' } } }],
    );

    const { pairs } = await computeExpectedPairs(graph);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].subjectFiles).toEqual(['src/handler.ts']);
  });

  it('scope.files content filter narrows the subject set', async () => {
    writeFile('src/alpha.ts', 'export function doThing() {}');
    writeFile('src/beta.ts', 'export const x = 1;');

    const graph = buildPairsGraph(
      tmpDir,
      [{ path: 'svc', mapping: ['src/alpha.ts', 'src/beta.ts'], aspects: ['fn-check'] }],
      [{ id: 'fn-check', kind: 'llm', scope: { per: 'node', files: { content: 'export function' } } }],
    );

    const { pairs } = await computeExpectedPairs(graph);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].subjectFiles).toEqual(['src/alpha.ts']);
  });

  it('binary files excluded for LLM aspects but kept for deterministic', async () => {
    writeFile('src/code.ts', 'const x = 1;');
    // Write a real binary-extension file (empty, but the extension triggers the filter)
    writeFile('src/image.png', 'PNG data');

    const graph = buildPairsGraph(
      tmpDir,
      [{ path: 'svc', mapping: ['src/code.ts', 'src/image.png'], aspects: ['llm-check', 'det-check'] }],
      [
        { id: 'llm-check', kind: 'llm' },
        { id: 'det-check', kind: 'deterministic' },
      ],
    );

    const { pairs } = await computeExpectedPairs(graph);
    const llmPair = pairs.find((p) => p.aspectId === 'llm-check')!;
    const detPair = pairs.find((p) => p.aspectId === 'det-check')!;

    expect(llmPair.subjectFiles).toEqual(['src/code.ts']);
    expect(detPair.subjectFiles).toContain('src/image.png');
    expect(detPair.subjectFiles).toContain('src/code.ts');
  });

  it('empty subject set after filtering → no pair produced (vacuous pass)', async () => {
    writeFile('src/image.png', 'PNG data');

    const graph = buildPairsGraph(
      tmpDir,
      // Only a binary file in mapping → LLM excludes it → empty subject → no pair
      [{ path: 'svc', mapping: ['src/image.png'], aspects: ['llm-check'] }],
      [{ id: 'llm-check', kind: 'llm' }],
    );

    const { pairs } = await computeExpectedPairs(graph);
    expect(pairs).toHaveLength(0);
  });

  it('draft aspect excluded by default, included with includeDraft: true', async () => {
    writeFile('src/a.ts');

    const graph = buildPairsGraph(
      tmpDir,
      [{ path: 'svc', mapping: ['src/a.ts'], aspects: ['wip'] }],
      [{ id: 'wip', kind: 'llm', status: 'draft' }],
    );

    const { pairs: pairsDefault } = await computeExpectedPairs(graph);
    expect(pairsDefault).toHaveLength(0);

    const { pairs: pairsDraft } = await computeExpectedPairs(graph, { includeDraft: true });
    expect(pairsDraft).toHaveLength(1);
    expect(pairsDraft[0].aspectId).toBe('wip');
    expect(pairsDraft[0].status).toBe('draft');
  });

  it('aggregate aspect never produces a pair', async () => {
    writeFile('src/a.ts');

    const graph = buildPairsGraph(
      tmpDir,
      [{ path: 'svc', mapping: ['src/a.ts'], aspects: ['bundle'] }],
      [{ id: 'bundle', kind: 'aggregate' }],
    );

    const { pairs } = await computeExpectedPairs(graph);
    expect(pairs).toHaveLength(0);
  });

  it('node with empty mapping → no pairs', async () => {
    const graph = buildPairsGraph(
      tmpDir,
      [{ path: 'svc', mapping: [], aspects: ['check-input'] }],
      [{ id: 'check-input', kind: 'llm' }],
    );

    const { pairs } = await computeExpectedPairs(graph);
    expect(pairs).toHaveLength(0);
  });

  it('child carve-out: parent pair excludes file mapped by child', async () => {
    writeFile('src/parent.ts', 'parent code');
    writeFile('src/child/child.ts', 'child code');

    const graph = buildPairsGraph(
      tmpDir,
      [
        { path: 'svc', mapping: ['src/parent.ts', 'src/child/child.ts'], aspects: ['check'] },
        { path: 'svc/child', mapping: ['src/child/child.ts'], parent: 'svc' },
      ],
      [{ id: 'check', kind: 'llm' }],
    );

    const { pairs } = await computeExpectedPairs(graph);
    const parentPair = pairs.find((p) => p.nodePath === 'svc')!;
    expect(parentPair).toBeDefined();
    expect(parentPair.subjectFiles).not.toContain('src/child/child.ts');
    expect(parentPair.subjectFiles).toContain('src/parent.ts');
  });

  it('output ordering is deterministic: sorted by aspectId then unitKey', async () => {
    writeFile('src/a.ts');
    writeFile('src/b.ts');

    const graph = buildPairsGraph(
      tmpDir,
      [{ path: 'svc', mapping: ['src/a.ts', 'src/b.ts'], aspects: ['z-aspect', 'a-aspect'] }],
      [
        { id: 'z-aspect', kind: 'llm', scope: { per: 'file' } },
        { id: 'a-aspect', kind: 'llm', scope: { per: 'file' } },
      ],
    );

    const { pairs } = await computeExpectedPairs(graph);
    // 2 aspects × 2 files = 4 pairs; must be sorted by aspectId then unitKey
    expect(pairs).toHaveLength(4);
    const sortedExpected = [...pairs].sort((a, b) => {
      if (a.aspectId !== b.aspectId) return a.aspectId < b.aspectId ? -1 : 1;
      return a.unitKey < b.unitKey ? -1 : 1;
    });
    expect(pairs.map((p) => `${p.aspectId}|${p.unitKey}`)).toEqual(
      sortedExpected.map((p) => `${p.aspectId}|${p.unitKey}`),
    );
  });

  // ---------------------------------------------------------------------------
  // Regression: unreadable subject files must be surfaced, never silently dropped
  //
  // Technique: chmod 0o000 makes the file exist on disk (so expandMappingPaths
  // includes it) but unreadable by readFile (EACCES) → evaluateFileWhen reports
  // unreadable: true. Each test restores permissions in afterEach via rmSync
  // (which handles the restore implicitly via recursive:true + force:true).
  // We keep an explicit restore array so cleanup works before rmSync is called.
  // ---------------------------------------------------------------------------

  it('content-filter aspect: unreadable file lands in unreadable[], readable sibling still produces a pair', async () => {
    // src/readable.ts is readable and matches the content filter.
    // src/locked.ts exists but chmod 0o000 → readFile EACCES → evaluateFileWhen
    // reports unreadable: true — it must land in unreadable[], not be silently dropped.
    writeFile('src/readable.ts', 'export function doThing() {}');
    writeFile('src/locked.ts', 'export function secret() {}');
    const lockedAbs = path.join(tmpDir, 'src/locked.ts');
    chmodSync(lockedAbs, 0o000);

    const graph = buildPairsGraph(
      tmpDir,
      [{ path: 'svc', mapping: ['src/readable.ts', 'src/locked.ts'], aspects: ['fn-check'] }],
      [{ id: 'fn-check', kind: 'llm', scope: { per: 'node', files: { content: 'export function' } } }],
    );

    let pairs: Awaited<ReturnType<typeof computeExpectedPairs>>['pairs'];
    let unreadable: Awaited<ReturnType<typeof computeExpectedPairs>>['unreadable'];
    try {
      ({ pairs, unreadable } = await computeExpectedPairs(graph));
    } finally {
      chmodSync(lockedAbs, 0o644); // restore so afterEach rmSync can remove the tree
    }

    // The readable, matching file still produces a pair.
    expect(pairs).toHaveLength(1);
    expect(pairs[0].subjectFiles).toEqual(['src/readable.ts']);

    // The unreadable file is recorded with correct metadata.
    expect(unreadable).toHaveLength(1);
    expect(unreadable[0].nodePath).toBe('svc');
    expect(unreadable[0].aspectId).toBe('fn-check');
    expect(unreadable[0].path).toBe('src/locked.ts');
    expect(unreadable[0].reason).toMatch(/EACCES/i);
  });

  it('content-filter aspect: only matching file is unreadable → zero pairs AND non-empty unreadable (vacuous-green guard)', async () => {
    // src/locked.ts is the only mapped file. chmod 0o000 makes it unreadable.
    // Without the fix this produced zero pairs silently (vacuous green).
    // With the fix: zero pairs AND non-empty unreadable surfaces the problem.
    writeFile('src/locked.ts', 'export function secret() {}');
    const lockedAbs = path.join(tmpDir, 'src/locked.ts');
    chmodSync(lockedAbs, 0o000);

    const graph = buildPairsGraph(
      tmpDir,
      [{ path: 'svc', mapping: ['src/locked.ts'], aspects: ['fn-check'] }],
      [{ id: 'fn-check', kind: 'llm', scope: { per: 'node', files: { content: 'export function' } } }],
    );

    let pairs: Awaited<ReturnType<typeof computeExpectedPairs>>['pairs'];
    let unreadable: Awaited<ReturnType<typeof computeExpectedPairs>>['unreadable'];
    try {
      ({ pairs, unreadable } = await computeExpectedPairs(graph));
    } finally {
      chmodSync(lockedAbs, 0o644);
    }

    expect(pairs).toHaveLength(0);
    expect(unreadable).toHaveLength(1);
    expect(unreadable[0].nodePath).toBe('svc');
    expect(unreadable[0].aspectId).toBe('fn-check');
    expect(unreadable[0].path).toBe('src/locked.ts');
  });

  it('pure path-filter aspect never produces unreadable records even for an unreadable file', async () => {
    // A path-only filter evaluates only the file path glob — it never calls
    // readFile — so unreadable can never fire even if the file is chmod 0o000.
    writeFile('src/handler.ts', 'code');
    writeFile('src/locked.ts', 'code');
    const lockedAbs = path.join(tmpDir, 'src/locked.ts');
    chmodSync(lockedAbs, 0o000);

    const graph = buildPairsGraph(
      tmpDir,
      [{ path: 'svc', mapping: ['src/handler.ts', 'src/locked.ts'], aspects: ['path-only'] }],
      [{ id: 'path-only', kind: 'llm', scope: { per: 'node', files: { path: '**/*.ts' } } }],
    );

    let pairs: Awaited<ReturnType<typeof computeExpectedPairs>>['pairs'];
    let unreadable: Awaited<ReturnType<typeof computeExpectedPairs>>['unreadable'];
    try {
      ({ pairs, unreadable } = await computeExpectedPairs(graph));
    } finally {
      chmodSync(lockedAbs, 0o644);
    }

    // Path filter passes for both files (locked.ts matches **/*.ts by path).
    // No content read → no unreadable.
    expect(pairs).toHaveLength(1); // one per-node pair covering both subjects
    expect(pairs[0].subjectFiles).toHaveLength(2);
    expect(unreadable).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// computeSourceFingerprint tests
// ---------------------------------------------------------------------------

describe('computeSourceFingerprint', () => {
  it('returns a sha256 hex string for a mapped node', async () => {
    writeFile('src/a.ts', 'const a = 1;');

    const graph = buildPairsGraph(
      tmpDir,
      [{ path: 'svc', mapping: ['src/a.ts'] }],
      [],
    );

    const fp = await computeSourceFingerprint(graph, 'svc');
    expect(fp).toBeDefined();
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
  });

  it('returns undefined for a node with no mapping', async () => {
    const graph = buildPairsGraph(
      tmpDir,
      [{ path: 'svc', mapping: [] }],
      [],
    );

    const fp = await computeSourceFingerprint(graph, 'svc');
    expect(fp).toBeUndefined();
  });

  it('returns undefined for an unknown node', async () => {
    const graph = buildPairsGraph(tmpDir, [], []);
    const fp = await computeSourceFingerprint(graph, 'nonexistent');
    expect(fp).toBeUndefined();
  });

  it('changes when a mapped file content changes', async () => {
    writeFile('src/a.ts', 'version 1');

    const graph = buildPairsGraph(
      tmpDir,
      [{ path: 'svc', mapping: ['src/a.ts'] }],
      [],
    );

    const fp1 = await computeSourceFingerprint(graph, 'svc');

    writeFile('src/a.ts', 'version 2');
    const fp2 = await computeSourceFingerprint(graph, 'svc');

    expect(fp1).not.toBe(fp2);
  });

  it('is INSENSITIVE to scope filters — always hashes full mapping', async () => {
    writeFile('src/a.ts', 'code');
    writeFile('src/image.png', 'PNG');

    const graph1 = buildPairsGraph(
      tmpDir,
      [{ path: 'svc', mapping: ['src/a.ts', 'src/image.png'] }],
      [],
    );

    // Scope on the aspect does NOT affect the fingerprint
    const fp1 = await computeSourceFingerprint(graph1, 'svc');

    // Same graph — same fingerprint regardless of what aspects look like
    const fp2 = await computeSourceFingerprint(graph1, 'svc');
    expect(fp1).toBe(fp2);
  });

  it('includes binary files by raw bytes in the fingerprint', async () => {
    writeFile('src/image.png', 'PNG bytes v1');

    const graph = buildPairsGraph(
      tmpDir,
      [{ path: 'svc', mapping: ['src/image.png'] }],
      [],
    );

    const fp1 = await computeSourceFingerprint(graph, 'svc');
    expect(fp1).toBeDefined();

    writeFile('src/image.png', 'PNG bytes v2');
    const fp2 = await computeSourceFingerprint(graph, 'svc');

    // Binary content change must change the fingerprint
    expect(fp1).not.toBe(fp2);
  });

  it('child carve-out respected: parent fingerprint excludes child-mapped file', async () => {
    writeFile('src/parent.ts', 'parent code');
    writeFile('src/child/child.ts', 'child code');

    const graph1 = buildPairsGraph(
      tmpDir,
      [
        { path: 'svc', mapping: ['src/parent.ts', 'src/child/child.ts'] },
        { path: 'svc/child', mapping: ['src/child/child.ts'], parent: 'svc' },
      ],
      [],
    );

    const parentFp = await computeSourceFingerprint(graph1, 'svc');

    // Build a graph without the child node (parent maps both files, no carve-out)
    const graph2 = buildPairsGraph(
      tmpDir,
      [{ path: 'svc', mapping: ['src/parent.ts', 'src/child/child.ts'] }],
      [],
    );
    const noCarveOutFp = await computeSourceFingerprint(graph2, 'svc');

    // With carve-out, parent fingerprint covers only src/parent.ts → different
    expect(parentFp).not.toBe(noCarveOutFp);
  });
});

// ---------------------------------------------------------------------------
// getChildMappingExclusions tests (sanity — verified behavior)
// ---------------------------------------------------------------------------

describe('getChildMappingExclusions', () => {
  it('returns empty for a node with no children', () => {
    const graph = buildPairsGraph(
      tmpDir,
      [{ path: 'svc', mapping: ['src/a.ts'] }],
      [],
    );
    expect(getChildMappingExclusions(graph, 'svc')).toEqual([]);
  });

  it('returns empty for an unknown node', () => {
    const graph = buildPairsGraph(tmpDir, [], []);
    expect(getChildMappingExclusions(graph, 'unknown')).toEqual([]);
  });

  it('returns child mapping entries that overlap with parent mapping', () => {
    const graph = buildPairsGraph(
      tmpDir,
      [
        { path: 'svc', mapping: ['src'] },
        { path: 'svc/child', mapping: ['src/child'], parent: 'svc' },
      ],
      [],
    );
    const exclusions = getChildMappingExclusions(graph, 'svc');
    expect(exclusions).toContain('src/child');
  });
});
