import { describe, it, expect } from 'vitest';
import type { AspectResponse } from '../../../src/llm/types.js';

describe('AspectResponse errorSource — filter semantics', () => {
  it('codeViolation distinct from provider in filter', () => {
    const responses: AspectResponse[] = [
      { aspectId: 'a', satisfied: false, reason: 'real bug', errorSource: 'codeViolation' },
      { aspectId: 'b', satisfied: false, reason: 'API key invalid', errorSource: 'provider' },
      { aspectId: 'c', satisfied: false, reason: 'check threw', errorSource: 'checkRuntime' },
    ];
    const codeOnly = responses.filter(r => r.errorSource === 'codeViolation');
    const infra = responses.filter(r => r.errorSource !== 'codeViolation');
    expect(codeOnly.length).toBe(1);
    expect(codeOnly[0].aspectId).toBe('a');
    expect(infra.length).toBe(2);
  });

  it('satisfied response still has errorSource: codeViolation', () => {
    const ok: AspectResponse = { aspectId: 'x', satisfied: true, reason: 'ok', errorSource: 'codeViolation' };
    expect(ok.errorSource).toBe('codeViolation');
  });
});
