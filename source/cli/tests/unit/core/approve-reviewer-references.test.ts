import { describe, it, expect, vi } from 'vitest';
import { loadAndIsolateReferences } from '../../../src/core/approve-reviewer.js';

describe('loadAndIsolateReferences — failure isolation + cache', () => {
  it('returns content for each reference on success', async () => {
    const reads: string[] = [];
    const readTextFile = vi.fn(async (p: string) => { reads.push(p); return 'CONTENT-' + p; });
    const cache = new Map<string, string>();
    const refs = [{ path: 'docs/a.md', description: 'A' }, { path: 'docs/b.md' }];
    const result = await loadAndIsolateReferences({
      aspectId: 'x',
      references: refs,
      projectRoot: '/p',
      cache,
      readTextFile,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.references.map(r => r.content)).toEqual(['CONTENT-/p/docs/a.md', 'CONTENT-/p/docs/b.md']);
  });

  it('caches reads across multiple loadAndIsolateReferences calls in same invocation', async () => {
    const reads: string[] = [];
    const readTextFile = vi.fn(async (p: string) => { reads.push(p); return 'X'; });
    const cache = new Map<string, string>();
    await loadAndIsolateReferences({
      aspectId: 'x', references: [{ path: 'docs/shared.md' }], projectRoot: '/p', cache, readTextFile,
    });
    await loadAndIsolateReferences({
      aspectId: 'y', references: [{ path: 'docs/shared.md' }], projectRoot: '/p', cache, readTextFile,
    });
    expect(reads.length).toBe(1);
  });

  it('strips UTF-8 BOM from loaded content', async () => {
    const readTextFile = vi.fn(async () => '﻿hello');
    const cache = new Map<string, string>();
    const result = await loadAndIsolateReferences({
      aspectId: 'x', references: [{ path: 'docs/a.md' }], projectRoot: '/p', cache, readTextFile,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.references[0].content).toBe('hello');
  });

  it('returns failure result when a reference read throws', async () => {
    const readTextFile = vi.fn(async (p: string) => {
      if (p.endsWith('missing.md')) throw new Error('ENOENT');
      return 'OK';
    });
    const cache = new Map<string, string>();
    const result = await loadAndIsolateReferences({
      aspectId: 'x', references: [{ path: 'docs/missing.md' }, { path: 'docs/good.md' }],
      projectRoot: '/p', cache, readTextFile,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('LLM_REFERENCE_UNREADABLE');
    expect(result.reason).toContain('docs/missing.md');
  });

  it('empty references → returns ok with empty array', async () => {
    const readTextFile = vi.fn(async () => 'X');
    const cache = new Map<string, string>();
    const result = await loadAndIsolateReferences({
      aspectId: 'x', references: undefined, projectRoot: '/p', cache, readTextFile,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.references).toEqual([]);
    expect(readTextFile).not.toHaveBeenCalled();
  });
});
