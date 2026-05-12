import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { atomicWriteFile } from '../../../src/utils/atomic-write.js';

describe('atomicWriteFile', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
  });

  async function tempDir(): Promise<string> {
    const d = await mkdtemp(path.join(tmpdir(), 'yg-atomic-'));
    dirs.push(d);
    return d;
  }

  it('writes content to non-existing file', async () => {
    const dir = await tempDir();
    const target = path.join(dir, 'a.txt');
    await atomicWriteFile(target, 'hello');
    expect(await readFile(target, 'utf-8')).toBe('hello');
  });

  it('overwrites existing file', async () => {
    const dir = await tempDir();
    const target = path.join(dir, 'a.txt');
    await writeFile(target, 'old');
    await atomicWriteFile(target, 'new');
    expect(await readFile(target, 'utf-8')).toBe('new');
  });

  it('does not leave .tmp file behind on success', async () => {
    const dir = await tempDir();
    const target = path.join(dir, 'a.txt');
    await atomicWriteFile(target, 'hello');
    const entries = await readdir(dir);
    expect(entries.filter((e) => e.endsWith('.tmp'))).toEqual([]);
  });

  it('removes stale .tmp before write (orphan cleanup)', async () => {
    const dir = await tempDir();
    const target = path.join(dir, 'a.txt');
    const tmpPath = target + '.tmp';
    await writeFile(tmpPath, 'orphan');
    await atomicWriteFile(target, 'hello');
    const entries = await readdir(dir);
    expect(entries.filter((e) => e.endsWith('.tmp'))).toEqual([]);
    expect(await readFile(target, 'utf-8')).toBe('hello');
  });

  it('creates parent directory if missing', async () => {
    const dir = await tempDir();
    const target = path.join(dir, 'nested/sub/a.txt');
    await atomicWriteFile(target, 'hello');
    expect(await readFile(target, 'utf-8')).toBe('hello');
  });
});
