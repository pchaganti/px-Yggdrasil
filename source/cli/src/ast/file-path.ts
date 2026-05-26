import { minimatch } from 'minimatch';
import type { SourceFile } from './types.js';

export type InFilePattern =
  | { glob: string }
  | { regex: RegExp }
  | { contains: string };

export function inFile(file: SourceFile, pattern: InFilePattern): boolean {
  if ('glob' in pattern) return minimatch(file.path, pattern.glob);
  if ('regex' in pattern) return pattern.regex.test(file.path);
  if ('contains' in pattern) return file.path.includes(pattern.contains);
  return false;
}
