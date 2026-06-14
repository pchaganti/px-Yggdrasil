import path from 'node:path';

/**
 * Resolve a Java import FQN to a repo-relative POSIX `.java` source file, or undefined.
 *
 * The specifier is what the extractor emits: a fully-qualified Java name — a TYPE
 * FQN (`com.foo.Bar`, from a single-type or static import) or a PACKAGE FQN
 * (`com.foo`, from a wildcard import).
 *
 * Java compiles `package a.b.c; class Foo` to a path ending `a/b/c/Foo.java` under
 * SOME source root (commonly `src/main/java`, `src/test/java`, or a module srcDir;
 * flat layouts also exist). There is no single canonical root, so — exactly like
 * the Python module-path search — we probe the FQN as a file rooted at the importing
 * file's directory and at every ancestor directory up to (and including) the repo
 * root, nearest-first. The FIRST existing candidate wins.
 *
 * For a TYPE FQN `com.foo.Bar`:
 *   - candidate `com/foo/Bar.java` at each root.
 *   - NESTED TYPE longest-match: `com.foo.Outer.Inner` — `Inner` may be a member of
 *     `Outer`, so also probe `com/foo/Outer.java` (drop the trailing segment). The
 *     deeper (full-FQN) candidate is tried first; the parent is the fallback.
 *
 * For a PACKAGE FQN (`isPackage`, a wildcard import) `com.foo`:
 *   - the package DIRECTORY `com/foo/` at each root; a representative `.java` in it
 *     (via `javaFilesIn`) owns the dependency.
 *
 * `deps.exists` reports file presence; `deps.javaFilesIn` lists `.java` files in a
 * directory (used for the wildcard package case). Resolution is pure except through
 * `deps`.
 *
 * A specifier may be a TYPE FQN or a PACKAGE FQN, and the dispatch boundary
 * (`makeResolvePathToFile`) does not know which. The two universes do not collide:
 * a type `com.foo.Bar` resolves to a FILE `com/foo/Bar.java`, while a wildcard
 * package `com.foo` resolves to a DIRECTORY `com/foo/` of `.java` files — a normal
 * type never has a `<segments>/` directory of sources and a package never has a
 * `<segments>.java` file. So we try TYPE resolution first (the common case) and
 * fall back to PACKAGE resolution. No out-of-band flag is needed.
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

export function resolveJavaFqn(
  specifier: string,
  fromFile: string,
  deps: JavaResolveDeps,
): string | undefined {
  const segments = specifier.split('.').filter((s) => s.length > 0);
  if (segments.length === 0) return undefined;

  // TYPE FQN → file (com/foo/Bar.java). The dominant case.
  const asType = resolveType(segments, fromFile, deps);
  if (asType !== undefined) return asType;

  // PACKAGE FQN → directory (com/foo/) → representative .java (wildcard import).
  return resolvePackage(segments, fromFile, deps);
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

/** PACKAGE FQN `com.foo` → directory `com/foo/` → a representative `.java` in it. */
function resolvePackage(
  segments: string[],
  fromFile: string,
  deps: JavaResolveDeps,
): string | undefined {
  const pkgDir = segments.join('/'); // com/foo

  for (const dir of ancestorDirs(path.posix.dirname(toPosix(fromFile)))) {
    const repoRelDir = joinUnder(dir, pkgDir);
    const files = deps.javaFilesIn(repoRelDir);
    if (files.length > 0) {
      // Deterministic representative: the lexically-first `.java` in the package.
      return [...files].sort()[0];
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
