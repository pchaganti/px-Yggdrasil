import { describe, it, expect } from 'vitest';
import { filterAspectCascadeNodes } from '../../../src/cli/approve.js';
import type { CheckIssue } from '../../../src/core/check.js';
import type { Graph } from '../../../src/model/graph.js';

describe('filterAspectCascadeNodes', () => {
  // Aspect 'catalog-rule' declares a reference file at docs/catalog.md.
  const graph = {
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

  it('matches a node that drifted under aspects/<id>/ (existing behavior)', () => {
    const issues = [cascade('a/b', '.yggdrasil/aspects/catalog-rule/content.md')];
    expect(filterAspectCascadeNodes(issues, graph, 'catalog-rule', '.yggdrasil')).toEqual(['a/b']);
  });

  it('matches a node that drifted ONLY because the aspect reference file changed', () => {
    const issues = [cascade('a/b', 'docs/catalog.md')];
    expect(filterAspectCascadeNodes(issues, graph, 'catalog-rule', '.yggdrasil')).toEqual(['a/b']);
  });

  it('matches a node that drifted because the aspect tier-identity changed', () => {
    const issues = [cascade('a/b', 'tier-identity:catalog-rule')];
    expect(filterAspectCascadeNodes(issues, graph, 'catalog-rule', '.yggdrasil')).toEqual(['a/b']);
  });

  it('does not match a node that drifted from a different aspect', () => {
    const issues = [cascade('a/b', '.yggdrasil/aspects/other-rule/content.md')];
    expect(filterAspectCascadeNodes(issues, graph, 'catalog-rule', '.yggdrasil')).toEqual([]);
  });
});
