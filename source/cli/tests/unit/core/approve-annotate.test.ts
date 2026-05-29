import { describe, it, expect } from 'vitest';
import { annotateUpstreamChange } from '../../../src/core/approve.js';

describe('annotateUpstreamChange', () => {
  it('annotates structure-touched as "structure aspect tracked file"', () => {
    expect(annotateUpstreamChange('src/foo.ts', 'structure-touched')).toBe('structure aspect tracked file');
  });

  it('annotates aspects layer as "aspect content"', () => {
    expect(annotateUpstreamChange('.yggdrasil/aspects/my-aspect/content.md', 'aspects')).toBe('aspect content');
  });

  it('annotates path containing /aspects/ as "aspect content"', () => {
    expect(annotateUpstreamChange('.yggdrasil/aspects/foo/check.mjs', undefined)).toBe('aspect content');
  });

  it('annotates path containing /flows/ as "flow description"', () => {
    expect(annotateUpstreamChange('.yggdrasil/flows/checkout/yg-flow.yaml', undefined)).toBe('flow description');
  });

  it('annotates hierarchy layer as "parent metadata"', () => {
    expect(annotateUpstreamChange('.yggdrasil/model/foo/yg-node.yaml', 'hierarchy')).toBe('parent metadata');
  });

  it('annotates relational layer as "dependency metadata"', () => {
    expect(annotateUpstreamChange('.yggdrasil/model/bar/yg-node.yaml', 'relational')).toBe('dependency metadata');
  });

  it('annotates unknown layer as "upstream content"', () => {
    expect(annotateUpstreamChange('some/graph/file.yaml', undefined)).toBe('upstream content');
  });
});
