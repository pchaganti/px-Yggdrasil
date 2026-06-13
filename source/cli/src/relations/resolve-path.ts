import path from 'node:path';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { resolveTsPath } from './extractors/typescript-resolve.js';
import { resolvePythonModule } from './extractors/python-resolve.js';
import { resolveGoImport, type GoResolveDeps } from './extractors/go-resolve.js';
import { resolveJavaFqn, type JavaResolveDeps } from './extractors/java-resolve.js';
import { resolvePhpFqn, parsePsr4, type PhpResolveDeps } from './extractors/php-resolve.js';

/** Production resolvePathToFile: dispatches by language to the per-language path resolver.
 *  Checks existence against the project's files on disk. Symbol-resolved languages (and
 *  not-yet-implemented ones) return undefined here — they resolve via the SymbolTable. */
export function makeResolvePathToFile(projectRoot: string): (specifier: string, fromFile: string, language: string) => string | undefined {
  const exists = (repoRelPosix: string): boolean => existsSync(path.resolve(projectRoot, repoRelPosix));
  const goDeps = makeGoResolveDeps(projectRoot);
  const javaDeps = makeJavaResolveDeps(projectRoot, exists);
  const phpDeps = makePhpResolveDeps(projectRoot, exists);
  return (specifier, fromFile, language) => {
    if (language === 'typescript' || language === 'tsx' || language === 'javascript') {
      return resolveTsPath(specifier, fromFile, exists);
    }
    if (language === 'python') {
      return resolvePythonModule(specifier, fromFile, exists);
    }
    if (language === 'go') {
      return resolveGoImport(specifier, fromFile, goDeps);
    }
    if (language === 'java') {
      return resolveJavaFqn(specifier, fromFile, javaDeps);
    }
    if (language === 'php') {
      return resolvePhpFqn(specifier, fromFile, phpDeps);
    }
    return undefined;
  };
}

/**
 * Build the disk-backed Go resolution capabilities for a project root. The module
 * path (the `module <path>` line of go.mod) is read from the nearest go.mod ancestor
 * of the importing file and CACHED per go.mod directory — go.mod is stable across a
 * single factory instance, so each module root is read at most once. Listing the
 * package directory (readdirSync) is the only per-import disk touch.
 *
 * NOTE: makeResolvePathToFile is also used by verify.ts (parse-free re-validation);
 * reading go.mod + readdirSync is fine there — it lists/reads files, it does not parse.
 */
function makeGoResolveDeps(projectRoot: string): GoResolveDeps {
  // Cache: go.mod directory (repo-rel POSIX, '' = root) → module path or undefined.
  const moduleByDir = new Map<string, string | undefined>();

  /** Read the `module <path>` declaration from a go.mod at the given repo-rel dir, or undefined. */
  function readModulePath(repoRelDir: string): string | undefined {
    const abs = path.join(projectRoot, repoRelDir, 'go.mod');
    let text: string;
    try {
      text = readFileSync(abs, 'utf-8');
    } catch {
      return undefined;
    }
    // First non-comment `module <path>` line wins. go.mod is line-oriented; the
    // module directive is mandatory and appears once.
    for (const rawLine of text.split('\n')) {
      const line = rawLine.trim();
      if (line === '' || line.startsWith('//')) continue;
      const m = line.match(/^module\s+(\S+)/);
      if (m) return m[1];
    }
    return undefined;
  }

  /** Find the nearest ancestor directory of `fromFile` that contains a go.mod, then
   *  return its module path. Walks up to (and including) the project root. */
  function modulePathFor(fromFile: string): string | undefined {
    let dir = path.posix.dirname(toPosix(fromFile));
    if (dir === '.') dir = '';
    for (;;) {
      if (moduleByDir.has(dir)) {
        const cached = moduleByDir.get(dir);
        if (cached !== undefined) return cached;
      } else {
        const mod = existsSync(path.join(projectRoot, dir, 'go.mod'))
          ? readModulePath(dir)
          : undefined;
        moduleByDir.set(dir, mod);
        if (mod !== undefined) return mod;
      }
      if (dir === '') return undefined; // reached the root without a usable go.mod
      const parent = path.posix.dirname(dir);
      dir = parent === '.' ? '' : parent;
    }
  }

  function dirExists(repoRelDir: string): boolean {
    const abs = path.resolve(projectRoot, repoRelDir);
    try {
      return statSync(abs).isDirectory();
    } catch {
      return false;
    }
  }

  function goFilesIn(repoRelDir: string): string[] {
    const abs = path.resolve(projectRoot, repoRelDir);
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      return [];
    }
    const out: string[] = [];
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith('.go')) {
        out.push(repoRelDir === '' ? e.name : path.posix.join(repoRelDir, e.name));
      }
    }
    return out;
  }

  return { modulePathFor, dirExists, goFilesIn };
}

/**
 * Build the disk-backed Java resolution capabilities for a project root. Java
 * resolution is pure file/directory existence (the package = directory convention),
 * so `exists` is shared with the other resolvers; the only extra capability is
 * listing a package directory's `.java` files for a wildcard import.
 *
 * NOTE: makeResolvePathToFile is also used by verify.ts (parse-free re-validation);
 * readdirSync is fine there — it lists files, it does not parse.
 */
function makeJavaResolveDeps(
  projectRoot: string,
  exists: (repoRelPosix: string) => boolean,
): JavaResolveDeps {
  function javaFilesIn(repoRelDir: string): string[] {
    const abs = path.resolve(projectRoot, repoRelDir);
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      return [];
    }
    const out: string[] = [];
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith('.java')) {
        out.push(repoRelDir === '' ? e.name : path.posix.join(repoRelDir, e.name));
      }
    }
    return out;
  }
  return { exists, javaFilesIn };
}

/**
 * Build the disk-backed PHP resolution capabilities for a project root. PHP maps a
 * class FQN to a file through composer's PSR-4 autoloading, so the only extra
 * capability beyond `exists` is producing the PSR-4 prefix→directory map in effect for
 * an importing file. That map comes from the NEAREST ancestor composer.json (a monorepo
 * may have several); its `autoload.psr-4` / `autoload-dev.psr-4` are parsed once per
 * composer.json directory and CACHED — composer.json is stable across a single factory
 * instance, so each is read at most once.
 *
 * No composer.json found (or an unreadable / classmap-only one) yields an empty map,
 * which the resolver treats as silence — it never guesses a source root.
 *
 * NOTE: makeResolvePathToFile is also used by verify.ts (parse-free re-validation);
 * reading composer.json there is fine — it reads a file, it does not parse source.
 */
function makePhpResolveDeps(
  projectRoot: string,
  exists: (repoRelPosix: string) => boolean,
): PhpResolveDeps {
  // Cache: composer.json directory (repo-rel POSIX, '' = root) → parsed PSR-4 map.
  const psr4ByDir = new Map<string, Map<string, string[]>>();

  /** Parse the PSR-4 map from a composer.json at the given repo-rel dir, or empty. */
  function readPsr4(repoRelDir: string): Map<string, string[]> {
    const abs = path.join(projectRoot, repoRelDir, 'composer.json');
    let text: string;
    try {
      text = readFileSync(abs, 'utf-8');
    } catch {
      return new Map();
    }
    return parsePsr4(text, repoRelDir);
  }

  /** Find the nearest ancestor directory of `fromFile` that has a composer.json, then
   *  return its parsed PSR-4 map. Walks up to (and including) the project root. The
   *  FIRST composer.json found wins — nested packages own their files. */
  function psr4For(fromFile: string): ReadonlyMap<string, readonly string[]> {
    let dir = path.posix.dirname(toPosix(fromFile));
    if (dir === '.') dir = '';
    for (;;) {
      if (psr4ByDir.has(dir)) {
        const cached = psr4ByDir.get(dir);
        if (cached !== undefined && cached.size > 0) return cached;
      } else if (existsSync(path.join(projectRoot, dir, 'composer.json'))) {
        const map = readPsr4(dir);
        psr4ByDir.set(dir, map);
        if (map.size > 0) return map;
      } else {
        psr4ByDir.set(dir, new Map());
      }
      if (dir === '') return new Map(); // reached the root without a usable composer.json
      const parent = path.posix.dirname(dir);
      dir = parent === '.' ? '' : parent;
    }
  }

  return { psr4For, exists };
}

function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}
