import type { Node } from 'web-tree-sitter';
import { walk } from '../../ast/walk.js';
import type { DependencyExtractor, DetectedDep, DeclaredSymbol, ParsedFile } from './types.js';
import { single } from './types.js';

/**
 * Kotlin dependency extractor — the FIRST language that resolves through the shared
 * SymbolTable rather than a path mapping.
 *
 * WHY A SYMBOL TABLE (not path arithmetic): Kotlin decouples a file's `package`
 * declaration from its directory (unlike Java's enforced package = directory layout),
 * and `.kts` scripts may have no package at all. So a file's FULLY-QUALIFIED names
 * cannot be derived from its path — they must be read from the parsed `package_header`
 * plus each declaration's simple name. `declarations()` therefore emits the FQNs this
 * file DEFINES (`<package>.<Name>`), which the pass folds into ONE shared SymbolTable;
 * `uses()` emits SYMBOL hints (the imported FQN) that resolve through that table via
 * `resolveUnique`. There is NO `resolve-path.ts` branch for Kotlin — symbol hints never
 * touch `resolvePathToFile`.
 *
 * v1 scope = EXISTENCE, not relation type. The unit of an inter-component edge in
 * Kotlin is the IMPORT: an `import` statement names a fully-qualified symbol (or, for a
 * wildcard import, a package). Usage-site nodes — `:` supertype lists, `by` delegation,
 * qualified calls, type references, `::` callable references — would only REFINE the
 * relation type of an already-imported binding, and v1 does not enforce relation type.
 * This extractor performs NO usage-site refinement: it emits exactly one symbol hint
 * per import.
 *
 * D6 PROBE (empirically confirmed against the shipped tree-sitter-grammars wasm):
 *  - The import node is `import` (a NAMED node), NOT `import_header`. Its FQN is the
 *    child `qualified_identifier` whose `.text` is the dotted path.
 *  - A wildcard `import com.foo.*` parses with the `qualified_identifier` ALREADY equal
 *    to the package (`com.foo`); the `*` is a separate unnamed token. So the FQN text is
 *    the package as-is. v1 emits the package FQN as the symbol hint (documented below).
 *  - An aliased `import com.foo.Bar as B` keeps the `qualified_identifier` as the real
 *    FQN (`com.foo.Bar`); the alias is a trailing `identifier` child. The alias is
 *    IGNORED — the hint is the FQN.
 *  - `package_header` has a `qualified_identifier` child (NO `name` field); its `.text`
 *    is the package FQN, possibly absent (root package).
 *  - `class_declaration` (which ALSO covers `interface`!), `object_declaration`, and
 *    `function_declaration` carry a `name` field (an `identifier`). `property_declaration`
 *    and `type_alias` do NOT: a property's name sits under a `variable_declaration`
 *    child's `identifier`; a type alias's name is a direct `identifier` child.
 *
 * WILDCARD HANDLING (documented v1 decision): `import com.foo.*` emits the PACKAGE FQN
 * (`com.foo`) as the symbol hint. A file's `declarations()` emits per-type FQNs
 * (`com.foo.Bar`), never the bare package, so a wildcard hint resolves through the
 * SymbolTable ONLY if some file happens to `declare` the package string itself — which
 * never happens in v1. In practice a wildcard import therefore resolves to undefined
 * (silence), i.e. v1 treats star imports as non-edges. This is the safe direction
 * (under-detect, never over-flag) and is consistent with the resolution-miss = non-event
 * precision rule. Per-member wildcard resolution is DEFERRED.
 *
 * stdlib / external imports (`kotlin.*`, `kotlinx.*`, `java.*`, AndroidX, third-party)
 * still emit a symbol hint here — silence is the SymbolTable's job (an FQN no in-graph
 * file declares resolves to undefined and is never flagged).
 */

/** The FQN `qualified_identifier` child of an `import` node, as dotted text. A
 *  single-segment import is a bare `identifier` instead. Returns its `.text`. */
function importFqn(decl: Node): string | undefined {
  for (let i = 0; i < decl.namedChildCount; i++) {
    const child = decl.namedChild(i);
    if (child === null) continue;
    if (child.type === 'qualified_identifier' || child.type === 'identifier') {
      return child.text;
    }
  }
  return undefined;
}

function uses(file: ParsedFile): DetectedDep[] {
  const out: DetectedDep[] = [];
  const seen = new Set<string>();

  const emit = (symbolKey: string | undefined, node: Node): void => {
    if (symbolKey === undefined || symbolKey === '') return;
    const line = node.startPosition.row + 1;
    const dedupKey = `${symbolKey} ${line}`;
    if (seen.has(dedupKey)) return;
    seen.add(dedupKey);
    out.push(single({ kind: 'symbol', symbolKey }, 'import', line));
  };

  walk(file.tree.rootNode, (node) => {
    // Match the NAMED `import` node, never the bare `import` keyword token.
    if (node.type !== 'import' || !node.isNamed) return undefined;
    // The FQN is the qualified_identifier text. For a wildcard the text is already the
    // package (the `*` is a separate token); for an alias the trailing identifier (the
    // `as B` binding) is a separate child and is NOT returned by importFqn — so the FQN
    // is emitted unchanged in every case.
    emit(importFqn(node), node);
    return undefined;
  });

  return out;
}

/** The simple name an `import`/`package`-bearing declaration defines, or undefined.
 *  `class`/`interface`/`object`/`function` carry a `name` field; a `property` nests it
 *  under `variable_declaration`; a `type_alias` exposes a direct `identifier` child. */
function declarationName(node: Node): string | undefined {
  const nameField = node.childForFieldName('name');
  if (nameField !== null) return nameField.text;

  if (node.type === 'property_declaration') {
    // `val x = ...` → variable_declaration → identifier. (A multi_variable_declaration
    // destructures; v1 indexes only the single-name form, the common top-level case.)
    for (let i = 0; i < node.namedChildCount; i++) {
      const c = node.namedChild(i);
      if (c !== null && c.type === 'variable_declaration') {
        const id = firstIdentifier(c);
        if (id !== undefined) return id;
      }
    }
    return undefined;
  }

  if (node.type === 'type_alias') {
    // `typealias Money = Long` → first named identifier child is the alias name.
    return firstIdentifier(node);
  }

  return undefined;
}

/** The text of the first named `identifier` descendant child of `node` (shallow). */
function firstIdentifier(node: Node): string | undefined {
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i);
    if (c !== null && c.type === 'identifier') return c.text;
  }
  return undefined;
}

const DECLARATION_TYPES = new Set([
  'class_declaration', // covers both `class` and `interface`
  'object_declaration',
  'function_declaration',
  'property_declaration',
  'type_alias',
]);

/**
 * The FULLY-QUALIFIED symbol keys this file DEFINES. Reads the file's `package_header`
 * (the package FQN, possibly empty for a root-package / `.kts` file), then for each
 * declaration (top-level AND nested — nesting does not change the owning node, so the
 * extra names are harmless and let `Outer.Inner`-style qualified access resolve in the
 * future) emits `<package>.<Name>`, or just `<Name>` when the package is empty.
 *
 * These keys feed the shared SymbolTable; a use's import FQN resolves against them.
 */
function declarations(file: ParsedFile): DeclaredSymbol[] {
  const out: DeclaredSymbol[] = [];

  let pkg = '';
  walk(file.tree.rootNode, (node) => {
    if (node.type !== 'package_header') return undefined;
    for (let i = 0; i < node.namedChildCount; i++) {
      const c = node.namedChild(i);
      if (c !== null && c.type === 'qualified_identifier') {
        pkg = c.text;
        return false; // first package_header wins; stop descending it
      }
    }
    return false;
  });

  walk(file.tree.rootNode, (node) => {
    if (!DECLARATION_TYPES.has(node.type)) return undefined;
    const name = declarationName(node);
    if (name === undefined || name === '') return undefined;
    const symbolKey = pkg === '' ? name : `${pkg}.${name}`;
    out.push({ symbolKey, line: node.startPosition.row + 1 });
    return undefined;
  });

  return out;
}

export const kotlinExtractor: DependencyExtractor = {
  languages: new Set(['kotlin']),
  declarations,
  uses,
};
