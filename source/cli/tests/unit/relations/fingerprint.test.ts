import { describe, it, expect } from 'vitest';
import { computeFingerprint, type FingerprintInput } from '../../../src/relations/fingerprint.js';

const base: FingerprintInput = {
  sources: [['src/a.ts', 'h1']],
  relations: 'rels-hash',
  outcomes: [{ fromFile: 'src/a.ts', line: 1, hintKey: 'import:./b', outcome: { ownerNode: 'b', resolvedFile: 'src/b.ts', resolvedFileHash: 'hb', basis: 'b' } }],
  grammarVersions: [['typescript', 'g1']],
  indexIdentity: 'idx1',
};

describe('fingerprint', () => {
  it('is stable for identical input', () => { expect(computeFingerprint(base)).toBe(computeFingerprint({ ...base })); });
  it('changes when a source hash changes', () => { expect(computeFingerprint({ ...base, sources: [['src/a.ts', 'h2']] })).not.toBe(computeFingerprint(base)); });
  it('changes when an outcome flips external→owned', () => {
    const flipped = { ...base, outcomes: [{ ...base.outcomes[0], outcome: { external: true } as const }] };
    expect(computeFingerprint(flipped)).not.toBe(computeFingerprint(base));
  });
  it('changes when the index identity changes', () => { expect(computeFingerprint({ ...base, indexIdentity: 'idx2' })).not.toBe(computeFingerprint(base)); });
  it('changes when the sanctioning basis changes (re-parent)', () => {
    const reparent = { ...base, outcomes: [{ ...base.outcomes[0], outcome: { ...(base.outcomes[0].outcome as any), basis: 'different' } }] };
    expect(computeFingerprint(reparent)).not.toBe(computeFingerprint(base));
  });
  it('is order-independent in sources/outcomes (canonical sort)', () => {
    const a = { ...base, sources: [['a', '1'], ['b', '2']] as Array<[string,string]> };
    const b = { ...base, sources: [['b', '2'], ['a', '1']] as Array<[string,string]> };
    expect(computeFingerprint(a)).toBe(computeFingerprint(b));
  });

  it('breaks source-sort ties on the second element (same path, different hash)', () => {
    // Two pairs sharing the first element exercise the secondary (hash) compare
    // in cmpPair; the canonical sort must order them identically regardless of
    // input order.
    const a = { ...base, sources: [['same', 'h2'], ['same', 'h1']] as Array<[string,string]> };
    const b = { ...base, sources: [['same', 'h1'], ['same', 'h2']] as Array<[string,string]> };
    expect(computeFingerprint(a)).toBe(computeFingerprint(b));
  });

  it('orders outcomes canonically, including equal and tie-broken keys', () => {
    // Same fromFile+line, different hintKey → the cmpOutcome key compare fires;
    // a duplicate key exercises the equal branch. Reordering must not change the
    // fingerprint.
    const mk = (hintKey: string) => ({ fromFile: 'src/a.ts', line: 1, hintKey, outcome: { external: true } as const });
    const a = { ...base, outcomes: [mk('path:./z'), mk('path:./a'), mk('path:./a')] };
    const b = { ...base, outcomes: [mk('path:./a'), mk('path:./a'), mk('path:./z')] };
    expect(computeFingerprint(a)).toBe(computeFingerprint(b));
  });
});
