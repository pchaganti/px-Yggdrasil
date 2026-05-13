import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileContentCache } from '../../../src/core/file-content-cache.js';

describe('FileContentCache', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'fcc-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reads small text file', async () => {
    const path = join(tmpDir, 'small.txt');
    writeFileSync(path, 'hello world');
    const cache = new FileContentCache();
    const result = await cache.read(path);
    expect(result.content).toBe('hello world');
    expect(result.isBinary).toBe(false);
    expect(result.tooLarge).toBe(false);
  });

  it('caches reads (returns same object reference)', async () => {
    const path = join(tmpDir, 'cached.txt');
    writeFileSync(path, 'content');
    const cache = new FileContentCache();
    const r1 = await cache.read(path);
    const r2 = await cache.read(path);
    expect(r1).toBe(r2);
  });

  it('detects binary via null bytes in first 8KB', async () => {
    const path = join(tmpDir, 'binary.bin');
    const buf = Buffer.concat([
      Buffer.from('hello'),
      Buffer.from([0x00, 0x01]),
      Buffer.from('world'),
    ]);
    writeFileSync(path, buf);
    const cache = new FileContentCache();
    const result = await cache.read(path);
    expect(result.isBinary).toBe(true);
    expect(result.content).toBeUndefined();
  });

  it('flags files over 5MB as tooLarge', async () => {
    const path = join(tmpDir, 'big.txt');
    writeFileSync(path, 'a'.repeat(5 * 1024 * 1024 + 1));
    const cache = new FileContentCache();
    const result = await cache.read(path);
    expect(result.tooLarge).toBe(true);
    expect(result.content).toBeUndefined();
  });

  it('reports unreadable files', async () => {
    const cache = new FileContentCache();
    const result = await cache.read(join(tmpDir, 'nonexistent.txt'));
    expect(result.unreadable).toBe(true);
    expect(result.content).toBeUndefined();
    expect(result.unreadableReason).toMatch(/ENOENT/);
  });

  it('captures OS error message for unreadable files', async () => {
    const cache = new FileContentCache();
    const result = await cache.read(join(tmpDir, 'missing-X.txt'));
    expect(result.unreadable).toBe(true);
    expect(result.unreadableReason).toBeDefined();
    expect(typeof result.unreadableReason).toBe('string');
  });

  it('reports unreadable when readFile fails after stat succeeds (broken symlink)', async () => {
    const target = join(tmpDir, 'real.txt');
    const link = join(tmpDir, 'link.txt');
    writeFileSync(target, 'data');
    const fs = await import('node:fs');
    fs.symlinkSync(target, link);
    fs.unlinkSync(target);
    const cache = new FileContentCache();
    const result = await cache.read(link);
    expect(result.unreadable).toBe(true);
    expect(result.unreadableReason).toBeDefined();
  });
});
