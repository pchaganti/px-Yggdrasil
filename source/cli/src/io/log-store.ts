import { lstat } from 'node:fs/promises';
import { atomicWriteFile } from './atomic-write.js';
import { readFileOrDefault } from './read-or-default.js';
import { debugWrite } from '../utils/debug-log.js';

export async function readLogSafe(logPath: string): Promise<string> {
  return await readFileOrDefault(logPath, '', '[log-store] readLogSafe');
}

export interface LogFileStats {
  isSymbolicLink: boolean;
  hardLinkCount: number;
}

export async function statLogFile(logPath: string): Promise<LogFileStats | null> {
  try {
    const st = await lstat(logPath);
    return { isSymbolicLink: st.isSymbolicLink(), hardLinkCount: st.nlink };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      debugWrite(`[log-store] statLogFile: file not found: ${logPath}`);
      return null;
    }
    throw err;
  }
}

export async function writeLogFile(logPath: string, content: string): Promise<void> {
  await atomicWriteFile(logPath, content);
}
