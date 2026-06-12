import type {
  FileWhenPredicate,
  FileBooleanClause,
  FileAtomicClause,
} from '../model/file-when.js';
import { BOOLEAN_KEYS, parsePredicateBoolean } from './predicate-boolean.js';

/**
 * Distinguished error class for when-predicate failures so callers
 * (architecture-parser) can re-raise as `when-predicate-invalid` error code
 * instead of generic `architecture-invalid`.
 */
export class WhenPredicateInvalidError extends Error {
  readonly code = 'when-predicate-invalid' as const;
  constructor(message: string) {
    super(message);
    this.name = 'WhenPredicateInvalidError';
  }
}

const ATOMIC_KEYS = new Set<string>(['path', 'content']);

/**
 * Parse a raw YAML value into a FileWhenPredicate. `ctx` is a human-readable
 * description of where this predicate came from, used in error messages
 * (e.g. "type 'command' when").
 */
export function parseFileWhen(raw: unknown, ctx: string): FileWhenPredicate {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new WhenPredicateInvalidError(`${ctx}: when must be a YAML mapping`);
  }

  const obj = raw as Record<string, unknown>;
  const keys = Object.keys(obj);

  if (keys.length === 0) {
    throw new WhenPredicateInvalidError(`${ctx}: when mapping must not be empty`);
  }

  const booleanKeys = keys.filter((k) => BOOLEAN_KEYS.has(k));
  const atomicKeys = keys.filter((k) => ATOMIC_KEYS.has(k));
  const unknownKeys = keys.filter((k) => !BOOLEAN_KEYS.has(k) && !ATOMIC_KEYS.has(k));

  if (unknownKeys.length > 0) {
    const badKey = unknownKeys[0];
    // Cross-hint: node-family atoms (node, relations, descendants) are valid in
    // aspect when: (which filters NODES) but not here, where the subject is a FILE.
    // The message intentionally includes "unknown when key '<key>'" so that existing
    // callers pattern-matching on that prefix continue to work.
    if (badKey === 'node' || badKey === 'relations' || badKey === 'descendants') {
      throw new WhenPredicateInvalidError(
        `${ctx}: unknown when key '${badKey}' — \`${badKey}\` is a node atom — not valid in scope.files; scope.files filters FILES (path/content atoms). Use when: to filter which NODES the aspect applies to.`,
      );
    }
    throw new WhenPredicateInvalidError(
      `${ctx}: unknown when key '${badKey}' (expected one of: all_of, any_of, not, path, content)`,
    );
  }

  if (booleanKeys.length > 0 && atomicKeys.length > 0) {
    throw new WhenPredicateInvalidError(
      `${ctx}: when cannot mix boolean operators with atomic clauses at the same level`,
    );
  }

  if (booleanKeys.length > 1) {
    throw new WhenPredicateInvalidError(
      `${ctx}: when can have at most one boolean operator at a level (got: ${booleanKeys.join(', ')})`,
    );
  }

  if (booleanKeys.length === 1) {
    return parseBoolean(obj, booleanKeys[0], ctx);
  }

  return parseAtomic(obj, ctx);
}

function parseBoolean(raw: Record<string, unknown>, key: string, ctx: string): FileBooleanClause {
  return parsePredicateBoolean<FileWhenPredicate>(raw, key, ctx, parseFileWhen, WhenPredicateInvalidError) as FileBooleanClause;
}

function parseAtomic(raw: Record<string, unknown>, ctx: string): FileAtomicClause {
  const result: FileAtomicClause = {};

  if ('path' in raw) {
    if (typeof raw.path !== 'string') {
      throw new WhenPredicateInvalidError(`${ctx}: path must be a string (got ${typeof raw.path})`);
    }
    result.path = raw.path;
  }

  if ('content' in raw) {
    if (typeof raw.content !== 'string') {
      throw new WhenPredicateInvalidError(
        `${ctx}: content must be a string (got ${typeof raw.content})`,
      );
    }
    try {
      new RegExp(raw.content);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new WhenPredicateInvalidError(`${ctx}: Invalid regex in content: ${msg}`);
    }
    result.content = raw.content;
  }

  return result;
}
