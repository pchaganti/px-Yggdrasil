import { describe, it, expect } from 'vitest';
import { rekeyDriftBaseline, type FlatDriftBaseline } from '../../../src/core/drift-state-rekey.js';
import { computeCanonicalHash } from '../../../src/io/hash.js';
import { DRIFT_STATE_SCHEMA_VERSION } from '../../../src/model/drift.js';

describe('rekeyDriftBaseline', () => {
  it('losslessly re-keys a flat baseline with EACH synthetic key kind into typed identity', () => {
    const flat: FlatDriftBaseline = {
      hash: 'OLD_HASH_IGNORED',
      files: {
        // real source/graph files
        'src/foo.ts': 'h-foo',
        '.yggdrasil/model/svc/yg-node.yaml': 'h-node',
        // cross-node check-touched REAL file (kept as a real file)
        'src/other/x.ts': 'h-cross',
        // synthetic keys — all five kinds
        'own-subset:svc': 'h-own',
        'aspect-meta:my-aspect': 'h-meta',
        'tier-identity:my-aspect': 'h-tier',
        'check-touched:det-aspect': 'h-ct-summary-dropped',
        'aspect-meta:det-aspect': 'h-det-meta',
        'port-aspects:payments/svc': 'h-port',
      },
      mtimes: { 'src/foo.ts': 1717000000000 },
      aspectVerdicts: {
        'my-aspect': { verdict: 'approved' },
        'det-aspect': { verdict: 'refused', reason: 'bad', errorSource: 'codeViolation' },
      },
      checkTouchedFiles: {
        'det-aspect': { 'src/other/x.ts': 'h-cross' },
      },
      log: { last_entry_datetime: '2026-05-11T14:23:00.123Z', prefix_hash: 'h-log' },
    };

    const typed = rekeyDriftBaseline(flat);

    expect(typed.schemaVersion).toBe(DRIFT_STATE_SCHEMA_VERSION);

    // Real files only — NO synthetic keys.
    expect(typed.files).toEqual({
      'src/foo.ts': 'h-foo',
      '.yggdrasil/model/svc/yg-node.yaml': 'h-node',
      'src/other/x.ts': 'h-cross',
    });

    // Typed identity reconstructed.
    expect(typed.identity.ownSubset).toBe('h-own');
    expect(typed.identity.ports).toEqual({ 'payments/svc': 'h-port' });
    expect(typed.identity.aspects['my-aspect']).toEqual({ meta: 'h-meta', tier: 'h-tier' });
    expect(typed.identity.aspects['det-aspect']).toEqual({
      meta: 'h-det-meta',
      checkTouched: { 'src/other/x.ts': 'h-cross' },
    });

    // Verdicts preserved.
    expect(typed.aspectVerdicts).toEqual({
      'my-aspect': { verdict: 'approved' },
      'det-aspect': { verdict: 'refused', reason: 'bad', errorSource: 'codeViolation' },
    });

    // Optional fields preserved.
    expect(typed.mtimes).toEqual({ 'src/foo.ts': 1717000000000 });
    expect(typed.log).toEqual({ last_entry_datetime: '2026-05-11T14:23:00.123Z', prefix_hash: 'h-log' });

    // Hash recomputed with the NEW scheme over the SAME logical inputs —
    // files + typed identity + the preserved per-aspect verdicts (folded so a
    // tampered verdict in a migrated baseline is caught by yg check).
    expect(typed.hash).toBe(computeCanonicalHash(typed.files, typed.identity, typed.aspectVerdicts));
    expect(typed.hash).not.toBe('OLD_HASH_IGNORED');
  });

  it('synthesizes aspectVerdicts: {} for a pre-verdict baseline', () => {
    const flat: FlatDriftBaseline = {
      hash: 'x',
      files: { 'src/a.ts': 'h-a', 'own-subset:n': 'h-own', 'aspect-meta:a': 'h-meta' },
      // no aspectVerdicts field — pre-verdict baseline
    };
    const typed = rekeyDriftBaseline(flat);
    expect(typed.aspectVerdicts).toEqual({});
    expect(typed.identity.aspects['a']).toEqual({ meta: 'h-meta' });
  });

  it('produces an empty-but-valid identity for a baseline with no synthetic keys', () => {
    const flat: FlatDriftBaseline = { hash: 'x', files: { 'src/a.ts': 'h-a' } };
    const typed = rekeyDriftBaseline(flat);
    expect(typed.identity).toEqual({ ownSubset: '', ports: {}, aspects: {} });
    expect(typed.files).toEqual({ 'src/a.ts': 'h-a' });
  });

  it('throws on a non-object baseline (caller drops it as corrupt)', () => {
    expect(() => rekeyDriftBaseline(null as unknown as FlatDriftBaseline)).toThrow();
  });
});
