import type { Node } from 'web-tree-sitter';
import { walk } from '../../ast/walk.js';
import type { DependencyExtractor, DetectedDep, DeclaredSymbol, ParsedFile } from './types.js';
import { single } from './types.js';

/**
 * Rust dependency extractor.
 *
 * v1 scope = EXISTENCE, not relation type. The unit of an inter-component edge in
 * Rust is the `use` IMPORT: a file brings a path from another module into scope with
 * a `use_declaration`. A dependency edge is therefore established ONLY by a `use`
 * declaration. Usage-site nodes (trait impls, supertrait bounds, fully-qualified
 * calls, type references, struct-literal construction) would only REFINE the
 * relation TYPE of an already-importable target, and v1 does not enforce relation
 * type — so this extractor performs NO usage-site refinement. It emits one path
 * hint per imported path whose specifier is the crate-relative `::`-joined path
 * (e.g. `crate::orders::Order`, `super::util::X`, `self::y`). The resolver
 * (`rust-resolve.ts`) maps that path → a `.rs` file through the crate module tree.
 *
 * GROUPED imports: for `use a::b::{C, D}` this emits the common module prefix
 * (`a::b`) ONCE rather than each leaf (`a::b::C`, `a::b::D`). For existence both
 * leaves resolve to the same file/node as the prefix module (C and D are items
 * inside module a::b, or are submodules under it), so the prefix alone establishes
 * the edge — and it is unambiguous (a leaf may be either a submodule or an item,
 * the prefix is always a module). A `self` item means the prefix module itself,
 * which the prefix already covers. A nested `scoped_use_list`
 * (`use a::{b::{C}}`) recurses, emitting the deeper common prefix.
 *
 * GLOB (`use a::b::*`) emits the prefix module `a::b`. RENAMED (`use a::b as c`)
 * strips the alias and emits the real path `a::b`. `pub use` (re-export) is
 * structurally a plain `use` carrying a `visibility_modifier`; the edge is
 * identical, so it is emitted the same way (keyed off the `argument` field, never
 * a child index, so the leading `pub` token does not shift anything).
 *
 * MACROS are invisible: a path appearing inside a `macro_invocation` token_tree is
 * unparsed tokens, never a `use_declaration`, so macro-generated deps are never
 * emitted. EXTERNAL crates (std, serde, …) emit a path hint too, but the resolver
 * returns undefined for any path whose root is not `crate`/`super`/`self` (and not
 * the current crate's own name) — so they never become a violation.
 */

/**
 * Render a path-prefix node (`scoped_identifier` | `crate` | `super` | `self` |
 * `identifier`) as a `::`-joined specifier by walking the left-recursive `path`
 * chain down to the leftmost leaf and joining the segment texts in source order.
 *
 * `scoped_identifier` nests via field `path` (the prefix) and field `name` (the
 * final segment). The leftmost leaf is a `crate` / `super` / `self` / `identifier`
 * keyword-or-name node; its `.text` is the first segment. Returns undefined when
 * the structure is unexpected (malformed / error nodes) — silence over a guess.
 */
function pathText(node: Node): string | undefined {
  const segments: string[] = [];
  let cur: Node | null = node;
  // Descend the `path` chain, collecting the `name` segment at each scoped level.
  while (cur !== null && cur.type === 'scoped_identifier') {
    const nameNode = cur.childForFieldName('name');
    if (nameNode === null) return undefined;
    segments.unshift(nameNode.text);
    cur = cur.childForFieldName('path');
  }
  // `cur` is now the leftmost leaf: crate | super | self | identifier (or null when
  // a scoped_identifier had no `path` field, which the grammar does not produce).
  if (cur === null) return undefined;
  if (
    cur.type === 'crate' ||
    cur.type === 'super' ||
    cur.type === 'self' ||
    cur.type === 'identifier'
  ) {
    segments.unshift(cur.text);
  } else {
    return undefined;
  }
  return segments.length > 0 ? segments.join('::') : undefined;
}

/** The prefix node of a `scoped_use_list` / `use_wildcard`: the path before the
 *  `{ … }` list or the `*`. It is a named child that is one of the path-shaped
 *  node types; the trailing `use_list` is excluded. Returns undefined when absent. */
function prefixNode(parent: Node): Node | null {
  for (let i = 0; i < parent.namedChildCount; i++) {
    const c = parent.namedChild(i);
    if (c === null) continue;
    if (
      c.type === 'scoped_identifier' ||
      c.type === 'crate' ||
      c.type === 'super' ||
      c.type === 'self' ||
      c.type === 'identifier'
    ) {
      return c;
    }
  }
  return null;
}

function uses(file: ParsedFile): DetectedDep[] {
  const out: DetectedDep[] = [];
  const seen = new Set<string>();

  const emit = (specifier: string | undefined, node: Node): void => {
    if (specifier === undefined || specifier === '') return;
    const line = node.startPosition.row + 1;
    const dedupKey = `${specifier} ${line}`;
    if (seen.has(dedupKey)) return;
    seen.add(dedupKey);
    out.push(single({ kind: 'path', specifier }, 'import', line));
  };

  // Resolve one `use` argument node (or a list item) to its specifier and emit.
  // `prefix` is the `::`-joined module prefix accumulated from enclosing
  // scoped_use_lists (empty at the top level). Recurses into nested groups.
  const handleArgument = (arg: Node, prefix: string): void => {
    switch (arg.type) {
      case 'scoped_identifier': {
        const tail = pathText(arg);
        if (tail !== undefined) emit(join(prefix, tail), arg);
        return;
      }
      case 'identifier':
      case 'crate':
      case 'super':
      case 'self': {
        emit(join(prefix, arg.text), arg);
        return;
      }
      case 'use_as_clause': {
        // Resolve via the `path` field only; the `alias` is a local binding.
        const p = arg.childForFieldName('path');
        if (p !== null) handleArgument(p, prefix);
        return;
      }
      case 'use_wildcard': {
        // `prefix::*` — emit the prefix module. The wildcard's child is the prefix path.
        const pre = prefixNode(arg);
        if (pre === null) {
          // bare `use *;` is not valid Rust; nothing to emit.
          return;
        }
        const tail = pre.type === 'scoped_identifier' ? pathText(pre) : pre.text;
        if (tail !== undefined) emit(join(prefix, tail), arg);
        return;
      }
      case 'scoped_use_list': {
        // `prefix::{ items }` — extend the prefix with this group's path, then emit
        // the COMMON module prefix once (existence: every item resolves to the same
        // file/node as the prefix module). The leaf items are not individually emitted.
        const pre = prefixNode(arg);
        const groupPrefix =
          pre === null
            ? prefix
            : join(prefix, pre.type === 'scoped_identifier' ? pathText(pre) : pre.text);
        if (groupPrefix !== undefined && groupPrefix !== '') {
          emit(groupPrefix, arg);
        } else {
          // No usable common prefix (e.g. `use {a, b};` — rare, non-idiomatic):
          // fall back to emitting each item path so the edge is not silently lost.
          const list = arg.childForFieldName('list');
          if (list !== null) {
            for (let i = 0; i < list.namedChildCount; i++) {
              const item = list.namedChild(i);
              if (item !== null) handleArgument(item, '');
            }
          }
        }
        return;
      }
      default:
        return;
    }
  };

  walk(file.tree.rootNode, (node) => {
    if (node.type === 'use_declaration') {
      const arg = node.childForFieldName('argument');
      if (arg !== null) handleArgument(arg, '');
      return false; // do not descend into the use tree again
    }
    return undefined;
  });

  return out;
}

/** Join a `::`-module prefix with a tail. Empty prefix → the tail itself; undefined
 *  tail → undefined (propagates a resolution failure rather than guessing). */
function join(prefix: string, tail: string | undefined): string | undefined {
  if (tail === undefined) return undefined;
  if (prefix === '') return tail;
  return `${prefix}::${tail}`;
}

/**
 * Top-level declarations — a thin parity layer (Rust resolves dependencies by PATH
 * through the crate module tree, not by a symbol index, so a Rust SymbolTable is not
 * load-bearing). Emits the names of top-level item declarations:
 *   - `struct_item` / `enum_item` / `trait_item` / `function_item` / `mod_item`
 *     (each carries field `name`).
 * Only top-level items (direct children of the file root) are emitted — items nested
 * inside an inline `mod { … }` are same-file detail, not the node's public surface.
 */
function declarations(file: ParsedFile): DeclaredSymbol[] {
  const out: DeclaredSymbol[] = [];
  const root = file.tree.rootNode;
  for (let i = 0; i < root.namedChildCount; i++) {
    const node = root.namedChild(i);
    if (node === null) continue;
    if (
      node.type === 'struct_item' ||
      node.type === 'enum_item' ||
      node.type === 'trait_item' ||
      node.type === 'function_item' ||
      node.type === 'mod_item'
    ) {
      const nameNode = node.childForFieldName('name');
      if (nameNode !== null) {
        out.push({ symbolKey: nameNode.text, line: node.startPosition.row + 1 });
      }
    }
  }
  return out;
}

export const rustExtractor: DependencyExtractor = {
  languages: new Set(['rust']),
  declarations,
  uses,
};
