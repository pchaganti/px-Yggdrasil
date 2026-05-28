import { describe, it, expect } from 'vitest';
import { buildPrompt } from '../../../src/llm/aspect-verifier.js';

describe('buildPrompt — references block', () => {
  const aspect = { id: 'a', description: 'd', content: '# R' };
  const node = 'svc';

  it('omits <references> when references arg is empty/undefined', () => {
    const out = buildPrompt(aspect, 'desc', node, [{ path: 's.ts', content: 'x' }], []);
    expect(out).not.toContain('<references>');
  });

  it('emits <references> with one entry, description in attribute', () => {
    const out = buildPrompt(aspect, 'desc', node, [{ path: 's.ts', content: 'x' }], [
      { path: 'docs/codes.md', description: 'cat', content: 'CODE1\nCODE2\n' },
    ]);
    expect(out).toContain('<references>');
    expect(out).toContain('<reference path="docs/codes.md" description="cat">');
    expect(out).toContain('CODE1');
    expect(out).toContain('</references>');
  });

  it('emits in declared order', () => {
    const out = buildPrompt(aspect, 'desc', node, [], [
      { path: 'a.md', content: 'AAA' },
      { path: 'b.md', content: 'BBB' },
      { path: 'c.md', content: 'CCC' },
    ]);
    expect(out.indexOf('AAA')).toBeLessThan(out.indexOf('BBB'));
    expect(out.indexOf('BBB')).toBeLessThan(out.indexOf('CCC'));
  });

  it('escapes XML in description attribute', () => {
    const out = buildPrompt(aspect, 'desc', node, [], [
      { path: 'd.md', description: '<bad> & "broken"', content: 'x' },
    ]);
    expect(out).toContain('description="&lt;bad&gt; &amp; &quot;broken&quot;"');
  });

  it('escapes XML in content body (& < >)', () => {
    const out = buildPrompt(aspect, 'desc', node, [], [
      { path: 'd.md', content: 'a & b <c> d' },
    ]);
    expect(out).toContain('a &amp; b &lt;c&gt; d');
  });

  it('includes yg-suppress notice in <task> prose', () => {
    const out = buildPrompt(aspect, 'desc', node, [], [
      { path: 'd.md', content: 'x' },
    ]);
    expect(out).toMatch(/yg-suppress.*MUST be ignored.*<references>/s);
  });

  it('<references> block positioned after <aspect>, before <source-files>', () => {
    const out = buildPrompt(aspect, 'desc', node, [{ path: 's.ts', content: 'x' }], [
      { path: 'r.md', content: 'R' },
    ]);
    const aIdx = out.indexOf('<aspect ');
    const rIdx = out.indexOf('<references>');
    const sIdx = out.indexOf('<source-files>');
    expect(aIdx).toBeLessThan(rIdx);
    expect(rIdx).toBeLessThan(sIdx);
  });
});
