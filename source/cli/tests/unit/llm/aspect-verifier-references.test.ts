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

  it('does NOT include a yg-suppress notice about references', () => {
    // Design decision: references are context, not code under review. The reviewer
    // operates on <source-files> only; suppress markers inside reference content
    // are nonsensical by construction and need no explicit warning. The standard
    // <task> yg-suppress instructions about source files remain, but there must
    // be no reference-specific notice anywhere in the prompt.
    const out = buildPrompt(aspect, 'desc', node, [], [
      { path: 'd.md', content: 'x' },
    ]);
    // No mention pairing suppression with references (defensive notice was removed).
    expect(out).not.toMatch(/MUST be ignored/i);
    expect(out).not.toMatch(/NOT subject to review/i);
    expect(out).not.toMatch(/Supporting files follow/i);
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
