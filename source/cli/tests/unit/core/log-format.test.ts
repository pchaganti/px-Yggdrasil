import { describe, it, expect } from 'vitest';
import { validateFormat } from '../../../src/core/log-format.js';

describe('validateFormat', () => {
  it('empty file is valid', () => {
    expect(validateFormat('')).toEqual([]);
  });

  it('single entry valid', () => {
    const ok = '## [2026-05-11T14:23:00.123Z]\nBody.\n';
    expect(validateFormat(ok)).toEqual([]);
  });

  it('non-empty file not starting with ## [ → invalid_start', () => {
    const v = validateFormat('garbage\n## [2026-05-11T14:23:00.123Z]\nBody.\n');
    expect(v.find((x) => x.reason === 'invalid_start')).toBeDefined();
    expect(v[0].line).toBe(1);
  });

  it('header without parseable datetime → invalid_header', () => {
    const v = validateFormat('## [notadate]\nBody.\n');
    expect(v.find((x) => x.reason === 'invalid_header')).toBeDefined();
  });

  it('datetime missing milliseconds → invalid_datetime', () => {
    const v = validateFormat('## [2026-05-11T14:23:00Z]\nBody.\n');
    expect(v.find((x) => x.reason === 'invalid_datetime')).toBeDefined();
  });

  it('datetime missing Z suffix → invalid_datetime', () => {
    const v = validateFormat('## [2026-05-11T14:23:00.123]\nBody.\n');
    expect(v.find((x) => x.reason === 'invalid_datetime')).toBeDefined();
  });

  it('level-2 header in body outside fence → level2_header_in_body', () => {
    const content = '## [2026-05-11T14:23:00.123Z]\nIntro.\n## stray\n';
    const v = validateFormat(content);
    const violation = v.find((x) => x.reason === 'level2_header_in_body');
    expect(violation).toBeDefined();
    expect(violation!.line).toBe(3);
  });

  it('level-2 header inside backtick fence → no violation', () => {
    const content =
      '## [2026-05-11T14:23:00.123Z]\n' +
      '```python\n' +
      '## comment in python\n' +
      '```\n';
    expect(validateFormat(content).find((x) => x.reason === 'level2_header_in_body')).toBeUndefined();
  });

  it('unclosed code fence → unclosed_code_fence', () => {
    const content =
      '## [2026-05-11T14:23:00.123Z]\n' +
      '```\nopen forever\n';
    const v = validateFormat(content);
    expect(v.find((x) => x.reason === 'unclosed_code_fence')).toBeDefined();
  });

  it('out-of-order entries → out_of_order on the offender', () => {
    const content =
      '## [2026-05-11T14:24:00.000Z]\nfirst.\n' +
      '## [2026-05-11T14:23:00.000Z]\nsecond (earlier!).\n';
    const v = validateFormat(content);
    expect(v.find((x) => x.reason === 'out_of_order')).toBeDefined();
  });

  it('duplicate datetimes → duplicate_datetime', () => {
    const content =
      '## [2026-05-11T14:23:00.000Z]\na.\n' +
      '## [2026-05-11T14:23:00.000Z]\nb.\n';
    const v = validateFormat(content);
    expect(v.find((x) => x.reason === 'duplicate_datetime')).toBeDefined();
  });

  it('tilde fences are NOT recognized as code fences (## inside still violates)', () => {
    const content =
      '## [2026-05-11T14:23:00.123Z]\n' +
      '~~~\n## inside tilde\n~~~\n';
    const v = validateFormat(content);
    expect(v.find((x) => x.reason === 'level2_header_in_body')).toBeDefined();
  });

  it('close fence with more backticks than open is valid', () => {
    const content =
      '## [2026-05-11T14:23:00.123Z]\n' +
      '```\ncode\n````\nafter.\n';
    const v = validateFormat(content);
    expect(v.find((x) => x.reason === 'unclosed_code_fence')).toBeUndefined();
  });

  it('close fence with FEWER backticks than open does NOT close', () => {
    const content =
      '## [2026-05-11T14:23:00.123Z]\n' +
      '````\ncode\n```\nmore.\n';
    const v = validateFormat(content);
    expect(v.find((x) => x.reason === 'unclosed_code_fence')).toBeDefined();
  });
});
