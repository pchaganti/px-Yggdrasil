import { describe, it, expect } from 'vitest';
import { formatFileContext } from '../../../src/formatters/context-file.js';
import { formatNodeContext } from '../../../src/formatters/context-node.js';

function baseFileData(extra: Partial<any>): any {
  return {
    filePath: 'src/x.ts',
    ownerPath: 'svc',
    aspects: [],
    dependencies: [],
    dependentCount: 0,
    ...extra,
  };
}

function baseNodeData(extra: Partial<any>): any {
  return {
    path: 'svc',
    name: 'svc',
    type: 'module',
    sourceFiles: [],
    aspects: [],
    flows: [],
    dependencies: [],
    dependentCount: 0,
    ...extra,
  };
}

describe('formatFileContext — references in read: lines', () => {
  it('emits one read: per reference, after the aspect content.md line', () => {
    const out = formatFileContext(baseFileData({
      aspects: [{
        aspectId: 'a', aspectDescription: 'A',
        verifiedAgainst: '.yggdrasil/aspects/a/content.md',
        references: [
          { path: 'docs/x.md', description: 'short' },
          { path: 'src/y.ts' },
        ],
      }],
    }));
    expect(out).toContain('read: .yggdrasil/aspects/a/content.md');
    expect(out).toContain('read: docs/x.md — short');
    expect(out).toContain('read: src/y.ts');
    expect(out.indexOf('read: .yggdrasil/aspects/a/content.md'))
      .toBeLessThan(out.indexOf('read: docs/x.md'));
  });

  it('truncates long description at word boundary with ... suffix', () => {
    const long = 'one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen';
    const out = formatFileContext(baseFileData({
      aspects: [{
        aspectId: 'a', aspectDescription: 'A',
        verifiedAgainst: '.yggdrasil/aspects/a/content.md',
        references: [{ path: 'docs/x.md', description: long }],
      }],
    }));
    const line = out.split('\n').find(l => l.includes('docs/x.md'))!;
    const tail = line.split('docs/x.md — ')[1];
    expect(tail.endsWith('...')).toBe(true);
    expect(tail.length).toBeLessThanOrEqual(83);
    const beforeDots = tail.slice(0, -3);
    expect(beforeDots[beforeDots.length - 1]).not.toBe(' ');
  });

  it('no description → emits bare path', () => {
    const out = formatFileContext(baseFileData({
      aspects: [{
        aspectId: 'a', aspectDescription: 'A',
        verifiedAgainst: '.yggdrasil/aspects/a/content.md',
        references: [{ path: 'docs/x.md' }],
      }],
    }));
    const line = out.split('\n').find(l => l.includes('docs/x.md'))!;
    expect(line.trim()).toBe('read: docs/x.md');
  });

  it('no references → no extra read: lines (regression)', () => {
    const out = formatFileContext(baseFileData({
      aspects: [{
        aspectId: 'a', aspectDescription: 'A',
        verifiedAgainst: '.yggdrasil/aspects/a/content.md',
      }],
    }));
    const readLines = out.split('\n').filter(l => l.includes('read: '));
    expect(readLines.length).toBe(1);
  });
});

describe('formatNodeContext — references in read: lines', () => {
  it('emits read: per reference under each aspect block', () => {
    const out = formatNodeContext(baseNodeData({
      aspects: [{
        id: 'a', name: 'A', description: '',
        source: 'own',
        verifiedAgainst: '.yggdrasil/aspects/a/content.md',
        references: [{ path: 'docs/x.md', description: 'd' }],
      }],
    }));
    expect(out).toContain('read: docs/x.md — d');
  });
});
