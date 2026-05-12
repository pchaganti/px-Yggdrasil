import { describe, it, expect } from 'vitest';
import { validateNodePath } from '../../../src/utils/node-path-validator.js';

describe('validateNodePath', () => {
  it('accepts simple POSIX path', () => {
    expect(validateNodePath('billing/cancel')).toEqual({ ok: true, normalized: 'billing/cancel' });
  });

  it('strips trailing slash', () => {
    expect(validateNodePath('billing/cancel/')).toEqual({ ok: true, normalized: 'billing/cancel' });
  });

  it('rejects empty string', () => {
    const r = validateNodePath('');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/empty/i);
  });

  it('rejects absolute path (starts with /)', () => {
    const r = validateNodePath('/billing/cancel');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/absolute/i);
  });

  it('rejects Windows-style absolute path', () => {
    const r = validateNodePath('C:/billing');
    expect(r.ok).toBe(false);
  });

  it('rejects path with ..', () => {
    const r = validateNodePath('billing/../escape');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/\.\./);
  });

  it('normalizes backslash to forward slash', () => {
    const r = validateNodePath('billing\\cancel');
    expect(r).toEqual({ ok: true, normalized: 'billing/cancel' });
  });

  it('rejects path starting with model/', () => {
    const r = validateNodePath('model/billing');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/model\//);
  });

  it('accepts deeply nested path', () => {
    expect(validateNodePath('a/b/c/d')).toEqual({ ok: true, normalized: 'a/b/c/d' });
  });
});
