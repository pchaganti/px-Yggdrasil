import { readFile, stat } from 'node:fs/promises';

const SIZE_LIMIT_BYTES = 5 * 1024 * 1024;
const BINARY_PROBE_BYTES = 8 * 1024;

export type FileContentResult = {
  content?: string;
  isBinary: boolean;
  tooLarge: boolean;
  unreadable: boolean;
};

/**
 * Per-run cache of file content for predicate evaluation. Memoizes by
 * absolute path. Performs binary detection (null bytes in first 8KB) and
 * size guard (5MB). Files exceeding the size limit or detected as binary
 * are cached without `content` (predicate evaluators treat those as
 * content-not-evaluable).
 */
export class FileContentCache {
  private readonly entries = new Map<string, Promise<FileContentResult>>();

  read(absPath: string): Promise<FileContentResult> {
    let entry = this.entries.get(absPath);
    if (entry === undefined) {
      entry = this.load(absPath);
      this.entries.set(absPath, entry);
    }
    return entry;
  }

  private async load(absPath: string): Promise<FileContentResult> {
    let stats;
    try {
      stats = await stat(absPath);
    } catch {
      return { isBinary: false, tooLarge: false, unreadable: true };
    }

    if (stats.size > SIZE_LIMIT_BYTES) {
      return { isBinary: false, tooLarge: true, unreadable: false };
    }

    let buf: Buffer;
    try {
      buf = await readFile(absPath);
    } catch {
      return { isBinary: false, tooLarge: false, unreadable: true };
    }

    const probe = buf.subarray(0, BINARY_PROBE_BYTES);
    for (let i = 0; i < probe.length; i++) {
      if (probe[i] === 0) {
        return { isBinary: true, tooLarge: false, unreadable: false };
      }
    }

    return {
      content: buf.toString('utf8'),
      isBinary: false,
      tooLarge: false,
      unreadable: false,
    };
  }
}
