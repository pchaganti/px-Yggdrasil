import path from 'node:path';

/**
 * Resolve a PHP class FQN to a repo-relative POSIX `.php` source file, or undefined.
 *
 * The specifier is what the extractor emits: a PHP fully-qualified class name with `\`
 * separators and no leading backslash (`App\Payment\Gateway`).
 *
 * PHP maps a class FQN to a file through composer's PSR-4 autoloading. `composer.json`
 * declares `autoload.psr-4` (and `autoload-dev.psr-4`) — a map of namespace PREFIX to a
 * base DIRECTORY, e.g. `{ "App\\": "src/", "App\\Tests\\": "tests/" }`. For an FQN:
 *   - find the LONGEST psr-4 prefix that the FQN starts with (a prefix is a namespace
 *     boundary, ending in `\`);
 *   - the remainder after the prefix maps to `<baseDir>/<remainder-with-\→/>.php`;
 *   - check that file exists.
 * A PSR-4 prefix value may be an ARRAY of directories (one prefix → several roots) —
 * each candidate directory is tried in turn.
 *
 * Longest-prefix matters because prefixes nest: with `App\` → `src/` and `App\Tests\` →
 * `tests/`, the FQN `App\Tests\UnitTest` must map under `tests/`, not `src/Tests/`.
 *
 * RESOLUTION MISS → undefined. This fail-to-silence is the false-positive guard: a
 * vendor / third-party class (its namespace is not in the project's psr-4 map), a
 * project that uses classmap / files autoload instead of psr-4 (no matching prefix), a
 * missing or unreadable composer.json, or an FQN whose file is simply not present all
 * resolve to nothing and are never flagged. We never GUESS a root.
 */
export interface PhpResolveDeps {
  /**
   * The PSR-4 map in effect for `fromFile`: namespace prefix (ending in `\`) → one or
   * more base directories (repo-relative POSIX, no trailing slash; '' = repo root).
   * Read from the nearest ancestor composer.json. Empty map when none is found /
   * readable. Implementations SHOULD cache this — it is stable per composer.json root.
   */
  psr4For(fromFile: string): ReadonlyMap<string, readonly string[]>;
  /** Does a file exist at this repo-relative POSIX path? */
  exists(repoRelPosix: string): boolean;
}

export function resolvePhpFqn(
  specifier: string,
  fromFile: string,
  deps: PhpResolveDeps,
): string | undefined {
  const fqn = specifier.startsWith('\\') ? specifier.slice(1) : specifier;
  if (fqn === '') return undefined;

  const psr4 = deps.psr4For(fromFile);
  if (psr4.size === 0) return undefined;

  // Longest matching PSR-4 prefix wins. A prefix ends in `\`, so an FQN matches a
  // prefix P when `(fqn + '\\').startsWith(P)` — this both lets a bare prefix match
  // its own namespace and forbids `Apple\X` from matching the `App\` prefix.
  const fqnWithSep = fqn + '\\';
  let bestPrefix: string | undefined;
  for (const prefix of psr4.keys()) {
    if (!fqnWithSep.startsWith(prefix)) continue;
    if (bestPrefix === undefined || prefix.length > bestPrefix.length) bestPrefix = prefix;
  }
  if (bestPrefix === undefined) return undefined;

  const remainder = fqn.slice(bestPrefix.length); // segments after the prefix (no leading \)
  const relParts = remainder.split('\\').filter((s) => s.length > 0);
  const subPath = relParts.join('/') + '.php';

  const baseDirs = psr4.get(bestPrefix) ?? [];
  for (const baseDir of baseDirs) {
    const candidate = joinUnder(baseDir, subPath);
    if (deps.exists(candidate)) return candidate;
  }
  return undefined;
}

/** Join a repo-relative directory with a sub-path, normalizing. '' → the sub-path itself. */
function joinUnder(dir: string, sub: string): string {
  return path.posix.normalize(dir === '' ? sub : path.posix.join(dir, sub));
}

/**
 * Parse a composer.json's `autoload.psr-4` and `autoload-dev.psr-4` into the normalized
 * prefix → directories map, with directories made relative to `composerDir` (repo-rel
 * POSIX, '' = repo root). Exported for the disk-backed deps factory and for testing.
 *
 * A prefix is kept verbatim (it ends in `\` per PSR-4 convention). A directory value is
 * a single string or an array of strings; each is normalized (trailing slash dropped,
 * `.`/`''` → the composerDir itself). Malformed entries are skipped. autoload-dev keys
 * supplement the main map (a key present in both takes the union of directories).
 */
export function parsePsr4(
  composerJsonText: string,
  composerDir: string,
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(composerJsonText);
  } catch {
    return out;
  }
  if (parsed === null || typeof parsed !== 'object') return out;

  const addSection = (section: unknown): void => {
    if (section === null || typeof section !== 'object') return;
    for (const [prefix, value] of Object.entries(section as Record<string, unknown>)) {
      if (prefix === '') continue; // PSR-4 forbids an empty prefix; skip defensively.
      const dirs = Array.isArray(value) ? value : [value];
      for (const d of dirs) {
        if (typeof d !== 'string') continue;
        const rel = normalizeDir(d, composerDir);
        const existing = out.get(prefix);
        if (existing === undefined) out.set(prefix, [rel]);
        else if (!existing.includes(rel)) existing.push(rel);
      }
    }
  };

  const autoload = (parsed as Record<string, unknown>).autoload;
  const autoloadDev = (parsed as Record<string, unknown>)['autoload-dev'];
  if (autoload !== null && typeof autoload === 'object') {
    addSection((autoload as Record<string, unknown>)['psr-4']);
  }
  if (autoloadDev !== null && typeof autoloadDev === 'object') {
    addSection((autoloadDev as Record<string, unknown>)['psr-4']);
  }
  return out;
}

/** A composer.json directory value → repo-relative POSIX dir (no trailing slash).
 *  `composerDir` is where the composer.json lives ('' = repo root); the value is relative
 *  to it. `''`, `.`, `./` all denote composerDir itself. */
function normalizeDir(value: string, composerDir: string): string {
  const trimmed = value.replace(/\/+$/, ''); // drop trailing slashes
  if (trimmed === '' || trimmed === '.') return composerDir;
  const joined = composerDir === '' ? trimmed : path.posix.join(composerDir, trimmed);
  const norm = path.posix.normalize(joined);
  return norm === '.' ? '' : norm;
}
