import { describe, it, expect } from 'vitest';
import {
  isCurrentConfigFormat,
  isLegacyAspectReviewer,
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
