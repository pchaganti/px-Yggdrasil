import { describe, it, expect } from 'vitest';
import type { FileAtomicClause, FileWhenPredicate, PredicateTrace } from '../../../src/model/file-when.js';

describe('FileWhenPredicate type structure', () => {
  it('accepts path atom shape', () => {
    const p: FileWhenPredicate = { path: 'src/**' };
    expect(p.path).toBe('src/**');
  });

  it('accepts content atom shape', () => {
    const p: FileWhenPredicate = { content: 'pattern' };
    expect(p.content).toBe('pattern');
  });

  it('accepts all_of operator shape', () => {
    const p: FileWhenPredicate = { all_of: [{ path: 'a' }, { content: 'b' }] };
    expect((p as { all_of: FileWhenPredicate[] }).all_of).toHaveLength(2);
  });

  it('accepts any_of operator shape', () => {
    const p: FileWhenPredicate = { any_of: [{ path: 'a' }, { content: 'b' }] };
    expect((p as { any_of: FileWhenPredicate[] }).any_of).toHaveLength(2);
  });

  it('accepts not operator shape', () => {
    const p: FileWhenPredicate = { not: { path: 'a' } };
    expect((p as { not: FileAtomicClause }).not.path).toBe('a');
  });
});

describe('PredicateTrace shape', () => {
  it('atom-path variant', () => {
    const t: PredicateTrace = { kind: 'atom-path', pattern: '**', result: true };
    expect(t.kind).toBe('atom-path');
  });

  it('all_of variant has children', () => {
    const t: PredicateTrace = {
      kind: 'all_of',
      result: false,
      children: [
        { kind: 'atom-path', pattern: '**', result: true },
        { kind: 'atom-content', pattern: 'x', result: false },
      ],
    };
    expect(t.children).toHaveLength(2);
  });

  it('exempt variant', () => {
    const t: PredicateTrace = { kind: 'exempt', result: true, reason: '.yggdrasil/' };
    expect(t.reason).toBe('.yggdrasil/');
  });
});
