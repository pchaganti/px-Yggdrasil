import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createCtxFs, UndeclaredFsReadError } from '../../../src/structure/ctx-fs.js';

describe('ctx.fs', () => {
  let root: string;
  let touched: string[];
  const allowedSet = new Set(['src/foo.ts', 'src/bar.ts', 'src/lib/baz.ts']);

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'yg-ctx-fs-'));
    mkdirSync(path.join(root, 'src/lib'), { recursive: true });
    writeFileSync(path.join(root, 'src/foo.ts'), 'foo-content');
    writeFileSync(path.join(root, 'src/bar.ts'), 'bar-content');
    writeFileSync(path.join(root, 'src/lib/baz.ts'), 'baz-content');
    touched = [];
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('exists() returns "file" for allowed file', () => {
    const fs = createCtxFs({ allowedSet, projectRoot: root, touchedFiles: touched });
    expect(fs.exists('src/foo.ts')).toBe('file');
  });

  it('exists() returns "dir" for allowed dir (ancestor of allowed file)', () => {
    const fs = createCtxFs({ allowedSet, projectRoot: root, touchedFiles: touched });
    expect(fs.exists('src/lib')).toBe('dir');
  });

  it('exists() throws UndeclaredFsReadError for unmapped path', () => {
    const fs = createCtxFs({ allowedSet, projectRoot: root, touchedFiles: touched });
    expect(() => fs.exists('src/forbidden.ts')).toThrow(UndeclaredFsReadError);
  });

  it('exists() registers touched (negative dependency, even when missing)', () => {
    const fs = createCtxFs({ allowedSet, projectRoot: root, touchedFiles: touched });
    fs.exists('src/foo.ts');
    expect(touched).toContain('src/foo.ts');
  });

  it('read() returns file content', () => {
    const fs = createCtxFs({ allowedSet, projectRoot: root, touchedFiles: touched });
    expect(fs.read('src/foo.ts')).toBe('foo-content');
  });

  it('read() throws for unmapped path', () => {
    const fs = createCtxFs({ allowedSet, projectRoot: root, touchedFiles: touched });
    expect(() => fs.read('src/forbidden.ts')).toThrow(UndeclaredFsReadError);
  });

  it('read() tracks touched', () => {
    const fs = createCtxFs({ allowedSet, projectRoot: root, touchedFiles: touched });
    fs.read('src/foo.ts');
    expect(touched).toContain('src/foo.ts');
  });

  it('list() returns entries for allowed dir', () => {
    const fs = createCtxFs({ allowedSet, projectRoot: root, touchedFiles: touched });
    const entries = fs.list('src/lib');
    expect(entries).toEqual(expect.arrayContaining([{ name: 'baz.ts', kind: 'file' }]));
  });

  it('list() throws for unmapped dir', () => {
    const fs = createCtxFs({ allowedSet, projectRoot: root, touchedFiles: touched });
    expect(() => fs.list('src/forbidden')).toThrow(UndeclaredFsReadError);
  });
});
