import { describe, it, expect } from 'vitest';
import {
  isV5ConfigFormat,
  isV4ConfigFormat,
  isV4AspectReviewerString,
  isMixedConfigFormat,
} from '../../../src/core/format-version.js';

describe('isV5ConfigFormat', () => {
  it('returns true for reviewer with tiers', () => {
    expect(isV5ConfigFormat({ reviewer: { tiers: {} } })).toBe(true);
  });

  it('returns false for reviewer with active (v4)', () => {
    expect(isV5ConfigFormat({ reviewer: { active: 'ollama' } })).toBe(false);
  });

  it('returns false when reviewer absent', () => {
    expect(isV5ConfigFormat({ version: '5.0.0' })).toBe(false);
  });

  it('returns false when reviewer is string', () => {
    expect(isV5ConfigFormat({ reviewer: 'foo' })).toBe(false);
  });
});

describe('isV4ConfigFormat', () => {
  it('returns true for reviewer with active', () => {
    expect(isV4ConfigFormat({ reviewer: { active: 'X' } })).toBe(true);
  });

  it('returns true for reviewer with provider key', () => {
    expect(isV4ConfigFormat({ reviewer: { ollama: { model: 'q' } } })).toBe(true);
  });

  it('returns false for v5 config', () => {
    expect(isV4ConfigFormat({ reviewer: { tiers: {} } })).toBe(false);
  });

  it('returns false when reviewer absent', () => {
    expect(isV4ConfigFormat({})).toBe(false);
  });
});

describe('isV4AspectReviewerString', () => {
  it('returns true for reviewer: "llm"', () => {
    expect(isV4AspectReviewerString({ reviewer: 'llm' })).toBe(true);
  });

  it('returns true for reviewer: "ast"', () => {
    expect(isV4AspectReviewerString({ reviewer: 'ast' })).toBe(true);
  });

  it('returns false for v5 object', () => {
    expect(isV4AspectReviewerString({ reviewer: { type: 'llm' } })).toBe(false);
  });

  it('returns false when reviewer absent', () => {
    expect(isV4AspectReviewerString({ name: 'foo' })).toBe(false);
  });
});

describe('isMixedConfigFormat', () => {
  it('returns true when both tiers and active present', () => {
    expect(isMixedConfigFormat({ reviewer: { tiers: {}, active: 'X' } })).toBe(true);
  });

  it('returns false for pure v5', () => {
    expect(isMixedConfigFormat({ reviewer: { tiers: {} } })).toBe(false);
  });
});
