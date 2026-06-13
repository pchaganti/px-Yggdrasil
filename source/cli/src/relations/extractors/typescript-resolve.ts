import path from 'node:path';

/**
 * Resolve a TS/JS module specifier to a repo-relative POSIX source file, or undefined.
 *
 * `exists(repoRelPosix)` reports whether a candidate file exists in the resolution universe
 * (disk at --approve time; a fixed known-set in unit tests). PURE except through `exists`.
 *
 * Resolution rules applied in order:
 *   1. Bare specifiers (external packages / Node built-ins) → undefined immediately.
 *   2. For explicit JS-family extensions (.js, .jsx, .mjs, .cjs): try TS-source rewrites first
 *      (.js → .ts, .tsx, then .js, .jsx), then fall through to index-file candidates.
 *   3. For already-TS extensions (.ts, .tsx, .mts, .cts): use the path as-is.
 *   4. For no (or unknown) extension: probe each source extension in order.
 *   5. Directory index fallback: probe <path>/index.<ext> for each source extension.
 *
 * tsconfig `paths` / `baseUrl` aliases are OUT OF SCOPE for v1 — this repo has no `paths`
 * aliases, and only relative specifiers ('./', '../', or absolute '/') are resolved here.
 */
export function resolveTsPath(
  specifier: string,
  fromFile: string,
  exists: (repoRelPosix: string) => boolean,
): string | undefined {
  // Bare specifier → external package or Node built-in; caller should skip these, but be safe.
  if (!specifier.startsWith('.') && !specifier.startsWith('/')) return undefined;

  const baseDir = path.posix.dirname(toPosix(fromFile));
  const joined = path.posix.normalize(path.posix.join(baseDir, specifier));

  for (const cand of candidates(joined)) {
    if (exists(cand)) return cand;
  }
  return undefined;
}

/**
 * Produce the ordered list of candidate paths to probe for a normalised joined path.
 * Literal/rewrite candidates always precede index-file candidates so that a file named
 * `util.ts` beats a directory `util/index.ts`.
 */
function candidates(joined: string): string[] {
  const out: string[] = [];

  const ext = path.posix.extname(joined);

  // Extension rewrite table for JS-family output extensions (NodeNext emits .js for .ts sources).
  const rewrites: Record<string, string[]> = {
    '.js':  ['.ts', '.tsx', '.js', '.jsx'],
    '.jsx': ['.tsx', '.jsx'],
    '.mjs': ['.mts', '.mjs'],
    '.cjs': ['.cts', '.cjs'],
  };

  if (ext in rewrites) {
    // Known JS-family extension: try each TS/JS source rewrite before index fallback.
    const stem = joined.slice(0, -ext.length);
    for (const e of rewrites[ext]) out.push(stem + e);
  } else if (ext === '.ts' || ext === '.tsx' || ext === '.mts' || ext === '.cts') {
    // Already a TS source extension — use as-is.
    out.push(joined);
  } else {
    // No extension (or unrecognised extension): probe each source extension.
    for (const e of ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']) out.push(joined + e);
  }

  // Directory index fallback — always appended after the direct-file candidates.
  for (const e of ['.ts', '.tsx', '.js', '.jsx']) out.push(path.posix.join(joined, 'index' + e));

  return out;
}

function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}
