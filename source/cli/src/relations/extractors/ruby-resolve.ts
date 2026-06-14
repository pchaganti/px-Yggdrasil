import path from 'node:path';

/**
 * Resolve a Ruby `require_relative` literal path to a repo-relative POSIX source file,
 * or undefined. Ruby's ONLY file-precise static link.
 *
 * The specifier is the bare string literal as written in the source
 * (`'../services/order_service'`, `'./helper'`, `'sibling'`). `require_relative`
 * always resolves RELATIVE TO THE DIRECTORY of the requiring file (never the load
 * path), so we join the literal onto `dirname(fromFile)`, append `.rb` if the literal
 * has no extension, and POSIX-normalize `..`/`.`. A candidate that escapes the repo
 * root, or that does not exist, yields undefined.
 *
 * `exists(repoRelPosix)` reports whether a candidate file exists in the resolution
 * universe (disk at --approve time; a fixed known-set in unit tests). PURE except
 * through `exists`. No directory listing, no graph access — the owner index downstream
 * maps the resolved file to a node; an unmapped resolved file is simply not a known
 * target (a coverage matter, never a violation).
 *
 * RESOLUTION MISS → undefined. This fail-to-silence is the false-positive guard: a
 * `require` of a gem (handled by the extractor, which only emits `require_relative`),
 * a mis-typed path, or a file not present resolves to nothing and is never flagged.
 *
 * NOTE: Ruby's constant references (superclass, mixin, qualified call, bare constant)
 * carry NO path — they resolve through the shared SymbolTable, never here. Only the
 * `require_relative` PATH hint reaches this resolver.
 */
export function resolveRubyRequireRelative(
  specifier: string,
  fromFile: string,
  exists: (repoRelPosix: string) => boolean,
): string | undefined {
  if (specifier === '') return undefined;

  const fromDir = path.posix.dirname(toPosix(fromFile));
  // Ruby require_relative appends `.rb` automatically; honor an explicit `.rb` too.
  const withExt = /\.rb$/.test(specifier) ? specifier : `${specifier}.rb`;

  const joined = path.posix.join(fromDir, withExt);
  const normalized = path.posix.normalize(joined);
  if (normalized.startsWith('..')) return undefined; // escaped the repo root → miss

  return exists(normalized) ? normalized : undefined;
}

function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}
