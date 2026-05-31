import { describe, it, expect } from 'vitest';
import { parseLog } from '../../../src/core/parsing/log-parser.js';

describe('parseLog', () => {
  it('returns empty array for empty string', () => {
    expect(parseLog('')).toEqual([]);
  });

  it('parses single entry', () => {
    const content = '## [2026-05-11T14:23:00.123Z]\nHello world.\n';
    const entries = parseLog(content);
    expect(entries).toHaveLength(1);
    expect(entries[0].datetime).toBe('2026-05-11T14:23:00.123Z');
    expect(entries[0].body).toBe('Hello world.\n');
    expect(entries[0].offsetStart).toBe(0);
    expect(entries[0].offsetEnd).toBe(content.length);
  });

  it('parses multiple entries with byte-exact offsets', () => {
    const e1 = '## [2026-05-11T14:23:00.123Z]\nFirst.\n';
    const e2 = '## [2026-05-11T14:24:00.000Z]\nSecond.\n';
    const content = e1 + e2;
    const entries = parseLog(content);
    expect(entries).toHaveLength(2);
    expect(entries[0].offsetStart).toBe(0);
    expect(entries[0].offsetEnd).toBe(Buffer.byteLength(e1, 'utf-8'));
    expect(entries[1].offsetStart).toBe(Buffer.byteLength(e1, 'utf-8'));
    expect(entries[1].offsetEnd).toBe(content.length);
    expect(entries[0].body).toBe('First.\n');
    expect(entries[1].body).toBe('Second.\n');
  });

  it('preserves sub-headers and code fences in body', () => {
    const content =
      '## [2026-05-11T14:23:00.123Z]\n' +
      'Intro.\n' +
      '### Implementation note\n' +
      'detail.\n' +
      '```python\n' +
      '## not a header (inside fence)\n' +
      '```\n';
    const entries = parseLog(content);
    expect(entries).toHaveLength(1);
    expect(entries[0].body).toContain('### Implementation note');
    expect(entries[0].body).toContain('## not a header');
  });

  it('lenient on malformed preamble — skips lines before first ## [', () => {
    const content = 'garbage prefix\n## [2026-05-11T14:23:00.123Z]\nBody.\n';
    const entries = parseLog(content);
    expect(entries).toHaveLength(1);
    expect(entries[0].datetime).toBe('2026-05-11T14:23:00.123Z');
    expect(entries[0].offsetStart).toBe(Buffer.byteLength('garbage prefix\n', 'utf-8'));
  });

  it('CRLF input: header still parses, body includes \\r prefix from CRLF lines', () => {
    const content = '## [2026-05-11T14:23:00.123Z]\r\nBody line.\r\n';
    const entries = parseLog(content);
    expect(entries).toHaveLength(1);
    expect(entries[0].datetime).toBe('2026-05-11T14:23:00.123Z');
    expect(entries[0].body).toBe('Body line.\r\n');
  });

  it('UTF-8 multibyte: byte offsets count bytes not codepoints', () => {
    const header = '## [2026-05-11T14:23:00.123Z]\n';
    const body = 'café\n';
    const content = header + body;
    const entries = parseLog(content);
    expect(entries[0].offsetEnd).toBe(Buffer.byteLength(content, 'utf-8'));
    expect(entries[0].offsetEnd).not.toBe(content.length);
  });

  it('fence-aware: a `## [datetime]` line inside a code fence is body, not a second entry', () => {
    const content = [
      '## [2026-05-11T14:23:00.123Z]',
      'Body before the fence.',
      '```',
      '## [2027-01-01T00:00:00.000Z]',
      'this datetime line is inside a fence — not a real header',
      '```',
      'Body after the fence.',
      '',
    ].join('\n');
    const entries = parseLog(content);
    expect(entries).toHaveLength(1);
    expect(entries[0].datetime).toBe('2026-05-11T14:23:00.123Z');
    expect(entries[0].body).toContain('## [2027-01-01T00:00:00.000Z]');
  });

  it('fence-aware: real headers before and after a fenced datetime line both parse', () => {
    const content = [
      '## [2026-05-11T14:23:00.123Z]',
      '```',
      '## [2099-01-01T00:00:00.000Z]',
      '```',
      '## [2026-05-12T10:00:00.000Z]',
      'Second real entry.',
      '',
    ].join('\n');
    const entries = parseLog(content);
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.datetime)).toEqual([
      '2026-05-11T14:23:00.123Z',
      '2026-05-12T10:00:00.000Z',
    ]);
  });
});
