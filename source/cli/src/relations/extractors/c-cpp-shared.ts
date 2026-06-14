import type { Node } from 'web-tree-sitter';
import { walk } from '../../ast/walk.js';
import type { DetectedDep, ParsedFile } from './types.js';
import { single } from './types.js';

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
 * Is `node` the condition of a preprocessor conditional that is UNCONDITIONALLY dead — the
 * literal `#if 0` / `#elif 0`? A source-only static analyzer cannot evaluate the
 * preprocessor in general, but the literal `0` is always-false with no macro state needed,
 * so its branch is statically-known-dead. The `condition` field of a dead `#if 0` is a
 * single `number_literal` whose text is exactly `0` (probe-confirmed across tree-sitter-c
 * and tree-sitter-cpp; `#if 1`, `#if FOO`, `#if defined(FOO)`, `#ifdef FOO` all carry a
 * different condition shape — `number_literal "1"`, `identifier`, `preproc_defined`, or are
 * a `preproc_ifdef` with no `condition` field at all — and are NOT dead).
 *
 * Exactly `0` only: a non-`0` numeric (`1`), a hex/suffixed/multi-token expression
 * (`0x0`, `0L`, `0 && X`) is conservatively treated as LIVE (NOT dead), so a legitimate
 * conditional include is never dropped — under-emission is the one failure mode the seal
 * must avoid.
 */
function isLiteralZeroCondition(condition: Node | null): boolean {
  return condition !== null && condition.type === 'number_literal' && condition.text === '0';
}

/**
 * Does `include` sit inside the DEAD body of a literal `#if 0` / `#elif 0` branch?
 *
 * Walk the ancestor chain from the include upward. A `preproc_if`/`preproc_elif` whose own
 * `condition` field is the literal `0` is a dead conditional; its dead body are the DIRECT
 * descendants reached WITHOUT passing through its `alternative` field (the `#else` /
 * `#elif` branch). An include reached via the `alternative` belongs to the LIVE branch and
 * is kept — branch precision: only the dead branch's includes are skipped.
 *
 * The walk is child→parent, tracking at each step whether the child we came from IS the
 * parent's `alternative`. When we reach a dead-`0` `preproc_if`/`preproc_elif` having
 * entered it through its BODY (not its `alternative`), the include is dead → true. A nested
 * inner conditional inside a dead outer `#if 0` is still dead (the outer body subsumes it),
 * because the climb continues past the inner node to the dead outer. Reaching the
 * `alternative` of a dead node means we are in its live `#else`/`#elif` subtree; that node
 * does not condemn the include (the live branch may itself contain a deeper `#elif 0`,
 * which the continued climb handles on its own terms).
 */
function isInDeadIfZeroBranch(include: Node): boolean {
  let child: Node = include;
  let parent: Node | null = include.parent;
  while (parent !== null) {
    if (parent.type === 'preproc_if' || parent.type === 'preproc_elif') {
      const alternative = parent.childForFieldName('alternative');
      const enteredViaAlternative = alternative !== null && alternative.id === child.id;
      if (!enteredViaAlternative && isLiteralZeroCondition(parent.childForFieldName('condition'))) {
        return true; // the include is in the dead body of a literal `#if 0` / `#elif 0`
      }
    }
    child = parent;
    parent = parent.parent;
  }
  return false;
}

/**
 * Emit one path hint per QUOTED `#include`. The specifier is the header path text exactly
 * as written in the source (e.g. `../inc/foo.h`, `db/connection.h`); the resolver
 * (`include-resolve.ts`) resolves it relative to the including file's directory only — a
 * header reachable solely through an unseen compiler -I root stays silent rather than
 * resolving to a same-basename decoy. Angle and macro includes are skipped here, so they
 * never reach the resolver and can never become a violation.
 *
 * An include sitting inside the DEAD body of a literal `#if 0` / `#elif 0` branch is SKIPPED
 * (the only preprocessor conditional a hermetic tool can resolve with certainty — `0` is
 * unconditionally false, so that branch is never compiled and has no real dependency).
 * Includes in the `#else`/live-`#elif` branch and in every `#ifdef` / `#if <non-zero>` /
 * `#if defined(...)` / `#if 1` conditional are KEPT — those are legitimate conditional
 * dependencies. This is branch-precise: only the dead branch is dropped, never the live one.
 */
export function includeUses(file: ParsedFile): DetectedDep[] {
  const out: DetectedDep[] = [];
  const seen = new Set<string>();

  walk(file.tree.rootNode, (node) => {
    if (node.type !== 'preproc_include') return undefined;
    if (isInDeadIfZeroBranch(node)) return undefined; // literal `#if 0`/`#elif 0` dead branch → no real dependency
    const headerPath = quotedIncludePath(node);
    if (headerPath === undefined || headerPath === '') return undefined;
    const line = node.startPosition.row + 1;
    const dedupKey = `${headerPath} ${line}`;
    if (seen.has(dedupKey)) return undefined;
    seen.add(dedupKey);
    out.push(single({ kind: 'path', specifier: headerPath }, 'import', line));
    return undefined;
  });

  return out;
}
