import { describe, it, expect } from 'vitest';
import { collectAllowedReadsForAspect } from '../../../src/structure/allowed-reads.js';
import { collectTrackedFiles } from '../../../src/core/graph/files.js';
import { buildTestGraphForStructure } from '../helpers/build-test-graph-structure.js';

/**
 * Conformance tests verifying that collectAllowedReadsForAspect and
 * collectTrackedFiles draw from the same graph data source.
 *
 * collectTrackedFiles tracks a node's OWN source files (its mapping) in the
 * 'source' category — plus graph/config files for drift detection.
 * collectAllowedReadsForAspect includes a broader set (relations, ancestors,
 * descendants) but MUST include at least the same source files that
 * collectTrackedFiles tracks for the same node's 'source' category.
 *
 * Invariant: tracked-source(node) ⊆ allowed-reads(node)
 * (collectTrackedFiles source files are always readable by the node's aspect)
 */
describe('collectTrackedFiles (source layer) ⊆ collectAllowedReadsForAspect — single-source promise', () => {
  it.each([
    { name: 'simple chain', nodes: [
      { path: 'A', type: 'm', mapping: ['src/a.ts'], relations: [{ type: 'uses' as const, target: 'B' }] },
      { path: 'B', type: 'm', mapping: ['src/b.ts'] },
    ]},
    { name: 'parent + descendant', nodes: [
      { path: 'p', type: 'm', mapping: ['src/p.ts'] },
      { path: 'p/c1', type: 'm', mapping: ['src/c1.ts'], parent: 'p' },
      { path: 'p/c2', type: 'm', mapping: ['src/c2.ts'], parent: 'p' },
    ]},
    { name: 'relation target with descendants', nodes: [
      { path: 'A', type: 'm', mapping: ['src/a.ts'], relations: [{ type: 'uses' as const, target: 'suite' }] },
      { path: 'suite', type: 'm', mapping: [] },
      { path: 'suite/x', type: 'm', mapping: ['tests/x.ts'], parent: 'suite' },
    ]},
  ])('$name: own source tracked paths are a subset of allowed-reads', ({ nodes }) => {
    const g = buildTestGraphForStructure({ nodes });
    for (const inputNode of nodes) {
      const allowed = collectAllowedReadsForAspect(inputNode.path, g);
      const node = g.nodes.get(inputNode.path)!;
      const trackedSourcePaths = collectTrackedFiles(node, g)
        .filter(t => t.category === 'source')
        .map(t => t.path);
      for (const trackedPath of trackedSourcePaths) {
        // Every own source file must be reachable in the allowed-reads set
        // (via exact match or as a descendant of a directory entry)
        const matches = allowed.has(trackedPath) || [...allowed].some(a => trackedPath.startsWith(a + '/'));
        expect(matches, `tracked source path '${trackedPath}' is not reachable from allowed-reads for node ${node.path}: allowed=${[...allowed].join(',')}`).toBe(true);
      }
    }
  });
});
