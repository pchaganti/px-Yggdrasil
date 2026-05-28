import { describe, it, expect } from 'vitest';
import { escapeXmlText } from '../../../src/llm/xml-escape.js';

describe('escapeXmlText', () => {
  it('escapes & first (before < and >)', () => {
    expect(escapeXmlText('a&b<c', { attribute: false })).toBe('a&amp;b&lt;c');
  });

  it('escapes < and >', () => {
    expect(escapeXmlText('<tag>', { attribute: false })).toBe('&lt;tag&gt;');
  });

  it('attribute mode also escapes "', () => {
    expect(escapeXmlText('she said "hi"', { attribute: true })).toBe('she said &quot;hi&quot;');
  });

  it('body mode leaves " unchanged', () => {
    expect(escapeXmlText('"x"', { attribute: false })).toBe('"x"');
  });

  it('preserves tab, newline, carriage return', () => {
    expect(escapeXmlText('a\tb\nc\rd', { attribute: false })).toBe('a\tb\nc\rd');
  });

  it('escapes control chars U+0000..U+001F except tab/newline/CR', () => {
    expect(escapeXmlText('a\x01b', { attribute: false })).toBe('a&#x01;b');
    expect(escapeXmlText('a\x07b', { attribute: false })).toBe('a&#x07;b');
    expect(escapeXmlText('a\x1fb', { attribute: false })).toBe('a&#x1f;b');
  });

  it('round-trip safe for typical aspect descriptions', () => {
    const desc = 'Catalogue of valid <error> codes; reviewer "rejects" unknown & invalid codes';
    const out = escapeXmlText(desc, { attribute: true });
    expect(out).toBe('Catalogue of valid &lt;error&gt; codes; reviewer &quot;rejects&quot; unknown &amp; invalid codes');
  });
});
