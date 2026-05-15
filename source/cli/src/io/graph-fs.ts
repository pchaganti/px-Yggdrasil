import { readdir, readFile, writeFile } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { debugWrite } from '../utils/debug-log.js';

export async function readSortedDir(dirPath: string): Promise<Dirent[]> {
  const entries = await readdir(dirPath, { withFileTypes: true });
  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

export async function readTextFile(filePath: string): Promise<string> {
  return readFile(filePath, 'utf-8');
}

export async function readSortedDirOrEmpty(dirPath: string): Promise<Dirent[]> {
  try {
    return await readSortedDir(dirPath);
  } catch (err) {
    debugWrite(`[graph-fs] readdir failed for ${dirPath}: ${(err as Error).message}`);
    return [];
  }
}

export async function writeTextFile(filePath: string, content: string): Promise<void> {
  await writeFile(filePath, content, 'utf-8');
}
