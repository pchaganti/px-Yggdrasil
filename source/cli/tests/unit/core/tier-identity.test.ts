import { describe, it, expect } from 'vitest';
import { canonicalTierJson } from '../../../src/core/tier-identity.js';
import type { LlmConfig } from '../../../src/model/graph.js';

const base: LlmConfig = {
  provider: 'claude-code',
  model: 'sonnet',
  temperature: 0,
  consensus: 1,
};

describe('canonicalTierJson', () => {
  it('produces stable JSON with sorted keys', () => {
    const r1 = canonicalTierJson(base, 'standard');
    const r2 = canonicalTierJson({ ...base }, 'standard');
    expect(r1).toBe(r2);
  });

  it('includes tierName in the digest', () => {
    const a = canonicalTierJson(base, 'standard');
    const b = canonicalTierJson(base, 'deep');
    expect(a).not.toBe(b);
  });

  it('excludes api_key', () => {
    const withKey: LlmConfig = { ...base, api_key: 'secret' };
    const withoutKey = base;
    expect(canonicalTierJson(withKey, 't')).toBe(canonicalTierJson(withoutKey, 't'));
  });

  it('changes when provider changes', () => {
    const a = canonicalTierJson(base, 't');
    const b = canonicalTierJson({ ...base, provider: 'ollama' }, 't');
    expect(a).not.toBe(b);
  });

  it('changes when consensus changes', () => {
    const a = canonicalTierJson(base, 't');
    const b = canonicalTierJson({ ...base, consensus: 3 }, 't');
    expect(a).not.toBe(b);
  });

  it('omits undefined fields', () => {
    const a = canonicalTierJson({ ...base, endpoint: undefined }, 't');
    const b = canonicalTierJson(base, 't');
    expect(a).toBe(b);
  });

  it('handles array-valued fields in canonical form', () => {
    // Exercises the Array.isArray branch in canonicalJson.
    // Cast through unknown to inject a non-standard field with an array value.
    const withArray = { ...base, extra: ['a', 'b'] } as unknown as LlmConfig;
    const json = canonicalTierJson(withArray, 't');
    expect(json).toContain('["a","b"]');
  });

  it('excludes max_prompt_chars — present vs absent yields IDENTICAL canonicalTierJson', () => {
    // max_prompt_chars is a quality gate, not a reviewer identity field.
    // Changing or removing it must never cascade re-approval.
    const withCap: LlmConfig = { ...base, max_prompt_chars: 200000 };
    const withoutCap = base;
    expect(canonicalTierJson(withCap, 't')).toBe(canonicalTierJson(withoutCap, 't'));
  });

  it('excludes max_prompt_chars regardless of value', () => {
    const with1: LlmConfig = { ...base, max_prompt_chars: 50000 };
    const with2: LlmConfig = { ...base, max_prompt_chars: 999999 };
    expect(canonicalTierJson(with1, 't')).toBe(canonicalTierJson(with2, 't'));
  });
});
