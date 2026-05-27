import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileOrDefault } from '../../../src/io/read-or-default.js';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let dir: string;

beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), 'yg-test-')); });
afterAll(async () => { await rm(dir, { recursive: true }); });

describe('readFileOrDefault', () => {
  it('returns file content when file exists', async () => {
    const file = join(dir, 'exists.txt');
    await writeFile(file, 'hello', 'utf-8');
    const result = await readFileOrDefault(file, 'fallback');
    expect(result).toBe('hello');
  });

  it('returns default when file is missing (no debugContext)', async () => {
    const result = await readFileOrDefault(join(dir, '__missing__.txt'), 'default-value');
    expect(result).toBe('default-value');
  });

  it('returns default when file is missing (with debugContext)', async () => {
    const result = await readFileOrDefault(join(dir, '__missing__.txt'), 'default-value', 'test-context');
    expect(result).toBe('default-value');
  });

  it('rethrows non-ENOENT errors (EISDIR)', async () => {
    await expect(readFileOrDefault(dir, 'fallback')).rejects.toThrow();
  });
});
