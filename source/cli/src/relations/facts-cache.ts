import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { atomicWriteFile } from '../io/atomic-write.js';
import type { DeclaredSymbol, DetectedDep } from './extractors/types.js';

/** Cache schema version. Bump whenever the on-disk shard format changes. */
export const CACHE_SCHEMA_VERSION = 1;

/**
 * Forward declaration for the C# extract type defined in a later task.
 * Declared as `unknown` here to avoid a circular dependency; callers that
 * need the full type should import `CsharpExtract` from its own module once
 * it exists.
 */
export type CsharpExtract = unknown;

/** Extracted facts for one source file (declarations + detected dependencies). */
export interface FileFacts {
  declarations: DeclaredSymbol[];
  uses: DetectedDep[];
  /** C#-specific extract (optional; full type defined in a later task). */
  csharp?: CsharpExtract;
}

/** Returns the root of the AST cache directory tree for a given graph root. */
export function astCacheDir(graphRoot: string): string {
  return path.join(graphRoot, '.ast-cache');
}

/**
 * Returns the shard filename stem (the cache key) for a given set of
 * content-addressing inputs. Different inputs always produce different keys
 * so no two distinct `(contentHash, language, grammarHash, rev)` tuples can
 * collide inside the same shard directory.
 */
export function factsKey(args: {
  contentHash: string;
  language: string;
  grammarHash: string;
  rev: number;
}): string {
  const payload = `${args.contentHash}\0${args.language}\0${args.grammarHash}\0${args.rev}`;
  return createHash('sha256').update(payload).digest('hex').slice(0, 16);
}

/** Shard path for a given cache root, language, and key. */
function shardPath(dir: string, language: string, key: string): string {
  return path.join(dir, `v${CACHE_SCHEMA_VERSION}`, language, `${key}.json`);
}

/**
 * Shard body stored on disk. Includes cache-identity fields so `loadFacts`
 * can perform a defensive identity assertion even without re-hashing inputs.
 */
interface ShardBody {
  /** Cache schema version — validated FIRST on load (fail-closed). */
  v: number;
  /** The shard key (matches the filename stem) — defensive identity assertion. */
  key: string;
  declarations: DeclaredSymbol[];
  uses: DetectedDep[];
  csharp?: CsharpExtract;
}

/**
 * Load cached facts for a given language + key.
 *
 * Returns `null` on ANY of:
 *   - shard file absent
 *   - JSON parse error
 *   - `v` field absent or !== CACHE_SCHEMA_VERSION (checked FIRST)
 *   - missing/malformed required fields (`key`, `declarations`, `uses`)
 *   - inner `key` field does not match the requested `key` (identity mismatch)
 *
 * NEVER returns `{ declarations: [], uses: [] }` to paper over a corrupt shard —
 * that would let a caller read "no dependencies" from a broken entry and cause
 * the verification gate to go falsely green.
 */
export async function loadFacts(
  dir: string,
  language: string,
  key: string,
): Promise<FileFacts | null> {
  const p = shardPath(dir, language, key);
  if (!existsSync(p)) return null;

  let parsed: ShardBody;
  try {
    parsed = JSON.parse(readFileSync(p, 'utf-8')) as ShardBody;
  } catch {
    return null;
  }

  // Validate schema version FIRST — if this doesn't match we can't trust anything else.
  if (!parsed || typeof parsed !== 'object' || parsed.v !== CACHE_SCHEMA_VERSION) return null;

  // Validate required fields.
  if (typeof parsed.key !== 'string') return null;
  if (!Array.isArray(parsed.declarations)) return null;
  if (!Array.isArray(parsed.uses)) return null;

  // Defensive identity assertion — stored key must match the requested key.
  if (parsed.key !== key) return null;

  // Return only the FileFacts fields (strip internal shard metadata).
  const facts: FileFacts = {
    declarations: parsed.declarations,
    uses: parsed.uses,
  };
  if (parsed.csharp !== undefined) {
    facts.csharp = parsed.csharp;
  }
  return facts;
}

/**
 * Write facts to the shard cache.
 *
 * Create-only: skips entirely if the shard already exists — a content-addressed
 * shard is by construction identical, so re-writing is wasted IO.
 *
 * Otherwise writes atomically via `atomicWriteFile` (temp + rename, mkdir -p).
 */
export async function writeFacts(
  dir: string,
  language: string,
  key: string,
  facts: FileFacts,
): Promise<void> {
  const p = shardPath(dir, language, key);
  if (existsSync(p)) return; // create-only — shard is content-addressed, already identical

  const body: ShardBody = {
    v: CACHE_SCHEMA_VERSION,
    key,
    declarations: facts.declarations,
    uses: facts.uses,
    ...(facts.csharp !== undefined ? { csharp: facts.csharp } : {}),
  };
  await atomicWriteFile(p, JSON.stringify(body));
}
