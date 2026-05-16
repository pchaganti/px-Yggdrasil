import { readFile } from 'node:fs/promises';
import { debugWrite } from '../utils/debug-log.js';

/**
 * Read a UTF-8 text file. If the file is missing (ENOENT) return the supplied default.
 * Any other error (EACCES, EISDIR, EIO, …) is rethrown — callers must handle real failures.
 *
 * The `defaultValue` is returned without coercion when the read fails with ENOENT.
 */
export async function readFileOrDefault<T>(
  absPath: string,
  defaultValue: T,
  debugContext?: string,
): Promise<string | T> {
  try {
    return await readFile(absPath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      if (debugContext) {
        debugWrite(`${debugContext}: missing file ${absPath} -> default`);
      }
      return defaultValue;
    }
    throw err;
  }
}
