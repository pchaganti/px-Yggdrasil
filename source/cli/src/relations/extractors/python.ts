import type { Node } from 'web-tree-sitter';
import { walk } from '../../ast/walk.js';
import type { DependencyExtractor, DetectedDep, DeclaredSymbol, ParsedFile } from './types.js';
import { single } from './types.js';

/**
 * Python dependency extractor.
 *
 * v1 scope = EXISTENCE, not relation type. A dependency edge is established ONLY
 * by an import statement: a plain `import a.b.c` (`import_statement`) or a
 * `from M import x` (`import_from_statement`). Usage-site nodes (class bases,
 * decorators, attribute/bare-name calls) would only REFINE the relation type of
 * an already-imported binding, and v1 does not enforce relation type — so this
 * extractor performs NO usage-site refinement. It emits path hints whose
 * specifier is a Python MODULE PATH; the resolver maps module-path → file.
 *
 * The specifier is one of:
 *   - an absolute dotted module path: `foo.bar` (no leading dot)
 *   - a relative module path: leading run of dots then optional dotted tail,
 *     e.g. `.`, `..`, `.sib`, `..pkg.mod` (the resolver climbs dots then appends).
 *
 * `from __future__ import ...` parses as a distinct `future_import_statement`
 * node type (never `import_from_statement`), so the `__future__` pseudo-module is
 * skipped by construction. `from pkg import *` (`wildcard_import`) emits ONE hint
 * for `pkg` — the star-exported symbols are not enumerable statically.
 */

/** Read the dotted module text from a `dotted_name` node (e.g. "foo.bar"). */
function dottedText(node: Node): string {
  return node.text;
}

/** For an `aliased_import`, the real module is its `name` field (a dotted_name);
 *  the `alias` field is only the local binding and is NOT the dependency. */
function moduleOfAliasedImport(aliased: Node): string | undefined {
  const nameField = aliased.childForFieldName('name');
  if (nameField === null || nameField.type !== 'dotted_name') return undefined;
  return dottedText(nameField);
}

/** Collect the imported simple names from an import_from_statement's field-`name`
 *  children (each a `dotted_name` or `aliased_import` whose `name` is the symbol). */
function importedNames(fromStatement: Node): string[] {
  const out: string[] = [];
  for (let i = 0; i < fromStatement.namedChildCount; i++) {
    const child = fromStatement.namedChild(i);
    if (child === null) continue;
    // Skip the module_name field child (handled separately) and wildcard.
    if (child.type === 'dotted_name') {
      // A field-`name` dotted_name is the imported symbol. The module_name is a
      // dotted_name too, so distinguish by field name.
      if (fromStatement.childForFieldName('module_name')?.id === child.id) continue;
      out.push(child.text);
    } else if (child.type === 'aliased_import') {
      const nameField = child.childForFieldName('name');
      if (nameField !== null && nameField.type === 'dotted_name') out.push(nameField.text);
    }
  }
  return out;
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

  walk(file.tree.rootNode, (node) => {
    switch (node.type) {
      case 'import_statement': {
        // `import a.b.c`, `import x as y`, `import a, b.c` — iterate every
        // field-`name` child (a dotted_name or an aliased_import).
        for (let i = 0; i < node.namedChildCount; i++) {
          const child = node.namedChild(i);
          if (child === null) continue;
          if (child.type === 'dotted_name') {
            emit(dottedText(child), node);
          } else if (child.type === 'aliased_import') {
            emit(moduleOfAliasedImport(child), node);
          }
        }
        break;
      }
      case 'import_from_statement': {
        const moduleName = node.childForFieldName('module_name');
        if (moduleName === null) break;

        if (moduleName.type === 'dotted_name') {
          // Absolute `from foo.bar import baz, qux`. Primary edge = the module
          // itself; also offer `<module>.<symbol>` candidates for the case where
          // an imported name is itself a submodule (`from pkg import sub`). The
          // resolver prefers the longest path that hits a real mapped file.
          const base = dottedText(moduleName);
          emit(base, node);
          for (const sym of importedNames(node)) emit(`${base}.${sym}`, node);
        } else if (moduleName.type === 'relative_import') {
          // Relative `from . import sib` / `from ..pkg.mod import y`. The
          // relative_import's text is the leading dots plus any dotted tail
          // (`.`, `..`, `.sib`, `..pkg.mod`). When there is NO dotted tail (bare
          // dots), the imported names ARE the tail — emit `<dots><symbol>` so the
          // resolver climbs then appends. When there IS a tail, emit it (and the
          // `<tail>.<symbol>` submodule candidate).
          const rel = moduleName.text; // e.g. "." | ".." | ".sib" | "..pkg.mod"
          const dotsOnly = /^\.+$/.test(rel);
          if (dotsOnly) {
            for (const sym of importedNames(node)) emit(`${rel}${sym}`, node);
            // Also emit the bare-dots package itself (covers `from . import *`
            // and lets the resolver fall back to the package's __init__).
            emit(rel, node);
          } else {
            emit(rel, node);
            for (const sym of importedNames(node)) emit(`${rel}.${sym}`, node);
          }
        }
        break;
      }
      default:
        break;
    }
    return undefined;
  });

  return out;
}

const TOP_LEVEL_DECLARATION_TYPES = new Set(['class_definition', 'function_definition']);

/** True when the declaration sits at module top level — directly under `module`,
 *  or wrapped in a `decorated_definition` that is itself directly under `module`. */
function isTopLevel(node: Node): boolean {
  const parent = node.parent;
  if (parent === null) return false;
  if (parent.type === 'module') return true;
  if (parent.type === 'decorated_definition') {
    const grandparent = parent.parent;
    return grandparent !== null && grandparent.type === 'module';
  }
  return false;
}

function declarations(file: ParsedFile): DeclaredSymbol[] {
  const out: DeclaredSymbol[] = [];
  walk(file.tree.rootNode, (node) => {
    if (!TOP_LEVEL_DECLARATION_TYPES.has(node.type)) return undefined;
    if (!isTopLevel(node)) return undefined;
    const nameNode = node.childForFieldName('name');
    if (nameNode === null) return undefined;
    out.push({ symbolKey: nameNode.text, line: node.startPosition.row + 1 });
    return undefined;
  });
  return out;
}

export const pythonExtractor: DependencyExtractor = {
  languages: new Set(['python']),
  declarations,
  uses,
};
