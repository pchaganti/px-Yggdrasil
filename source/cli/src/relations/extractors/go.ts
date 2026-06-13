import type { Node } from 'web-tree-sitter';
import { walk } from '../../ast/walk.js';
import type { DependencyExtractor, DetectedDep, DeclaredSymbol, ParsedFile } from './types.js';

/**
 * Go dependency extractor.
 *
 * v1 scope = EXISTENCE, not relation type. The unit of an inter-component edge in
 * Go is the IMPORTED PACKAGE PATH: a Go file imports a PACKAGE (a directory of
 * `.go` files), binds it to a local name, and every cross-package reference is
 * `<localName>.<Ident>`. A dependency edge is therefore established ONLY by an
 * import declaration (`import_declaration` → `import_spec`). Usage-site nodes
 * (selector calls `pkg.Func`, package-qualified types, struct/interface embedding)
 * would only REFINE the relation type of an already-imported package, and v1 does
 * not enforce relation type — so this extractor performs NO usage-site refinement.
 * It emits exactly one path hint per `import_spec`, whose specifier is the import
 * PATH (e.g. `example.com/mod/foo/bar`); the resolver maps that path → a directory
 * → a representative file via go.mod's module path.
 *
 * The local binding (`import_spec` `name` field — an explicit alias
 * `package_identifier`, a blank import `_`, or a dot-import `.`) is IRRELEVANT to
 * the edge: every form still names a real package path, and the import path alone
 * (alias-, scope-, and qualifier-independent) establishes the dependency. So the
 * name field is never read here.
 */

/**
 * Read the import-path string from an `import_spec`'s `path` field. The path node
 * is an `interpreted_string_literal` (double-quoted) or a `raw_string_literal`
 * (backtick-quoted). Both wrap their content in a single delimiter char on each
 * side, so strip the first and last character of `.text`. Returns undefined when
 * the path field is absent or not a string literal.
 */
function importPathFromSpec(spec: Node): string | undefined {
  const pathNode = spec.childForFieldName('path');
  if (pathNode === null) return undefined;
  if (pathNode.type !== 'interpreted_string_literal' && pathNode.type !== 'raw_string_literal') {
    return undefined;
  }
  const text = pathNode.text;
  // Quoted literal: strip the surrounding delimiter (" or `). An empty `""`/```` `` ````
  // yields '' after stripping, which the emitter discards.
  if (text.length < 2) return '';
  return text.slice(1, -1);
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
    out.push({ targetHint: { kind: 'path', specifier }, kind: 'import', line });
  };

  // Walk every `import_spec`. This covers BOTH single-spec form
  // (`import "x"` → import_declaration > import_spec) and grouped form
  // (`import ( ... )` → import_declaration > import_spec_list > import_spec).
  walk(file.tree.rootNode, (node) => {
    if (node.type === 'import_spec') {
      emit(importPathFromSpec(node), node);
    }
    return undefined;
  });

  return out;
}

/**
 * Top-level declarations — a thin parity layer (Go resolves dependencies by PATH,
 * not by symbol, so a Go SymbolTable is not load-bearing). Emits the names of
 * top-level type, function, and method declarations:
 *   - `type_declaration` > `type_spec` / `type_alias` (field `name` = type_identifier)
 *   - `function_declaration` (field `name` = identifier)
 *   - `method_declaration` (field `name` = field_identifier)
 * `type_declaration` may group several specs (`type ( A struct{}; B int )`), so we
 * walk for the inner `type_spec`/`type_alias` rather than the declaration wrapper.
 */
function declarations(file: ParsedFile): DeclaredSymbol[] {
  const out: DeclaredSymbol[] = [];
  walk(file.tree.rootNode, (node) => {
    if (
      node.type === 'function_declaration' ||
      node.type === 'method_declaration' ||
      node.type === 'type_spec' ||
      node.type === 'type_alias'
    ) {
      const nameNode = node.childForFieldName('name');
      if (nameNode !== null) {
        out.push({ symbolKey: nameNode.text, line: node.startPosition.row + 1 });
      }
    }
    return undefined;
  });
  return out;
}

export const goExtractor: DependencyExtractor = {
  languages: new Set(['go']),
  declarations,
  uses,
};
