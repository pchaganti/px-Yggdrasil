import { minimatch } from 'minimatch';
import type { SourceFile } from './types.js';

export function inFile(file: SourceFile, pattern: string | RegExp): boolean {
  if (pattern instanceof RegExp) {
    return pattern.test(file.path);
  }
  if (/[*?[]/.test(pattern)) {
    return minimatch(file.path, pattern);
  }
  return file.path.includes(pattern);
}
