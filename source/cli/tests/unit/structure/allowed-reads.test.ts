import { describe, it, expect, afterEach } from 'vitest';
import { collectAllowedReadsForAspect } from '../../../src/structure/allowed-reads.js';
import { buildTestGraphForStructure } from '../helpers/build-test-graph-structure.js';
import { cleanupTestGraphs } from '../helpers/build-test-graph.js';

describe('collectAllowedReadsForAspect', () => {
  afterEach(() => cleanupTestGraphs());

  it('own mapping minus child mapping (child wins)', () => {
    const g = buildTestGraphForStructure({
      nodes: [
        { path: 'parent', type: 'module', mapping: ['src/parent', 'src/parent/foo.ts'] },
        { path: 'parent/child', type: 'module', mapping: ['src/parent/child.ts'], parent: 'parent' },
      ],
    });
    const allowed = collectAllowedReadsForAspect('parent', g);
    expect(allowed.has('src/parent/foo.ts')).toBe(true);
    expect(allowed.has('src/parent/child.ts')).toBe(false);
  });

  it('declared relation target mapping included', () => {
    const g = buildTestGraphForStructure({
      nodes: [
        { path: 'A', type: 'module', mapping: ['src/a.ts'],
          relations: [{ type: 'uses', target: 'B' }] },
        { path: 'B', type: 'module', mapping: ['src/b.ts'] },
      ],
    });
    const allowed = collectAllowedReadsForAspect('A', g);
    expect(allowed.has('src/b.ts')).toBe(true);
  });

  it('consumed port owner mapping included (subsumed by target mapping)', () => {
    const g = buildTestGraphForStructure({
      nodes: [
        { path: 'consumer', type: 'module', mapping: ['src/consumer.ts'],
          relations: [{ type: 'calls', target: 'provider', consumes: ['api'] }] },
        { path: 'provider', type: 'module', mapping: ['src/provider.ts'],
          ports: { api: { description: '', aspects: [] } } },
      ],
    });
    const allowed = collectAllowedReadsForAspect('consumer', g);
    expect(allowed.has('src/provider.ts')).toBe(true);
  });

  it('ancestor mapping included', () => {
    const g = buildTestGraphForStructure({
      nodes: [
        { path: 'root', type: 'module', mapping: ['src/root.ts'] },
        { path: 'root/child', type: 'module', mapping: ['src/child.ts'], parent: 'root' },
      ],
    });
    const allowed = collectAllowedReadsForAspect('root/child', g);
    expect(allowed.has('src/root.ts')).toBe(true);
  });

  it('descendant mapping included', () => {
    const g = buildTestGraphForStructure({
      nodes: [
        { path: 'root', type: 'module', mapping: ['src/root'] },
        { path: 'root/leaf', type: 'module', mapping: ['src/root/leaf.ts'], parent: 'root' },
      ],
    });
    const allowed = collectAllowedReadsForAspect('root', g);
    expect(allowed.has('src/root/leaf.ts')).toBe(true);
  });

  it('returns empty set for missing node id', () => {
    const g = buildTestGraphForStructure({ nodes: [] });
    expect(collectAllowedReadsForAspect('ghost', g).size).toBe(0);
  });

  it('relation target descendants are transitively included (dogfood prerequisite)', () => {
    const g = buildTestGraphForStructure({
      nodes: [
        { path: 'command', type: 'module', mapping: ['src/cmd.ts'],
          relations: [{ type: 'uses', target: 'tests/suite' }] },
        { path: 'tests/suite', type: 'module', mapping: [] },
        { path: 'tests/suite/group-a', type: 'module', mapping: ['tests/a.test.ts'], parent: 'tests/suite' },
        { path: 'tests/suite/group-b', type: 'module', mapping: ['tests/b.test.ts'], parent: 'tests/suite' },
      ],
    });
    const allowed = collectAllowedReadsForAspect('command', g);
    expect(allowed.has('tests/a.test.ts')).toBe(true);
    expect(allowed.has('tests/b.test.ts')).toBe(true);
  });
});
