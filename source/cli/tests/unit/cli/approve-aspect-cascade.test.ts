import { describe, it, expect } from 'vitest';
import type { CheckIssue, CascadeCause } from '../../../src/core/check.js';
import { filterAspectCascadeNodes } from '../../../src/cli/approve.js';
import type { Graph } from '../../../src/model/graph.js';

// filterAspectCascadeNodes is SYNC and attributes each cascade cause to an
// aspect by its TYPED fields (identity cause / attributedAspectIds) plus the
// aspects/<id>/ prefix and reference paths — no baseline re-read.
describe('filterAspectCascadeNodes', () => {
  // Aspect 'catalog-rule' declares a reference file at docs/catalog.md.
  const graph = {
    rootPath: '/proj/.yggdrasil',
    aspects: [{ id: 'catalog-rule', references: [{ path: 'docs/catalog.md' }] }],
  } as unknown as Graph;

  const cascade = (nodePath: string, cause: CascadeCause): CheckIssue => ({
    severity: 'error',
    code: 'upstream-drift',
    rule: 'cascade-drift',
    messageData: { what: 'cascade', why: '', next: '' },
    nodePath,
    cascadeCauses: [cause],
  });

  const realFile = (file: string): CascadeCause => ({ file, layer: 'aspects', description: '' });

  it('matches a node that drifted under aspects/<id>/ (real artifact file)', () => {
    const issues = [cascade('a/b', realFile('.yggdrasil/aspects/catalog-rule/content.md'))];
    expect(filterAspectCascadeNodes(issues, graph, 'catalog-rule', '.yggdrasil')).toEqual(['a/b']);
  });

  it('matches a node that drifted ONLY because the aspect reference file changed', () => {
    const issues = [cascade('a/b', realFile('docs/catalog.md'))];
    expect(filterAspectCascadeNodes(issues, graph, 'catalog-rule', '.yggdrasil')).toEqual(['a/b']);
  });

  it('matches a node that drifted because the aspect tier identity changed (typed)', () => {
    const issues = [cascade('a/b', {
      file: "aspect 'catalog-rule' reviewer tier", layer: 'aspects', description: '',
      identity: { kind: 'tier', aspectId: 'catalog-rule' },
    })];
    expect(filterAspectCascadeNodes(issues, graph, 'catalog-rule', '.yggdrasil')).toEqual(['a/b']);
  });

  it('does not match a node that drifted from a different aspect', () => {
    const issues = [cascade('a/b', realFile('.yggdrasil/aspects/other-rule/content.md'))];
    expect(filterAspectCascadeNodes(issues, graph, 'catalog-rule', '.yggdrasil')).toEqual([]);
  });

  it('matches a node whose cause is a cross-node check-touched path attributed to the aspect', () => {
    const issues = [cascade('a/b', {
      file: 'src/other/reader.ts', layer: 'check-touched', description: '',
      attributedAspectIds: ['catalog-rule'],
    })];
    expect(filterAspectCascadeNodes(issues, graph, 'catalog-rule', '.yggdrasil')).toEqual(['a/b']);
  });

  it('does not match a node whose cross-node cause path is attributed to a different aspect', () => {
    const issues = [cascade('a/b', {
      file: 'src/other/reader.ts', layer: 'check-touched', description: '',
      attributedAspectIds: ['some-other-rule'],
    })];
    expect(filterAspectCascadeNodes(issues, graph, 'catalog-rule', '.yggdrasil')).toEqual([]);
  });
});
