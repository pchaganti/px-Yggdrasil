import type { Node } from 'web-tree-sitter';
import { walk } from '../../ast/walk.js';
import type { DetectedDep, ParsedFile } from './types.js';

/**
 * Shared include-extraction for C and C++.
 *
 * v1 scope = EXISTENCE, not relation type. C and C++ have no module system; the ONLY
 * parse-time reference that names a concrete in-repo file is a QUOTED preprocessor
 * include (`#include "header.h"`). That is the single edge this layer emits. Everything
 * else a parser sees in these languages — function calls, class inheritance
 * (`base_class_clause`), namespace-qualified references, `using` declarations — is a
 * usage-site or definition-index concern that depends on a symbol/definition index this
 * v1 layer deliberately does NOT build. So `uses()` = quoted preproc includes only, and
 * both grammars route through this one helper (the `preproc_include` node and its `path`
 * field are identical across tree-sitter-c and tree-sitter-cpp — probe-confirmed).
 *
 * Both `.c`/`.h` (C grammar) and `.cpp`/`.hpp`/`.cc`/`.cxx`/`.hh`/`.hxx` (cpp grammar)
 * use the same `#include` syntax, so the extraction is grammar-independent.
 */

/**
 * Read the header path text from a `preproc_include` node, or undefined when this
 * include does NOT name an in-repo candidate file.
 *
 * The `path` field (childForFieldName('path')) is one of:
 *   - `string_literal`   → a QUOTED include `#include "db/foo.h"`. The header path is the
 *                          `string_content` named child text (`db/foo.h`), or equivalently
 *                          `.text` with the surrounding quote chars stripped. This is the
 *                          only form that resolves to a repo file → returned.
 *   - `system_lib_string`→ an ANGLE include `#include <stdio.h>`. System / third-party →
 *                          SKIP (undefined). Never a repo dependency.
 *   - `identifier`/other → a MACRO include `#include HDR` (computed path). Unknowable
 *                          without preprocessing → SKIP (undefined).
 */
function quotedIncludePath(include: Node): string | undefined {
  const pathNode = include.childForFieldName('path');
  if (pathNode === null) return undefined;
  if (pathNode.type !== 'string_literal') return undefined; // angle (<...>) or macro include → not a repo file ref

  // Prefer the inner string_content child (the bare path without the quote delimiters).
  for (let i = 0; i < pathNode.namedChildCount; i++) {
    const child = pathNode.namedChild(i);
    if (child !== null && child.type === 'string_content') return child.text;
  }
  // Fallback: strip the surrounding quote chars from the literal text. An empty `""`
  // yields '' after stripping, which the emitter discards.
  const text = pathNode.text;
  if (text.length < 2) return '';
  return text.slice(1, -1);
}

/**
 * Emit one path hint per QUOTED `#include`. The specifier is the header path text exactly
 * as written in the source (e.g. `../inc/foo.h`, `db/connection.h`); the resolver
 * (`include-resolve.ts`) resolves it relative to the including file's directory, then
 * against a few common include roots. Angle and macro includes are skipped here, so they
 * never reach the resolver and can never become a violation.
 */
export function includeUses(file: ParsedFile): DetectedDep[] {
  const out: DetectedDep[] = [];
  const seen = new Set<string>();

  walk(file.tree.rootNode, (node) => {
    if (node.type !== 'preproc_include') return undefined;
    const headerPath = quotedIncludePath(node);
    if (headerPath === undefined || headerPath === '') return undefined;
    const line = node.startPosition.row + 1;
    const dedupKey = `${headerPath} ${line}`;
    if (seen.has(dedupKey)) return undefined;
    seen.add(dedupKey);
    out.push({ targetHint: { kind: 'path', specifier: headerPath }, kind: 'import', line });
    return undefined;
  });

  return out;
}
