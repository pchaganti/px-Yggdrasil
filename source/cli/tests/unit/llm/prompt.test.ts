import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildPairPrompt, assembledPromptChars } from '../../../src/llm/prompt.js';
import type { PairPromptInput } from '../../../src/llm/prompt.js';

const FIXTURES = join(import.meta.dirname, '../../fixtures');

function loadFixture(name: string): string {
  return readFileSync(join(FIXTURES, name), 'utf-8');
}

const input1: PairPromptInput = {
  aspect: {
    id: 'test-aspect',
    description: 'A "quoted" description with <xml> & ampersand',
    content: '# Rules\n\nMust do X.\n\n- Rule 1\n- Rule 2',
  },
  nodeDescription: 'A component that handles <orders> & "payments"',
  nodePath: 'billing/order-handler',
  files: [
    { path: 'src/billing/handler.ts', content: 'export function handleOrder(x: string) {\n  return x;\n}' },
    { path: 'src/billing/utils.ts', content: 'export function util() {}' },
  ],
  references: [
    { path: 'docs/codes.md', description: 'Error codes catalog', content: 'ERR001: bad request\nERR002: not found' },
    { path: 'docs/guide.md', content: 'See guide for details' },
  ],
  scope: undefined,
};

const input2: PairPromptInput = {
  aspect: { id: 'simple', description: '', content: 'Simple rule' },
  nodeDescription: '',
  nodePath: 'core/loader',
  files: [{ path: 'src/loader.ts', content: 'const x = 1;' }],
  references: [],
  scope: undefined,
};

const inputPerFile: PairPromptInput = {
  aspect: {
    id: 'test-aspect',
    description: 'A "quoted" description with <xml> & ampersand',
    content: '# Rules\n\nMust do X.\n\n- Rule 1\n- Rule 2',
  },
  nodeDescription: 'A component that handles <orders> & "payments"',
  nodePath: 'billing/order-handler',
  files: [
    { path: 'src/billing/handler.ts', content: 'export function handleOrder(x: string) {\n  return x;\n}' },
  ],
  references: [
    { path: 'docs/codes.md', description: 'Error codes catalog', content: 'ERR001: bad request\nERR002: not found' },
  ],
  scope: { per: 'file' },
};

describe('buildPairPrompt — per-node golden', () => {
  it('golden 1: byte-identical to fixture (references + description with special chars)', () => {
    const expected = loadFixture('prompt-per-node-golden-1.txt');
    const actual = buildPairPrompt(input1);
    expect(actual).toBe(expected);
  });

  it('golden 2: byte-identical to fixture (minimal, no references, empty description)', () => {
    const expected = loadFixture('prompt-per-node-golden-2.txt');
    const actual = buildPairPrompt(input2);
    expect(actual).toBe(expected);
  });
});

describe('buildPairPrompt — per-file golden', () => {
  it('per-file golden: byte-identical to fixture', () => {
    const expected = loadFixture('prompt-per-file-golden.txt');
    const actual = buildPairPrompt(inputPerFile);
    expect(actual).toBe(expected);
  });

  it('per-file contains the exact framing sentence', () => {
    const prompt = buildPairPrompt(inputPerFile);
    expect(prompt).toContain(
      'You are reviewing ONE file of a larger component. Other files of the component are not shown; the absence of sibling context is NOT a violation by itself. Judge only what this file must satisfy on its own.'
    );
  });

  it('per-file contains exactly one file (the single subject)', () => {
    const prompt = buildPairPrompt(inputPerFile);
    const matches = [...prompt.matchAll(/<file path=/g)];
    expect(matches).toHaveLength(1);
    expect(prompt).toContain('src/billing/handler.ts');
  });

  it('per-node does NOT contain the per-file framing sentence', () => {
    const prompt = buildPairPrompt(input1);
    expect(prompt).not.toContain('You are reviewing ONE file of a larger component.');
  });
});

describe('assembledPromptChars', () => {
  it('equals buildPairPrompt(...).length — single source of truth', () => {
    expect(assembledPromptChars(input1)).toBe(buildPairPrompt(input1).length);
    expect(assembledPromptChars(input2)).toBe(buildPairPrompt(input2).length);
    expect(assembledPromptChars(inputPerFile)).toBe(buildPairPrompt(inputPerFile).length);
  });

  it('returns a positive integer', () => {
    const n = assembledPromptChars(input1);
    expect(n).toBeGreaterThan(0);
    expect(Number.isInteger(n)).toBe(true);
  });
});

describe('buildPairPrompt — XML escaping (adopter-controlled fields)', () => {
  it('escapes < and & and " in file path attribute', () => {
    const prompt = buildPairPrompt({
      ...input2,
      files: [{ path: 'src/<evil>&"file".ts', content: 'x' }],
    });
    expect(prompt).not.toContain('<evil>');
    expect(prompt).toContain('&lt;evil&gt;&amp;&quot;file&quot;');
  });

  it('escapes < and & in file content (text node)', () => {
    const prompt = buildPairPrompt({
      ...input2,
      files: [{ path: 'src/a.ts', content: 'const a = <div> & "b";' }],
    });
    expect(prompt).not.toContain('<div>');
    expect(prompt).toContain('&lt;div&gt;');
    expect(prompt).toContain('&amp;');
  });

  it('escapes < and & and " in nodeDescription attribute', () => {
    const prompt = buildPairPrompt({
      ...input2,
      nodeDescription: 'A <handler> with "quotes" & ampersands',
    });
    expect(prompt).toContain('&lt;handler&gt;');
    expect(prompt).toContain('&quot;quotes&quot;');
    expect(prompt).toContain('&amp; ampersands');
  });

  it('inserts aspect content RAW (XML-like content.md is NOT escaped)', () => {
    const xmlishContent = '<rule>Do <b>not</b> call foo() & bar()</rule>';
    const prompt = buildPairPrompt({
      ...input2,
      aspect: { ...input2.aspect, content: xmlishContent },
    });
    // Content must appear verbatim — not escaped
    expect(prompt).toContain(xmlishContent);
    expect(prompt).not.toContain('&lt;rule&gt;');
  });
});
