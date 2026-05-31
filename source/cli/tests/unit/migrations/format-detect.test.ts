import { describe, it, expect } from 'vitest';
import {
  isCurrentConfigFormat,
  isLegacyConfigFormat,
  isLegacyAspectReviewer,
  isMixedConfigFormat,
} from '../../../src/core/format-detect.js';

describe('isCurrentConfigFormat', () => {
  it('returns true for reviewer with tiers', () => {
    expect(isCurrentConfigFormat({ reviewer: { tiers: {} } })).toBe(true);
  });

  it('returns false for reviewer with active (legacy)', () => {
    expect(isCurrentConfigFormat({ reviewer: { active: 'ollama' } })).toBe(false);
  });

  it('returns false when reviewer absent', () => {
    expect(isCurrentConfigFormat({ version: '5.0.0' })).toBe(false);
  });

  it('returns false when reviewer is string', () => {
    expect(isCurrentConfigFormat({ reviewer: 'foo' })).toBe(false);
  });
});

describe('isLegacyConfigFormat', () => {
  it('returns true for reviewer with active', () => {
    expect(isLegacyConfigFormat({ reviewer: { active: 'X' } })).toBe(true);
  });

  it('returns true for reviewer with provider key', () => {
    expect(isLegacyConfigFormat({ reviewer: { ollama: { model: 'q' } } })).toBe(true);
  });

  it('returns false when tiers is present', () => {
    expect(isLegacyConfigFormat({ reviewer: { tiers: {} } })).toBe(false);
  });

  it('returns false when reviewer absent', () => {
    expect(isLegacyConfigFormat({})).toBe(false);
  });
});

describe('isLegacyAspectReviewer', () => {
  it('returns true for reviewer: "llm"', () => {
    expect(isLegacyAspectReviewer({ reviewer: 'llm' })).toBe(true);
  });

  it('returns true for reviewer: "ast"', () => {
    expect(isLegacyAspectReviewer({ reviewer: 'ast' })).toBe(true);
  });

  it('returns false for mapping reviewer', () => {
    expect(isLegacyAspectReviewer({ reviewer: { type: 'llm' } })).toBe(false);
  });

  it('returns false when reviewer absent', () => {
    expect(isLegacyAspectReviewer({ name: 'foo' })).toBe(false);
  });
});

describe('isMixedConfigFormat', () => {
  it('returns true when both tiers and active present', () => {
    expect(isMixedConfigFormat({ reviewer: { tiers: {}, active: 'X' } })).toBe(true);
  });

  it('returns false when only tiers', () => {
    expect(isMixedConfigFormat({ reviewer: { tiers: {} } })).toBe(false);
  });

  it('returns false when only active', () => {
    expect(isMixedConfigFormat({ reviewer: { active: 'X' } })).toBe(false);
  });

  it('returns true when both tiers and provider key', () => {
    expect(isMixedConfigFormat({ reviewer: { tiers: {}, ollama: { model: 'q' } } })).toBe(true);
  });
});
