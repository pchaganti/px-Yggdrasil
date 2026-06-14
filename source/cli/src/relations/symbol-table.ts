import path from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { atomicWriteFile } from '../io/atomic-write.js';

export class SymbolTable {
  private readonly defs = new Map<string, Set<string>>(); // `${language}\0${symbolKey}` → set of defining files
  private key(language: string, symbolKey: string): string {
    return `${language}\0${symbolKey}`;
  }
  declare(language: string, symbolKey: string, file: string): void {
    const k = this.key(language, symbolKey);
    let s = this.defs.get(k);
    if (!s) { s = new Set(); this.defs.set(k, s); }
    s.add(file);
  }
  /** Exactly one same-language definition → that file; zero or 2+ (ambiguous, incl. off-graph) → undefined. */
  resolveUnique(language: string, symbolKey: string): string | undefined {
    const s = this.defs.get(this.key(language, symbolKey));
    if (!s || s.size !== 1) return undefined;
    return [...s][0];
  }
  /** Number of distinct files declaring `symbolKey` in `language` (0 = absent, ≥2 = ambiguous).
   *  Lets the tri-state resolver tell an ambiguous candidate (≥2) from an absent one (0) —
   *  a distinction `resolveUnique` collapses to undefined. */
  defCount(language: string, symbolKey: string): number {
    return this.defs.get(this.key(language, symbolKey))?.size ?? 0;
  }
  /** True when at least one definition exists (the declared-type guard; ≥1 def). */
  has(language: string, symbolKey: string): boolean {
    return this.defCount(language, symbolKey) > 0;
  }
  /** Every distinct file declaring `symbolKey` in `language` (empty when absent). Unlike
   *  `resolveUnique` it does NOT collapse a multi-def key to undefined — the resolver's
   *  set-level nested-split rule needs the full file set to count distinct files across the
   *  verbatim key plus its guarded `+`-splits (≥2 distinct files anywhere → ambiguous). */
  filesFor(language: string, symbolKey: string): string[] {
    const s = this.defs.get(this.key(language, symbolKey));
    return s ? [...s] : [];
  }
}

/**
 * N-CACHE version token folded into the persisted-index identity. The persisted symbol index
 * is keyed by the file/hash set (`builtFrom`); without a version token, an UNCHANGED C#/Kotlin
 * tree would load the stale cached symbols and a keying change (e.g. the nested-type `+`
 * reflection-FQN keys) would never take effect on upgrade. Bumping this token rejects a cache
 * written by an older extractor and forces a rebuild. Inert on a repo with no symbol index.
 *
 * Bump this whenever the SYMBOL KEYS an unchanged file set produces change.
 *   v1 → v2: nested types keyed `Outer+Inner` (reflection FQN), replacing the bare simple name.
 */
const SYMBOL_INDEX_VERSION = 2;

export interface PersistedSymbolIndex {
  /** Extractor/keying version (N-CACHE). Absent in pre-version indexes → treated as stale. */
  version?: number;
  builtFrom: Array<[string, string]>;
  symbols: Array<[string, string]>;
}

function indexPath(cacheDir: string, language: string): string {
  return path.join(cacheDir, `symbols-${language}.json`);
}

function canonBuiltFrom(b: Array<[string, string]>): string {
  return JSON.stringify([...b].sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0)));
}

export async function writeSymbolIndex(cacheDir: string, language: string, idx: PersistedSymbolIndex): Promise<void> {
  await atomicWriteFile(indexPath(cacheDir, language), JSON.stringify({ ...idx, version: SYMBOL_INDEX_VERSION }));
}

/** Returns the persisted index IFF its version AND builtFrom match exactly; else null (caller
 *  rebuilds). The version check (N-CACHE) makes a keying change take effect on an unchanged tree. */
export function loadSymbolIndex(cacheDir: string, language: string, currentBuiltFrom: Array<[string, string]>): PersistedSymbolIndex | null {
  const p = indexPath(cacheDir, language);
  if (!existsSync(p)) return null;
  let parsed: PersistedSymbolIndex;
  try { parsed = JSON.parse(readFileSync(p, 'utf-8')) as PersistedSymbolIndex; } catch { return null; }
  if (!parsed || !Array.isArray(parsed.builtFrom) || !Array.isArray(parsed.symbols)) return null;
  if (parsed.version !== SYMBOL_INDEX_VERSION) return null; // version mismatch (N-CACHE) → stale → rebuild
  if (canonBuiltFrom(parsed.builtFrom) !== canonBuiltFrom(currentBuiltFrom)) return null; // stale → rebuild
  return parsed;
}
