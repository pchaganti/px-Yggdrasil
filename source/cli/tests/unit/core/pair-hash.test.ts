/**
 * Tests for core/pair-hash.ts — frozen input-hash contract (spec §3.1).
 *
 * Golden values pin the serialization format. Changing them is a deliberate
 * breaking decision — see pair-hash-golden.json for the canonical fixture.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LlmHashInput, DetHashInput } from '../../../src/core/pair-hash.js';
import {
  codePointCanonicalJson,
  computeLlmInputHash,
  computeDetInputHash,
  observationKey,
  hashReadObservation,
  hashListObservation,
  hashExistsObservation,
  tierHashView,
} from '../../../src/core/pair-hash.js';

// ---------------------------------------------------------------------------
// Load golden fixture
// ---------------------------------------------------------------------------

const GOLDEN_PATH = join(import.meta.dirname, '../../fixtures/pair-hash-golden.json');

interface PairHashGolden {
  // BREAKING: changing any of these values is a deliberate decision (spec §3.1 frozen contract).
  llmInputHash: string;
  hashListObservationGolden: string;
}

const golden: PairHashGolden = JSON.parse(readFileSync(GOLDEN_PATH, 'utf-8'));

// ---------------------------------------------------------------------------
// Shared fixture inputs
// ---------------------------------------------------------------------------

const BASE_LLM_INPUT: LlmHashInput = {
  aspectId: 'input-validation',
  aspectDescription: 'Every handler must validate its input before processing.',
  scope: undefined,
  nodePath: 'billing/cancel',
  ruleHash: 'a'.repeat(64),
  files: [
    ['src/billing/cancel.ts', 'b'.repeat(64)],
    ['src/billing/utils.ts', 'c'.repeat(64)],
  ],
  references: [
    ['docs/validation-catalogue.md', 'd'.repeat(64), 'Input validation catalogue'],
  ],
  tier: {
    name: 'standard',
    provider: 'anthropic',
    consensus: 2,
    config: {
      model: 'claude-3-7-sonnet-20250219',
      temperature: 0,
    },
  },
  verdict: 'approved',
};

// ---------------------------------------------------------------------------
// codePointCanonicalJson — key ordering
// ---------------------------------------------------------------------------

describe('codePointCanonicalJson', () => {
  it('canonical serialization uses code-point key ordering', () => {
    // Code-point order: 'Z' (0x5A) < '_' (0x5F) < 'a' (0x61)
    const obj = { alpha: 1, _under: 2, Zeta: 3 };
    const json = codePointCanonicalJson(obj);
    // Keys must appear in code-point order
    const keyOrder = (json.match(/"(\w+)":/g) ?? []).map((m) => m.slice(1, -2));
    expect(keyOrder).toEqual(['Zeta', '_under', 'alpha']);

    // Assertion that localeCompare would differ:
    // localeCompare-based sort typically yields: '_under', 'alpha', 'Zeta'
    // (underscore sorts after letters in many locales)
    const localeOrder = ['alpha', '_under', 'Zeta'].sort((a, b) => a.localeCompare(b));
    expect(localeOrder).not.toEqual(['Zeta', '_under', 'alpha']);
  });

  it('nested objects also use code-point key ordering', () => {
    const obj = { b: { z: 1, a: 2 }, a: 3 };
    const json = codePointCanonicalJson(obj);
    expect(json).toBe('{"a":3,"b":{"a":2,"z":1}}');
  });

  it('arrays preserve element order', () => {
    const json = codePointCanonicalJson([3, 1, 2]);
    expect(json).toBe('[3,1,2]');
  });

  it('undefined values are omitted', () => {
    const obj = { a: 1, b: undefined, c: 3 };
    const json = codePointCanonicalJson(obj);
    expect(json).toBe('{"a":1,"c":3}');
  });
});

// ---------------------------------------------------------------------------
// LLM hash — golden pin
// ---------------------------------------------------------------------------

describe('computeLlmInputHash', () => {
  it('LLM hash matches pinned golden for the fixture input', () => {
    // BREAKING: this value is pinned in pair-hash-golden.json (spec §3.1 frozen contract).
    // Changing serialization or ingredients requires a deliberate breaking decision.
    const hash = computeLlmInputHash(BASE_LLM_INPUT);
    expect(hash).toBe(golden.llmInputHash);
  });

  it('verdict token changes the hash', () => {
    const approved = computeLlmInputHash({ ...BASE_LLM_INPUT, verdict: 'approved' });
    const refused = computeLlmInputHash({ ...BASE_LLM_INPUT, verdict: 'refused' });
    expect(approved).not.toBe(refused);
  });

  it('absent scope hashes identically to explicit {per:"node"} with no files filter', () => {
    const withUndefined = computeLlmInputHash({ ...BASE_LLM_INPUT, scope: undefined });
    const withExplicit = computeLlmInputHash({ ...BASE_LLM_INPUT, scope: { per: 'node' } });
    expect(withUndefined).toBe(withExplicit);
  });

  it('tier config api_key and timeout do not affect the hash', () => {
    const tierWithSensitive = tierHashView('standard', {
      provider: 'anthropic',
      consensus: 2,
      config: {
        model: 'claude-3-7-sonnet-20250219',
        temperature: 0,
        api_key: 'sk-secret-key',
        timeout: 30000,
      },
    });
    const tierWithout = tierHashView('standard', {
      provider: 'anthropic',
      consensus: 2,
      config: {
        model: 'claude-3-7-sonnet-20250219',
        temperature: 0,
      },
    });

    const hashWithSensitive = computeLlmInputHash({
      ...BASE_LLM_INPUT,
      tier: tierWithSensitive,
    });
    const hashWithout = computeLlmInputHash({
      ...BASE_LLM_INPUT,
      tier: tierWithout,
    });

    expect(hashWithSensitive).toBe(hashWithout);
  });

  it('aspect description affects the hash', () => {
    const hash1 = computeLlmInputHash({ ...BASE_LLM_INPUT, aspectDescription: 'Rule A' });
    const hash2 = computeLlmInputHash({ ...BASE_LLM_INPUT, aspectDescription: 'Rule B' });
    expect(hash1).not.toBe(hash2);
  });

  it('file order does not matter (sorted internally by path)', () => {
    const sorted = computeLlmInputHash({
      ...BASE_LLM_INPUT,
      files: [
        ['src/billing/cancel.ts', 'b'.repeat(64)],
        ['src/billing/utils.ts', 'c'.repeat(64)],
      ],
    });
    const reversed = computeLlmInputHash({
      ...BASE_LLM_INPUT,
      files: [
        ['src/billing/utils.ts', 'c'.repeat(64)],
        ['src/billing/cancel.ts', 'b'.repeat(64)],
      ],
    });
    expect(sorted).toBe(reversed);
  });

  it('paths are POSIX-normalized before folding (backslash input hashes equal to forward-slash input)', () => {
    const posix = computeLlmInputHash({
      ...BASE_LLM_INPUT,
      files: [['src/billing/cancel.ts', 'b'.repeat(64)]],
    });
    const windows = computeLlmInputHash({
      ...BASE_LLM_INPUT,
      files: [['src\\billing\\cancel.ts', 'b'.repeat(64)]],
    });
    expect(posix).toBe(windows);
  });
});

// ---------------------------------------------------------------------------
// Deterministic hash
// ---------------------------------------------------------------------------

describe('computeDetInputHash', () => {
  const BASE_DET_INPUT: DetHashInput = {
    aspectId: 'no-direct-fs',
    scope: undefined,
    nodePath: 'billing/cancel',
    ruleHash: 'e'.repeat(64),
    files: [['src/billing/cancel.ts', 'f'.repeat(64)]],
    touched: [],
    verdict: 'approved',
  };

  it('det hash folds touched observations; input order of touched does not matter (sorted internally by key)', () => {
    const withTouched = computeDetInputHash({
      ...BASE_DET_INPUT,
      touched: [
        ['read:src/shared/codes.ts', 'g'.repeat(64)],
        ['list:src/billing', 'h'.repeat(64)],
      ],
    });
    const reversed = computeDetInputHash({
      ...BASE_DET_INPUT,
      touched: [
        ['list:src/billing', 'h'.repeat(64)],
        ['read:src/shared/codes.ts', 'g'.repeat(64)],
      ],
    });
    // Same content, different order → same hash
    expect(withTouched).toBe(reversed);

    // Different from empty touched
    const noTouched = computeDetInputHash({ ...BASE_DET_INPUT, touched: [] });
    expect(withTouched).not.toBe(noTouched);
  });

  it('det hash differs from LLM hash for same base ingredients (kind discriminator)', () => {
    const detHash = computeDetInputHash({
      aspectId: BASE_LLM_INPUT.aspectId,
      scope: BASE_LLM_INPUT.scope,
      nodePath: BASE_LLM_INPUT.nodePath,
      ruleHash: BASE_LLM_INPUT.ruleHash,
      files: BASE_LLM_INPUT.files,
      touched: [],
      verdict: BASE_LLM_INPUT.verdict,
    });
    expect(detHash).not.toBe(golden.llmInputHash);
  });
});

// ---------------------------------------------------------------------------
// observationKey
// ---------------------------------------------------------------------------

describe('observationKey encodings', () => {
  it('read prefix', () => {
    expect(observationKey('read', 'src/x.ts')).toBe('read:src/x.ts');
  });
  it('list prefix', () => {
    expect(observationKey('list', 'src/dir')).toBe('list:src/dir');
  });
  it('exists prefix', () => {
    expect(observationKey('exists', 'src/y.ts')).toBe('exists:src/y.ts');
  });
  it('graph prefix', () => {
    expect(observationKey('graph', 'billing/cancel')).toBe('graph:billing/cancel');
  });
});

// ---------------------------------------------------------------------------
// hashListObservation — golden pin
// ---------------------------------------------------------------------------

describe('hashListObservation', () => {
  it('hashListObservation = sha256 over sorted name:kind lines (golden)', () => {
    // BREAKING: this value is pinned in pair-hash-golden.json (spec §3.1 frozen contract).
    const unsorted = [
      { name: 'utils.ts', kind: 'file' as const },
      { name: 'types', kind: 'dir' as const },
      { name: 'cancel.ts', kind: 'file' as const },
    ];
    const sorted = [
      { name: 'cancel.ts', kind: 'file' as const },
      { name: 'types', kind: 'dir' as const },
      { name: 'utils.ts', kind: 'file' as const },
    ];
    const hashUnsorted = hashListObservation(unsorted);
    const hashSorted = hashListObservation(sorted);
    // Input order must not matter — sorted internally
    expect(hashUnsorted).toBe(hashSorted);
    // Golden pin
    expect(hashSorted).toBe(golden.hashListObservationGolden);
  });
});

// ---------------------------------------------------------------------------
// hashExistsObservation
// ---------------------------------------------------------------------------

describe('hashExistsObservation', () => {
  it('distinguishes file | dir | false', () => {
    const hashFile = hashExistsObservation('file');
    const hashDir = hashExistsObservation('dir');
    const hashFalse = hashExistsObservation(false);
    expect(hashFile).not.toBe(hashDir);
    expect(hashFile).not.toBe(hashFalse);
    expect(hashDir).not.toBe(hashFalse);
  });
});

// ---------------------------------------------------------------------------
// tierHashView
// ---------------------------------------------------------------------------

describe('tierHashView', () => {
  it('strips api_key and timeout, preserves everything else', () => {
    const view = tierHashView('standard', {
      provider: 'anthropic',
      consensus: 1,
      config: {
        model: 'claude-3-7-sonnet-20250219',
        temperature: 0.1,
        api_key: 'sk-secret',
        timeout: 60000,
        custom_header: 'x-value',
      },
    });
    expect(view.config).not.toHaveProperty('api_key');
    expect(view.config).not.toHaveProperty('timeout');
    expect(view.config).toHaveProperty('model');
    expect(view.config).toHaveProperty('temperature');
    expect(view.config).toHaveProperty('custom_header');
    expect(view.name).toBe('standard');
    expect(view.provider).toBe('anthropic');
    expect(view.consensus).toBe(1);
  });

  it('does not mutate its input', () => {
    const config = { model: 'x', api_key: 'secret', timeout: 5000 };
    const llm = { provider: 'openai' as const, consensus: 1, config };
    tierHashView('t', llm);
    expect(config).toHaveProperty('api_key', 'secret');
    expect(config).toHaveProperty('timeout', 5000);
  });
});

// ---------------------------------------------------------------------------
// hashReadObservation
// ---------------------------------------------------------------------------

describe('hashReadObservation', () => {
  it('returns sha256 hex of buffer bytes', () => {
    const buf = Buffer.from('hello world');
    const hash = hashReadObservation(buf);
    // sha256('hello world') = b94d27b9934d3e08...
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    // Same content, same hash
    expect(hashReadObservation(Buffer.from('hello world'))).toBe(hash);
    // Different content → different hash
    expect(hashReadObservation(Buffer.from('other'))).not.toBe(hash);
  });
});
