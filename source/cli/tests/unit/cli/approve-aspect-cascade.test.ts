import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CheckIssue } from '../../../src/core/check.js';
import type { Graph } from '../../../src/model/graph.js';
import type { DriftNodeState } from '../../../src/model/drift.js';

// filterAspectCascadeNodes is async and reads each candidate node's baseline
// (via readNodeDriftState) to attribute cross-node deterministic-touched paths
// to the aspect. Mock the store so the test controls each node's baseline.
const driftStateByNode = new Map<string, DriftNodeState>();
vi.mock('../../../src/io/drift-state-store.js', () => ({
  readNodeDriftState: vi.fn(async (_yggRoot: string, nodePath: string) => {
    return driftStateByNode.get(nodePath);
  }),
}));

// Imported after the mock is registered.
const { filterAspectCascadeNodes } = await import('../../../src/cli/approve.js');

describe('filterAspectCascadeNodes', () => {
  // Aspect 'catalog-rule' declares a reference file at docs/catalog.md.
  const graph = {
    rootPath: '/proj/.yggdrasil',
    aspects: [{ id: 'catalog-rule', references: [{ path: 'docs/catalog.md' }] }],
  } as unknown as Graph;

  const cascade = (nodePath: string, causeFile: string): CheckIssue => ({
    severity: 'error',
    code: 'upstream-drift',
    rule: 'cascade-drift',
    messageData: { what: 'cascade', why: '', next: '' },
    nodePath,
    cascadeCauses: [{ file: causeFile, layer: 'aspects' as const, description: '' }],
  });

  beforeEach(() => {
    driftStateByNode.clear();
  });

  it('matches a node that drifted under aspects/<id>/ (existing behavior)', async () => {
    const issues = [cascade('a/b', '.yggdrasil/aspects/catalog-rule/content.md')];
    expect(await filterAspectCascadeNodes(issues, graph, 'catalog-rule', '.yggdrasil')).toEqual(['a/b']);
  });

  it('matches a node that drifted ONLY because the aspect reference file changed', async () => {
    const issues = [cascade('a/b', 'docs/catalog.md')];
    expect(await filterAspectCascadeNodes(issues, graph, 'catalog-rule', '.yggdrasil')).toEqual(['a/b']);
  });

  it('matches a node that drifted because the aspect tier-identity changed', async () => {
    const issues = [cascade('a/b', 'tier-identity:catalog-rule')];
    expect(await filterAspectCascadeNodes(issues, graph, 'catalog-rule', '.yggdrasil')).toEqual(['a/b']);
  });

  it('does not match a node that drifted from a different aspect', async () => {
    const issues = [cascade('a/b', '.yggdrasil/aspects/other-rule/content.md')];
    expect(await filterAspectCascadeNodes(issues, graph, 'catalog-rule', '.yggdrasil')).toEqual([]);
  });

  // BUG 2 positive case: the node drifted only because a cross-node file read by
  // the deterministic aspect 'catalog-rule' changed. The raw path (not a synthetic
  // key) is the cascade cause; it lives in the node baseline's
  // deterministicTouchedFiles['catalog-rule']. The node MUST be included.
  it('matches a node whose cascade cause is a cross-node deterministic-touched path in its baseline', async () => {
    driftStateByNode.set('a/b', {
      hash: 'h',
      files: {},
      deterministicTouchedFiles: {
        'catalog-rule': { 'src/other/reader.ts': 'deadbeef' },
      },
    });
    const issues = [cascade('a/b', 'src/other/reader.ts')];
    expect(await filterAspectCascadeNodes(issues, graph, 'catalog-rule', '.yggdrasil')).toEqual(['a/b']);
  });

  // BUG 2 negative control: the cascade cause path is NOT in any
  // deterministicTouchedFiles entry → still excluded.
  it('does not match a node whose cross-node cause path is absent from deterministicTouchedFiles', async () => {
    driftStateByNode.set('a/b', {
      hash: 'h',
      files: {},
      deterministicTouchedFiles: {
        'catalog-rule': { 'src/other/reader.ts': 'deadbeef' },
      },
    });
    const issues = [cascade('a/b', 'src/unrelated/elsewhere.ts')];
    expect(await filterAspectCascadeNodes(issues, graph, 'catalog-rule', '.yggdrasil')).toEqual([]);
  });

  // Resilience: a missing/corrupt baseline must not crash; fall back to the
  // synthetic-key/prefix match. Here the cause is under aspects/<id>/ so it
  // still matches even though no baseline exists.
  it('falls back to prefix/synthetic match when the baseline is absent', async () => {
    const issues = [cascade('a/b', '.yggdrasil/aspects/catalog-rule/content.md')];
    expect(await filterAspectCascadeNodes(issues, graph, 'catalog-rule', '.yggdrasil')).toEqual(['a/b']);
  });
});
