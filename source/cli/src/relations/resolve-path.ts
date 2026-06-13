import path from 'node:path';
import { existsSync } from 'node:fs';
import { resolveTsPath } from './extractors/typescript-resolve.js';

/** Production resolvePathToFile: dispatches by language to the per-language path resolver.
 *  Checks existence against the project's files on disk. Symbol-resolved languages (and
 *  not-yet-implemented ones) return undefined here — they resolve via the SymbolTable. */
export function makeResolvePathToFile(projectRoot: string): (specifier: string, fromFile: string, language: string) => string | undefined {
  const exists = (repoRelPosix: string): boolean => existsSync(path.resolve(projectRoot, repoRelPosix));
  return (specifier, fromFile, language) => {
    if (language === 'typescript' || language === 'tsx' || language === 'javascript') {
      return resolveTsPath(specifier, fromFile, exists);
    }
    return undefined;
  };
}
