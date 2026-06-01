import { describe, it, expect } from 'vitest';
import { collectTrackedFiles } from '../../../src/core/graph/files.js';
import { filterAspectCascadeNodes } from '../../../src/cli/approve.js';
import { buildTestGraphForStructure } from '../helpers/build-test-graph-structure.js';
import type { AspectDef } from '../../../src/model/graph.js';
import type { DriftNodeState } from '../../../src/model/drift.js';
import { DRIFT_STATE_SCHEMA_VERSION } from '../../../src/model/drift.js';
import type { CheckIssue } from '../../../src/core/check.js';

function makeBaseline(over: Partial<DriftNodeState>): DriftNodeState {
  return {
    schemaVersion: DRIFT_STATE_SCHEMA_VERSION,
    hash: 'x',
    files: {},
    identity: { ownSubset: 'o', ports: {}, aspects: {} },
    aspectVerdicts: {},
    ...over,
  };
}

describe('collectTrackedFiles — deterministic aspects', () => {
  function structureAspect(id: string): AspectDef {
    return { id, name: id, reviewer: { type: 'deterministic' }, artifacts: [], description: 'd' };
  }

  it('records aspect meta in identity (no tier) for a deterministic aspect; tracks mapping', () => {
    const g = buildTestGraphForStructure({
      nodes: [{ path: 'N', type: 'module', mapping: ['src/a.ts'], aspects: ['s1'] }],
    });
    g.aspects = [structureAspect('s1')];
    const node = g.nodes.get('N')!;
    const { trackedFiles, identity } = collectTrackedFiles(node, g);
    // Deterministic aspect: meta present, tier absent.
    expect(identity.aspects['s1']?.meta).toMatch(/^[a-f0-9]{64}$/);
    expect(identity.aspects['s1']?.tier).toBeUndefined();
    // Raw yg-aspect.yaml is never tracked (status flip must not cascade).
    expect(trackedFiles.find(t => t.path.endsWith('aspects/s1/yg-aspect.yaml'))).toBeUndefined();
    expect(trackedFiles.find(t => t.path === 'src/a.ts')).toBeDefined();
  });

  it('carries baseline checkTouched into identity and adds cross-node paths as check-touched layer', () => {
    const g = buildTestGraphForStructure({
      nodes: [{ path: 'N', type: 'module', mapping: ['src/a.ts'], aspects: ['s1'] }],
    });
    g.aspects = [structureAspect('s1')];
    const node = g.nodes.get('N')!;
    const baseline = makeBaseline({
      identity: { ownSubset: 'o', ports: {}, aspects: { s1: { meta: 'm', checkTouched: { 'src/b.ts': 'hash-b' } } } },
    });
    const { trackedFiles, identity } = collectTrackedFiles(node, g, baseline);
    expect(trackedFiles.find(t => t.path === 'src/b.ts' && t.layer === 'check-touched')).toBeDefined();
    expect(identity.aspects['s1']?.checkTouched).toEqual({ 'src/b.ts': 'hash-b' });
  });

  it('a change to the checkTouched set is reflected in identity (set change drifts)', () => {
    const g = buildTestGraphForStructure({
      nodes: [{ path: 'N', type: 'module', mapping: ['src/a.ts'], aspects: ['s1'] }],
    });
    g.aspects = [structureAspect('s1')];
    const node = g.nodes.get('N')!;
    const one = collectTrackedFiles(node, g, makeBaseline({
      identity: { ownSubset: 'o', ports: {}, aspects: { s1: { meta: 'm', checkTouched: { 'src/b.ts': 'hash-b' } } } },
    }));
    const two = collectTrackedFiles(node, g, makeBaseline({
      identity: { ownSubset: 'o', ports: {}, aspects: { s1: { meta: 'm', checkTouched: { 'src/b.ts': 'hash-b', 'src/c.ts': 'hash-c' } } } },
    }));
    expect(one.identity.aspects['s1']?.checkTouched).not.toEqual(two.identity.aspects['s1']?.checkTouched);
  });

  it('deterministic aspect check.mjs is tracked as a file', () => {
    const g = buildTestGraphForStructure({
      nodes: [{ path: 'N', type: 'module', mapping: ['src/a.ts'], aspects: ['s1'] }],
    });
    g.aspects = [{
      id: 's1', name: 's1', reviewer: { type: 'deterministic' }, description: 'd',
      artifacts: [{ filename: 'check.mjs', content: 'export function check(){return [];}' }],
    } as AspectDef];
    const node = g.nodes.get('N')!;
    const { trackedFiles } = collectTrackedFiles(node, g);
    const checkMjsTracked = trackedFiles.find(t =>
      t.path === '.yggdrasil/aspects/s1/check.mjs' || t.path === 'aspects/s1/check.mjs'
    );
    expect(checkMjsTracked).toBeDefined();
  });
});

describe('typed cascade attribution — producer (collectTrackedFiles) vs consumer (filterAspectCascadeNodes)', () => {
  function structureAspect(id: string): AspectDef {
    return { id, name: id, reviewer: { type: 'deterministic' }, artifacts: [], description: 'd' };
  }

  const cascade = (nodePath: string, cause: CheckIssue['cascadeCauses'] extends (infer C)[] | undefined ? C : never): CheckIssue => ({
    severity: 'error',
    code: 'upstream-drift',
    rule: 'cascade-drift',
    messageData: { what: 'cascade', why: '', next: '' },
    nodePath,
    cascadeCauses: [cause],
  });

  it('consumer attributes a typed checkTouchedSet identity cause to its aspect', () => {
    const g = buildTestGraphForStructure({
      nodes: [{ path: 'N', type: 'module', mapping: ['src/a.ts'], aspects: ['s1'] }],
    });
    g.aspects = [structureAspect('s1')];

    // A typed checkTouchedSet identity cause for s1 attributes to s1.
    expect(
      filterAspectCascadeNodes(
        [cascade('N', { file: "aspect 's1' read-set", layer: 'aspects', description: '', identity: { kind: 'checkTouchedSet', aspectId: 's1' } })],
        g, 's1', '.yggdrasil',
      ),
    ).toEqual(['N']);

    // aspects/<id>/ prefix real-file cause attributes to s1.
    expect(
      filterAspectCascadeNodes(
        [cascade('N', { file: '.yggdrasil/aspects/s1/check.mjs', layer: 'aspects', description: '' })],
        g, 's1', '.yggdrasil',
      ),
    ).toEqual(['N']);

    // An identity cause for a DIFFERENT aspect does not attribute to s1.
    expect(
      filterAspectCascadeNodes(
        [cascade('N', { file: "aspect 'other' definition", layer: 'aspects', description: '', identity: { kind: 'aspectMeta', aspectId: 'other' } })],
        g, 's1', '.yggdrasil',
      ),
    ).toEqual([]);
  });

  it('consumer attributes a cross-node check-touched real file via its attributed owner', () => {
    const g = buildTestGraphForStructure({
      nodes: [{ path: 'N', type: 'module', mapping: ['src/a.ts'], aspects: ['s1'] }],
    });
    g.aspects = [structureAspect('s1')];
    expect(
      filterAspectCascadeNodes(
        [cascade('N', { file: 'src/b.ts', layer: 'check-touched', description: '', attributedAspectIds: ['s1'] })],
        g, 's1', '.yggdrasil',
      ),
    ).toEqual(['N']);
  });
});
