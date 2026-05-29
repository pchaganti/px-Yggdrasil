import { describe, it, expect } from 'vitest';
import { collectTrackedFiles } from '../../../src/core/graph/files.js';
import { buildTestGraphForStructure } from '../helpers/build-test-graph-structure.js';
import type { AspectDef } from '../../../src/model/graph.js';
import type { DriftNodeState } from '../../../src/model/drift.js';

describe('collectTrackedFiles — structure aspects', () => {
  function structureAspect(id: string): AspectDef {
    return { id, name: id, reviewer: { type: 'structure' }, artifacts: [], description: 'd' };
  }

  it('adds structure-identity synthetic entry for each effective structure aspect', () => {
    const g = buildTestGraphForStructure({
      nodes: [{ path: 'N', type: 'module', mapping: ['src/a.ts'], aspects: ['s1'] }],
    });
    g.aspects = [structureAspect('s1')];
    const node = g.nodes.get('N')!;
    const tracked = collectTrackedFiles(node, g);
    expect(tracked.find(t => t.path === 'structure-identity:s1')).toBeDefined();
  });

  it('includes baseline structureTouchedFiles paths as structure-touched layer', () => {
    const g = buildTestGraphForStructure({
      nodes: [{ path: 'N', type: 'module', mapping: ['src/a.ts'], aspects: ['s1'] }],
    });
    g.aspects = [structureAspect('s1')];
    const node = g.nodes.get('N')!;
    const baseline: DriftNodeState = {
      hash: 'x', files: {},
      structureTouchedFiles: { s1: { 'src/b.ts': 'hash-b' } },
    };
    const tracked = collectTrackedFiles(node, g, baseline);
    expect(tracked.find(t => t.path === 'src/b.ts' && t.layer === 'structure-touched')).toBeDefined();
  });

  it('adds structure-touched:<id> synthetic entry summarizing path set', () => {
    const g = buildTestGraphForStructure({
      nodes: [{ path: 'N', type: 'module', mapping: ['src/a.ts'], aspects: ['s1'] }],
    });
    g.aspects = [structureAspect('s1')];
    const node = g.nodes.get('N')!;
    const baseline: DriftNodeState = {
      hash: 'x', files: {},
      structureTouchedFiles: { s1: { 'src/b.ts': 'hash-b' } },
    };
    const tracked = collectTrackedFiles(node, g, baseline);
    expect(tracked.find(t => t.path === 'structure-touched:s1')).toBeDefined();
  });

  it('structure aspect check.mjs is tracked: content change must change canonical hash', () => {
    const g = buildTestGraphForStructure({
      nodes: [{ path: 'N', type: 'module', mapping: ['src/a.ts'], aspects: ['s1'] }],
    });
    g.aspects = [{
      id: 's1', name: 's1', reviewer: { type: 'structure' }, description: 'd',
      artifacts: [{ filename: 'check.mjs', content: 'export function check(){return [];}' }],
    } as AspectDef];
    const node = g.nodes.get('N')!;
    const tracked = collectTrackedFiles(node, g);
    const checkMjsTracked = tracked.find(t =>
      t.path === '.yggdrasil/aspects/s1/check.mjs' || t.path === 'aspects/s1/check.mjs'
    );
    expect(checkMjsTracked).toBeDefined();
  });
});
