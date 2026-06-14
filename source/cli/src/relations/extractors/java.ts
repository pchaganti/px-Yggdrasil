import type { Node } from 'web-tree-sitter';
import { walk } from '../../ast/walk.js';
import type { DependencyExtractor, DetectedDep, DeclaredSymbol, ParsedFile } from './types.js';

/**
 * Java dependency extractor.
 *
 * v1 scope = EXISTENCE, not relation type. The unit of an inter-component edge in
 * Java is the IMPORT: an `import_declaration` names a fully-qualified type (or, for
 * a wildcard import, a package). A dependency edge is therefore established ONLY by
 * an import declaration. Usage-site nodes (`extends`/`implements` super-types,
 * `object_creation_expression`, `method_invocation`, fully-qualified type
 * references, same-package references) would only REFINE the relation type of an
 * already-imported binding, and v1 does not enforce relation type — so this
 * extractor performs NO usage-site refinement. It emits exactly one path hint per
 * import, whose specifier is a Java FULLY-QUALIFIED NAME (a type FQN, or a package
 * FQN for a wildcard); the resolver maps that FQN → a file by Java's
 * package = directory convention.
 *
 * Each `import_declaration` carries one named `scoped_identifier` whose `.text` is
 * the dotted FQN (the grammar nests dotted names rightmost-outermost, so the
 * outermost node's `.text` is the complete dotted string — read it directly, never
 * reassemble segments). Two anonymous variant markers modify what that FQN means:
 *   - a `static` token child  (`import static com.foo.Bar.method;`) — the FQN's
 *     LAST segment is a member, not a type. Drop it: the dependency TYPE is
 *     `com.foo.Bar`. (A static-on-demand `import static com.foo.Bar.*;` has the
 *     asterisk instead, so it is handled by the wildcard branch and keeps the
 *     class FQN intact.)
 *   - an `asterisk` named child (`import com.foo.*;`) — the FQN is a PACKAGE prefix
 *     (`com.foo`), not a type. Emit the package FQN as-is; the resolver maps it to
 *     the package directory (any `.java` in it owns the dependency).
 *
 * `java.*` / `javax.*` / `jakarta.*` stdlib imports and any external-library import
 * still emit a hint here — silence is the RESOLVER's job (an FQN that maps to no
 * mapped `.java` resolves to undefined and is never flagged).
 */

/** Drop the trailing segment of a dotted FQN: `com.foo.Bar.method` → `com.foo.Bar`.
 *  Returns undefined when there is no segment to drop (a single bare segment). */
function dropLastSegment(fqn: string): string | undefined {
  const idx = fqn.lastIndexOf('.');
  if (idx <= 0) return undefined;
  return fqn.slice(0, idx);
}

/** The single FQN node of an `import_declaration`: its named `scoped_identifier`
 *  (or a bare `identifier` for a single-segment import). Returns its `.text`. */
function importFqn(decl: Node): string | undefined {
  for (let i = 0; i < decl.namedChildCount; i++) {
    const child = decl.namedChild(i);
    if (child === null) continue;
    if (child.type === 'scoped_identifier' || child.type === 'identifier') {
      return child.text;
    }
  }
  return undefined;
}

/** True when `decl` has an anonymous `static` token child (a static import). */
function isStaticImport(decl: Node): boolean {
  for (let j = 0; j < decl.childCount; j++) {
    const c = decl.child(j);
    if (c !== null && !c.isNamed && c.type === 'static') return true;
  }
  return false;
}

/** True when `decl` has a named `asterisk` child (a wildcard / on-demand import). */
function isWildcardImport(decl: Node): boolean {
  for (let j = 0; j < decl.childCount; j++) {
    const c = decl.child(j);
    if (c !== null && c.type === 'asterisk') return true;
  }
  return false;
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

  walk(file.tree.rootNode, (node) => {
    if (node.type !== 'import_declaration') return undefined;

    const fqn = importFqn(node);
    if (fqn === undefined) return undefined;

    const wildcard = isWildcardImport(node);
    const isStatic = isStaticImport(node);

    if (wildcard) {
      // `import com.foo.*;`            → package FQN `com.foo` (emit as-is).
      // `import static com.foo.Bar.*;` → the scoped_identifier IS the class FQN
      //   `com.foo.Bar` (the `*` is a separate token), so emit it unchanged too.
      emit(fqn, node);
    } else if (isStatic) {
      // `import static com.foo.Bar.method;` → drop the trailing member → type FQN.
      emit(dropLastSegment(fqn), node);
    } else {
      // Plain single-type import → the FQN is the type.
      emit(fqn, node);
    }
    return undefined;
  });

  return out;
}

const DECLARATION_TYPES = new Set([
  'class_declaration',
  'interface_declaration',
  'enum_declaration',
  'record_declaration',
]);

/**
 * Declared top-level types — a thin parity layer (Java v1 resolves dependencies by
 * PATH via the package = directory convention, not by symbol, so a Java SymbolTable
 * is not load-bearing). Emits the names of `class` / `interface` / `enum` / `record`
 * declarations (field `name`). Nested types are included too: their owning file is
 * the same node either way, so the extra names are harmless parity data.
 */
function declarations(file: ParsedFile): DeclaredSymbol[] {
  const out: DeclaredSymbol[] = [];
  walk(file.tree.rootNode, (node) => {
    if (!DECLARATION_TYPES.has(node.type)) return undefined;
    const nameNode = node.childForFieldName('name');
    if (nameNode !== null) {
      out.push({ symbolKey: nameNode.text, line: node.startPosition.row + 1 });
    }
    return undefined;
  });
  return out;
}

export const javaExtractor: DependencyExtractor = {
  languages: new Set(['java']),
  declarations,
  uses,
};
