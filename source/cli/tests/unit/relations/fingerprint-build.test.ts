import { describe, it, expect } from 'vitest';
import {
  cmpFileHashPair,
  sortFileHashPairs,
  computeIndexIdentity,
  hashRelations,
  parentChainOf,
  computeBasis,
} from '../../../src/relations/fingerprint-build.js';

describe('fingerprint-build shared constructions', () => {
  it('cmpFileHashPair orders by path, tie-breaking by hash', () => {
    expect(cmpFileHashPair(['a', 'h1'], ['b', 'h1'])).toBeLessThan(0);
    expect(cmpFileHashPair(['b', 'h1'], ['a', 'h1'])).toBeGreaterThan(0);
    // Same path → tie-break by hash (both directions + equal).
    expect(cmpFileHashPair(['a', 'h1'], ['a', 'h2'])).toBeLessThan(0);
    expect(cmpFileHashPair(['a', 'h2'], ['a', 'h1'])).toBeGreaterThan(0);
    expect(cmpFileHashPair(['a', 'h1'], ['a', 'h1'])).toBe(0);
  });

  it('sortFileHashPairs is a pure canonical sort (input order independent)', () => {
    const a = sortFileHashPairs([['b', '2'], ['a', '1']]);
    const b = sortFileHashPairs([['a', '1'], ['b', '2']]);
    expect(a).toEqual(b);
    expect(a).toEqual([['a', '1'], ['b', '2']]);
  });

  it('computeIndexIdentity is order-independent over the source set', () => {
    expect(computeIndexIdentity([['a', '1'], ['b', '2']])).toBe(
      computeIndexIdentity([['b', '2'], ['a', '1']]),
    );
  });

  it('hashRelations treats undefined as the empty relation set', () => {
    expect(hashRelations(undefined)).toBe(hashRelations([]));
  });

  it('parentChainOf yields every strict prefix, nearest first; empty for a root id', () => {
    expect(parentChainOf('a/b/c')).toEqual(['a/b', 'a']);
    expect(parentChainOf('a')).toEqual([]);
  });

  it('computeBasis returns the owner, the sanctioning ancestor, or none', () => {
    // Direct relation to the owner.
    expect(computeBasis(new Set(['b']), 'b')).toBe('b');
    // Relation to an ancestor of the owner sanctions the dep.
    expect(computeBasis(new Set(['b']), 'b/sub/deep')).toBe('b');
    // No declared relation reaches the owner or its ancestors.
    expect(computeBasis(new Set(['x']), 'b/sub')).toBe('none');
  });
});
