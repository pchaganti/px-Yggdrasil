import path from 'node:path';

/**
 * Resolve a Java import FQN to a repo-relative POSIX `.java` source file, or undefined.
 *
 * The specifier is what the extractor emits: a fully-qualified Java name. The
 * dispatch boundary (`makeResolvePathToFile`) routes the two universes:
 *   - TYPE FQN (`com.foo.Bar`, from a single-type or static import): routed through
 *     `resolveJavaFqn` — returns a single file, NO package fall-through.
 *   - PACKAGE FQN (`com.foo`, from a wildcard import, tagged `isPackage`): routed
 *     through `resolveJavaPackageFiles` — returns the candidate file LIST so the
 *     caller can apply owner-set collapse (one owner → attribute, 0/2+ → silence).
 *
 * Java compiles `package a.b.c; class Foo` to a path ending `a/b/c/Foo.java` under
 * SOME source root (commonly `src/main/java`, `src/test/java`, or a module srcDir;
 * flat layouts also exist). There is no single canonical root, so — exactly like
 * the Python module-path search — we probe the FQN as a file rooted at the importing
 * file's directory and at every ancestor directory up to (and including) the repo
 * root, nearest-first. The FIRST existing candidate wins.
 *
 * RESOLUTION MISS → undefined. This fail-to-silence is the single most important
 * false-positive guard: a `java.*` / `javax.*` / `jakarta.*` stdlib type, a
 * third-party library type, or any FQN whose file is not present resolves to
 * nothing and is never flagged.
 */
export interface JavaResolveDeps {
  /** Does a file exist at this repo-relative POSIX path? */
  exists(repoRelPosix: string): boolean;
  /** Repo-relative POSIX paths of `.java` files directly in this directory (no recursion). */
  javaFilesIn(repoRelDir: string): string[];
}

/**
 * Resolve a single-TYPE Java import FQN (`com.foo.Bar`) to a repo-relative `.java`
 * file, or undefined. NO package fall-through: a hint reaches here only for a TYPE
 * (the extractor tags package wildcards with `isPackage`, routed through
 * `resolveJavaPackageFiles` instead). A type FQN whose path is actually a package
 * DIRECTORY resolves to nothing — silence, not a phantom package edge.
 */
export function resolveJavaFqn(
  specifier: string,
  fromFile: string,
  deps: JavaResolveDeps,
): string | undefined {
  const segments = specifier.split('.').filter((s) => s.length > 0);
  if (segments.length === 0) return undefined;
  return resolveType(segments, fromFile, deps);
}

/**
 * Resolve a wildcard PACKAGE FQN (`com.foo`) to the candidate `.java` files in the
 * resolved package directory, found via the same ancestor-source-root search the type
 * resolver uses. Returns the FULL list (caller computes the owner set: one owner →
 * attribute, zero or 2+ → silence). Empty list = the package directory was found
 * nowhere, or exists with no `.java` files.
 */
export function resolveJavaPackageFiles(
  packageFqn: string,
  fromFile: string,
  deps: JavaResolveDeps,
): string[] {
  const segments = packageFqn.split('.').filter((s) => s.length > 0);
  if (segments.length === 0) return [];
  const pkgDir = segments.join('/'); // com/foo
  for (const dir of ancestorDirs(path.posix.dirname(toPosix(fromFile)))) {
    const repoRelDir = joinUnder(dir, pkgDir);
    const files = deps.javaFilesIn(repoRelDir);
    if (files.length > 0) return [...files].sort();
  }
  return [];
}

/** TYPE FQN `com.foo.Bar` → `com/foo/Bar.java` (with the nested-type parent fallback). */
function resolveType(
  segments: string[],
  fromFile: string,
  deps: JavaResolveDeps,
): string | undefined {
  const typePath = segments.join('/') + '.java'; // com/foo/Bar.java
  // Nested-type longest-match: drop the trailing segment (`Inner`) and try the
  // enclosing type's file (`com/foo/Outer.java`). Only when there is a segment to
  // drop beyond the bare class (>= 2 segments left after dropping).
  const parentTypePath =
    segments.length >= 2 ? segments.slice(0, -1).join('/') + '.java' : undefined;

  for (const dir of ancestorDirs(path.posix.dirname(toPosix(fromFile)))) {
    const candidates: string[] = [joinUnder(dir, typePath)];
    if (parentTypePath !== undefined) candidates.push(joinUnder(dir, parentTypePath));
    for (const cand of candidates) {
      if (deps.exists(cand)) return cand;
    }
  }
  return undefined;
}

/** The importing file's directory and every ancestor directory up to the repo root,
 *  nearest-first. '' (the repo root) is the final entry. */
function ancestorDirs(dir: string): string[] {
  const out: string[] = [];
  let cur = dir === '.' ? '' : dir;
  for (;;) {
    out.push(cur);
    if (cur === '') break;
    const parent = path.posix.dirname(cur);
    cur = parent === '.' ? '' : parent;
  }
  return out;
}

/** Join a repo-relative directory with a sub-path, normalizing. '' → the sub-path itself. */
function joinUnder(dir: string, sub: string): string {
  return path.posix.normalize(dir === '' ? sub : path.posix.join(dir, sub));
}

function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}
