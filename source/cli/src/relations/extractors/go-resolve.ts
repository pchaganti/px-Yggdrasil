import path from 'node:path';

/**
 * Resolve a Go import PATH to a repo-relative POSIX `.go` source file, or undefined.
 *
 * A Go import path (`example.com/mod/foo/bar`) names a package DIRECTORY, not a
 * single file. Mapping it to a graph node requires:
 *   (a) the module path from `go.mod` at the module root;
 *   (b) stripping that module prefix from the import path to get the repo-relative
 *       package DIRECTORY;
 *   (c) finding a representative `.go` file in that directory on disk;
 *   (d) handing that file to the owner index downstream.
 *
 * An import path that does NOT start with the module path (a stdlib package like
 * `fmt`/`os`, or an external module) resolves to NO mapped file → undefined. This
 * fail-to-silence is the single most important false-positive guard: only imports
 * under the repo's own module are graph-resolvable; everything else is silent.
 *
 * Dot-imports (`. "pkg"`) and blank imports (`_ "pkg"`) still name a real package
 * path, so the extractor emits the path normally and this resolver treats it like
 * any other — the local-binding form is irrelevant here.
 *
 * Resolution is pure except through `deps`, which provides disk access derived
 * from the project root. The module path is read from go.mod once and cached by
 * the caller (`makeGoResolver`).
 */
export interface GoResolveDeps {
  /**
   * The module path declared by the nearest `go.mod` for `fromFile` (the `module
   * <path>` line), or undefined when no go.mod is found / readable. Implementations
   * SHOULD cache this — it is stable for a given module root.
   */
  modulePathFor(fromFile: string): string | undefined;
  /** Does a directory exist at this repo-relative POSIX path? */
  dirExists(repoRelDir: string): boolean;
  /** Repo-relative POSIX paths of `.go` files directly in this directory (no recursion). */
  goFilesIn(repoRelDir: string): string[];
  /**
   * Optional. Repo-relative POSIX file → owning node id, or undefined when no
   * node maps it. When supplied, resolveGoImport becomes OWNER-SET-AWARE: it
   * computes the owner of every production `.go` file in the package directory;
   * all-one-owner attributes that owner's representative file, 2+ distinct
   * owners silences the import entirely (F20 at package granularity — a split
   * package has no single graph owner, so attributing it to any one file's
   * owner would fabricate or hide a cross-node edge). Absent → today's
   * lexicographically-first pick, no owner check.
   */
  ownerOf?(repoRelPosix: string): string | undefined;
}

export function resolveGoImport(
  importPath: string,
  fromFile: string,
  deps: GoResolveDeps,
): string | undefined {
  const modulePath = deps.modulePathFor(fromFile);
  if (modulePath === undefined || modulePath === '') return undefined;

  // The import path must be the module path itself (module root package) or a
  // descendant of it (`<modulePath>/<dir>`). Anything else is stdlib/external → silence.
  let dir: string;
  if (importPath === modulePath) {
    dir = ''; // module root directory
  } else if (importPath.startsWith(modulePath + '/')) {
    dir = importPath.slice(modulePath.length + 1);
  } else {
    return undefined;
  }

  // Normalize to a repo-relative POSIX directory (defensive against stray slashes).
  const repoRelDir = path.posix.normalize(dir === '' ? '.' : dir);
  const cleanDir = repoRelDir === '.' ? '' : repoRelDir;

  if (!deps.dirExists(cleanDir)) return undefined;

  // Representative `.go` file in the package directory. Test files (`*_test.go`)
  // are excluded so the representative is a production source file; a directory
  // with ONLY test files falls back to one of those rather than missing a real
  // package.
  const goFiles = deps.goFilesIn(cleanDir);
  if (goFiles.length === 0) return undefined;
  const production = goFiles.filter((f) => !f.endsWith('_test.go'));
  const candidates = (production.length > 0 ? production : goFiles).sort();

  // Owner-set guard (F20, package granularity). When an owner authority is
  // supplied, the package's files may belong to DIFFERENT graph nodes (a parent
  // and child carving one directory, or two siblings). A single representative
  // file cannot stand in for a split package — attributing the import to its
  // owner would fabricate or hide a cross-node edge. So: collect the distinct
  // owners over the candidates; exactly one owner → return that owner's first
  // file; 2+ distinct owners → silence (undefined). Files no node maps do not
  // contribute an owner (a wholly-unmapped package falls through to the D7
  // unmapped-target silence downstream, unchanged).
  if (deps.ownerOf) {
    const ownerOf = deps.ownerOf;
    let sole: string | undefined; // the single distinct owner seen so far
    for (const f of candidates) {
      const o = ownerOf(f);
      if (o === undefined) continue; // unmapped file → no owner contribution
      if (sole === undefined) {
        sole = o;
      } else if (o !== sole) {
        return undefined; // 2+ distinct owners → split package → silence
      }
    }
    // Return the first candidate owned by the sole owner (or the first candidate
    // when none are mapped — downstream ownerOf yields undefined → D7 silence).
    if (sole !== undefined) {
      const owned = candidates.find((f) => ownerOf(f) === sole);
      if (owned !== undefined) return owned;
    }
  }

  return candidates[0];
}
