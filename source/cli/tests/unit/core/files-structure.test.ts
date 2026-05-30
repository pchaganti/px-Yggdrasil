import { describe, it, expect } from 'vitest';
import { collectTrackedFiles } from '../../../src/core/graph/files.js';
import { filterAspectCascadeNodes } from '../../../src/cli/approve.js';
import { buildTestGraphForStructure } from '../helpers/build-test-graph-structure.js';
import type { AspectDef } from '../../../src/model/graph.js';
import type { DriftNodeState } from '../../../src/model/drift.js';
import type { CheckIssue } from '../../../src/core/check.js';

describe('collectTrackedFiles — structure aspects', () => {
  function structureAspect(id: string): AspectDef {
    return { id, name: id, reviewer: { type: 'deterministic' }, artifacts: [], description: 'd' };
  }

  it('emits NO synthetic identity entry for a structure aspect', () => {
    // Deterministic (structure) aspects carry no synthetic identity hash — their
    // identity is fully file-tracked (yg-aspect.yaml + check.mjs + mapping +
    // per-aspectId deterministicTouchedFiles). The constant structure-identity hash
    // added no drift signal beyond the yg-aspect.yaml file hash.
    const g = buildTestGraphForStructure({
      nodes: [{ path: 'N', type: 'module', mapping: ['src/a.ts'], aspects: ['s1'] }],
    });
    g.aspects = [structureAspect('s1')];
    const node = g.nodes.get('N')!;
    const tracked = collectTrackedFiles(node, g);
    expect(tracked.find(t => t.path === 'structure-identity:s1')).toBeUndefined();
  });

  it('still tracks structure aspect file entries (yg-aspect.yaml, mapping)', () => {
    const g = buildTestGraphForStructure({
      nodes: [{ path: 'N', type: 'module', mapping: ['src/a.ts'], aspects: ['s1'] }],
    });
    g.aspects = [structureAspect('s1')];
    const node = g.nodes.get('N')!;
    const tracked = collectTrackedFiles(node, g);
    const aspectYaml = tracked.find(t =>
      t.path === '.yggdrasil/aspects/s1/yg-aspect.yaml' || t.path === 'aspects/s1/yg-aspect.yaml'
    );
    expect(aspectYaml).toBeDefined();
    expect(tracked.find(t => t.path === 'src/a.ts')).toBeDefined();
  });

  it('includes baseline deterministicTouchedFiles paths as deterministic-touched layer', () => {
    const g = buildTestGraphForStructure({
      nodes: [{ path: 'N', type: 'module', mapping: ['src/a.ts'], aspects: ['s1'] }],
    });
    g.aspects = [structureAspect('s1')];
    const node = g.nodes.get('N')!;
    const baseline: DriftNodeState = {
      hash: 'x', files: {},
      deterministicTouchedFiles: { s1: { 'src/b.ts': 'hash-b' } },
    };
    const tracked = collectTrackedFiles(node, g, baseline);
    expect(tracked.find(t => t.path === 'src/b.ts' && t.layer === 'deterministic-touched')).toBeDefined();
  });

  it('adds deterministic-touched:<id> synthetic entry summarizing path set (set change still drifts)', () => {
    const g = buildTestGraphForStructure({
      nodes: [{ path: 'N', type: 'module', mapping: ['src/a.ts'], aspects: ['s1'] }],
    });
    g.aspects = [structureAspect('s1')];
    const node = g.nodes.get('N')!;
    const baselineOne: DriftNodeState = {
      hash: 'x', files: {},
      deterministicTouchedFiles: { s1: { 'src/b.ts': 'hash-b' } },
    };
    const baselineTwo: DriftNodeState = {
      hash: 'x', files: {},
      deterministicTouchedFiles: { s1: { 'src/b.ts': 'hash-b', 'src/c.ts': 'hash-c' } },
    };
    const trackedOne = collectTrackedFiles(node, g, baselineOne);
    const trackedTwo = collectTrackedFiles(node, g, baselineTwo);
    const keyOne = trackedOne.find(t => t.path === 'deterministic-touched:s1');
    const keyTwo = trackedTwo.find(t => t.path === 'deterministic-touched:s1');
    expect(keyOne).toBeDefined();
    expect(keyTwo).toBeDefined();
    // A change to the touched-file set must change the synthetic hash → drift fires.
    expect(keyOne!.syntheticHash).not.toBe(keyTwo!.syntheticHash);
  });

  it('structure aspect check.mjs is tracked: content change must change canonical hash', () => {
    const g = buildTestGraphForStructure({
      nodes: [{ path: 'N', type: 'module', mapping: ['src/a.ts'], aspects: ['s1'] }],
    });
    g.aspects = [{
      id: 's1', name: 's1', reviewer: { type: 'deterministic' }, description: 'd',
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

describe('structure-identity lockstep — producer (collectTrackedFiles) vs consumer (aspectDependencyKeys)', () => {
  function structureAspect(id: string): AspectDef {
    return { id, name: id, reviewer: { type: 'deterministic' }, artifacts: [], description: 'd' };
  }

  const cascade = (nodePath: string, causeFile: string): CheckIssue => ({
    severity: 'error',
    code: 'upstream-drift',
    rule: 'cascade-drift',
    messageData: { what: 'cascade', why: '', next: '' },
    nodePath,
    cascadeCauses: [{ file: causeFile, layer: 'aspects' as const, description: '' }],
  });

  it('producer emits no structure-identity synthetic key for a structure aspect', () => {
    const g = buildTestGraphForStructure({
      nodes: [{ path: 'N', type: 'module', mapping: ['src/a.ts'], aspects: ['s1'] }],
    });
    g.aspects = [structureAspect('s1')];
    const node = g.nodes.get('N')!;
    const baseline: DriftNodeState = {
      hash: 'x', files: {},
      deterministicTouchedFiles: { s1: { 'src/b.ts': 'hash-b' } },
    };
    const tracked = collectTrackedFiles(node, g, baseline);
    // The only per-aspect synthetic key for a structure aspect is deterministic-touched.
    expect(tracked.find(t => t.path === 'deterministic-touched:s1')).toBeDefined();
    expect(tracked.find(t => t.path === 'structure-identity:s1')).toBeUndefined();
  });

  it('consumer matches deterministic-touched but does NOT expect structure-identity', () => {
    // The consumer (aspectDependencyKeys, exercised via filterAspectCascadeNodes)
    // must stay in lockstep with the producer: it recognizes the keys the producer
    // actually emits (deterministic-touched, aspects/<id>/ prefix, references) and must
    // NOT carry a stale structure-identity key the producer no longer writes.
    const g = buildTestGraphForStructure({
      nodes: [{ path: 'N', type: 'module', mapping: ['src/a.ts'], aspects: ['s1'] }],
    });
    g.aspects = [structureAspect('s1')];

    // deterministic-touched:<id> is a recognized cause for the aspect.
    expect(
      filterAspectCascadeNodes([cascade('N', 'deterministic-touched:s1')], g, 's1', '.yggdrasil'),
    ).toEqual(['N']);

    // aspects/<id>/ prefix is a recognized cause.
    expect(
      filterAspectCascadeNodes([cascade('N', '.yggdrasil/aspects/s1/yg-aspect.yaml')], g, 's1', '.yggdrasil'),
    ).toEqual(['N']);

    // structure-identity:<id> is NOT a recognized cause — the producer never emits it,
    // so the consumer must not match it (would be a stale, orphaned key).
    expect(
      filterAspectCascadeNodes([cascade('N', 'structure-identity:s1')], g, 's1', '.yggdrasil'),
    ).toEqual([]);
  });
});
