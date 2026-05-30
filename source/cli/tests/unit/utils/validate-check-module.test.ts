import { describe, it, expect } from 'vitest';
import { validateCheckModuleExport } from '../../../src/utils/validate-check-module.js';

const opts = { codePrefix: 'AST', runnerLabel: `aspect 'demo'` };

describe('validateCheckModuleExport', () => {
  it('accepts a valid named check function with arity 1', () => {
    const mod = { check: (_ctx: unknown) => [] };
    expect(validateCheckModuleExport(mod, opts)).toEqual({ ok: true });
  });

  it('rejects a default export named check', () => {
    function check(_ctx: unknown) { return []; }
    const mod = { default: check };
    const r = validateCheckModuleExport(mod, opts);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected failure');
    expect(r.code).toBe('AST_CHECK_DEFAULT_EXPORT');
    expect(r.message.what).toMatch(/default/i);
    expect(r.message.next).toMatch(/export function check/);
  });

  it('rejects a missing check export', () => {
    const mod = { notCheck: 1 };
    const r = validateCheckModuleExport(mod, opts);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected failure');
    expect(r.code).toBe('AST_CHECK_NOT_EXPORTED');
    expect(r.message.what).toContain(`aspect 'demo'`);
  });

  it('falls through to NOT_EXPORTED when default is not a function named check', () => {
    const mod = { default: 42 };
    const r = validateCheckModuleExport(mod, opts);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected failure');
    expect(r.code).toBe('AST_CHECK_NOT_EXPORTED');
  });

  it('rejects a non-function check export', () => {
    const mod = { check: 42 };
    const r = validateCheckModuleExport(mod, opts);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected failure');
    expect(r.code).toBe('AST_CHECK_NOT_FUNCTION');
    expect(r.message.what).toMatch(/number/);
  });

  it('rejects a check function with the wrong arity', () => {
    const mod = { check: (_ctx: unknown, _extra: unknown) => [] };
    const r = validateCheckModuleExport(mod, opts);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected failure');
    expect(r.code).toBe('AST_CHECK_WRONG_ARITY');
    expect(r.message.what).toMatch(/2/);
  });

  it('uses the STRUCTURE prefix when requested', () => {
    const mod = { notCheck: 1 };
    const r = validateCheckModuleExport(mod, { codePrefix: 'STRUCTURE', runnerLabel: `aspect 'x'` });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected failure');
    expect(r.code).toBe('STRUCTURE_CHECK_NOT_EXPORTED');
  });
});
