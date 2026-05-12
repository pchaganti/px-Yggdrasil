import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { validateAppendOnly } from '../../../src/core/log-integrity.js';

function sha256(s: string): string {
  return createHash('sha256').update(Buffer.from(s, 'utf-8')).digest('hex');
}

describe('validateAppendOnly', () => {
  const e1 = '## [2026-05-11T14:23:00.000Z]\nFirst.\n';
  const e2 = '## [2026-05-11T14:24:00.000Z]\nSecond.\n';

  it('returns ok when baseline still present and prefix unchanged', () => {
    const content = e1;
    const result = validateAppendOnly(content, '2026-05-11T14:23:00.000Z', sha256(e1));
    expect(result).toEqual({ ok: true });
  });

  it('returns ok when content has been APPENDED beyond baseline', () => {
    const content = e1 + e2;
    const result = validateAppendOnly(content, '2026-05-11T14:23:00.000Z', sha256(e1));
    expect(result).toEqual({ ok: true });
  });

  it('returns boundary_missing when baseline datetime not found', () => {
    const content = '## [2026-05-11T15:00:00.000Z]\nReplaced.\n';
    const result = validateAppendOnly(content, '2026-05-11T14:23:00.000Z', sha256(e1));
    expect(result).toEqual({ ok: false, reason: 'boundary_missing' });
  });

  it('returns prefix_modified when baseline entry datetime exists but bytes differ', () => {
    const tampered = '## [2026-05-11T14:23:00.000Z]\nTampered body.\n';
    const result = validateAppendOnly(tampered, '2026-05-11T14:23:00.000Z', sha256(e1));
    expect(result).toEqual({ ok: false, reason: 'prefix_modified' });
  });

  it('byte-exact: trailing newline before next header is part of prefix hash', () => {
    const content = e1 + e2;
    const prefixWithNewline = e1;
    const result = validateAppendOnly(content, '2026-05-11T14:23:00.000Z', sha256(prefixWithNewline));
    expect(result).toEqual({ ok: true });
  });

  it('empty content with baseline → boundary_missing', () => {
    const result = validateAppendOnly('', '2026-05-11T14:23:00.000Z', sha256(e1));
    expect(result).toEqual({ ok: false, reason: 'boundary_missing' });
  });
});
