import { writeFile, rename, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

/**
 * Write `content` to `filePath` atomically via temp file + rename.
 * Cleans up any stale `<filePath>.tmp` orphan before writing.
 * Creates parent directory recursively if missing.
 */
export async function atomicWriteFile(filePath: string, content: string): Promise<void> {
  const dir = path.dirname(filePath);
  await mkdir(dir, { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  await rm(tmpPath, { force: true });
  await writeFile(tmpPath, content, 'utf-8');
  await rename(tmpPath, filePath);
}
