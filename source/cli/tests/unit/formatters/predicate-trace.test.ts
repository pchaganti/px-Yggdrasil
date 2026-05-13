import { describe, it, expect } from 'vitest';
import { renderTrace } from '../../../src/formatters/predicate-trace.js';
import type { PredicateTrace } from '../../../src/model/file-when.js';

describe('renderTrace', () => {
  it('renders single path atom that matches', () => {
    const t: PredicateTrace = { kind: 'atom-path', pattern: 'src/**', result: true };
    expect(renderTrace(t)).toContain('✓ path matches "src/**"');
  });

  it('renders single path atom that does not match', () => {
    const t: PredicateTrace = { kind: 'atom-path', pattern: '*.py', result: false };
    expect(renderTrace(t)).toContain('✗ path does not match "*.py"');
  });

  it('renders content atom with detail', () => {
    const t: PredicateTrace = {
      kind: 'atom-content',
      pattern: 'foo',
      result: false,
      detail: 'file is binary',
    };
    const out = renderTrace(t);
    expect(out).toContain('✗ content');
    expect(out).toContain('file is binary');
  });

  it('renders all_of as indented tree', () => {
    const t: PredicateTrace = {
      kind: 'all_of',
      result: false,
      children: [
        { kind: 'atom-path', pattern: 'src/**', result: true },
        { kind: 'atom-content', pattern: 'foo', result: false },
      ],
    };
    const out = renderTrace(t);
    expect(out).toContain('all_of:');
    expect(out).toContain('✓ path matches "src/**"');
    expect(out).toContain('✗ content does not match "foo"');
  });

  it('renders exempt trace', () => {
    const t: PredicateTrace = { kind: 'exempt', result: true, reason: '.yggdrasil/' };
    expect(renderTrace(t)).toContain('exempt');
    expect(renderTrace(t)).toContain('.yggdrasil/');
  });

  it('renders any_of branch with child marks', () => {
    const t: PredicateTrace = {
      kind: 'any_of',
      result: true,
      children: [
        { kind: 'atom-path', pattern: '*.ts', result: false },
        { kind: 'atom-path', pattern: '*.tsx', result: true },
      ],
    };
    const out = renderTrace(t);
    expect(out).toContain('any_of:');
    expect(out).toContain('✗ path does not match "*.ts"');
    expect(out).toContain('✓ path matches "*.tsx"');
  });

  it('renders nested operators', () => {
    const t: PredicateTrace = {
      kind: 'all_of',
      result: false,
      children: [
        { kind: 'atom-path', pattern: '*.ts', result: true },
        {
          kind: 'not',
          result: false,
          child: { kind: 'atom-path', pattern: '*.test.ts', result: true },
        },
      ],
    };
    const out = renderTrace(t);
    expect(out).toContain('all_of:');
    expect(out).toContain('not:');
    expect(out).toContain('*.test.ts');
  });
});
