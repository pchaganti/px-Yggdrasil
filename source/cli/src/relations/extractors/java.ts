import type { Node } from 'web-tree-sitter';
import { walk } from '../../ast/walk.js';
import type { DependencyExtractor, DetectedDep, DeclaredSymbol, ParsedFile } from './types.js';
import { single } from './types.js';

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

  const emit = (specifier: string | undefined, node: Node, isPackage = false): void => {
    if (specifier === undefined || specifier === '') return;
    const line = node.startPosition.row + 1;
    const dedupKey = `${specifier} ${line}`;
    if (seen.has(dedupKey)) return;
    seen.add(dedupKey);
    out.push(single({ kind: 'path', specifier, isPackage }, 'import', line));
  };

  walk(file.tree.rootNode, (node) => {
    if (node.type !== 'import_declaration') return undefined;

    const fqn = importFqn(node);
    if (fqn === undefined) return undefined;

    const wildcard = isWildcardImport(node);
    const isStatic = isStaticImport(node);

    if (wildcard) {
      // `import com.foo.*;`            → package FQN `com.foo` (a directory of types).
      // `import static com.foo.Bar.*;` → the scoped_identifier IS the class FQN
      //   `com.foo.Bar` (static-on-demand); it is a TYPE, not a package.
      emit(fqn, node, /* isPackage */ !isStatic);
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

/** The package FQN of a compilation unit, read from its `package_declaration`'s
 *  `scoped_identifier` (a bare `identifier` for a single-segment package). Empty string
 *  for the unnamed/default package. */
function packageFqn(file: ParsedFile): string {
  let pkg = '';
  walk(file.tree.rootNode, (node) => {
    if (node.type !== 'package_declaration') return undefined;
    for (let i = 0; i < node.namedChildCount; i++) {
      const c = node.namedChild(i);
      if (c !== null && (c.type === 'scoped_identifier' || c.type === 'identifier')) {
        pkg = c.text;
        return false; // first package_declaration wins; stop descending it
      }
    }
    return false;
  });
  return pkg;
}

/** The enclosing-TYPE chain of `node`, outermost-first: the `name` of every ancestor
 *  `class`/`interface`/`enum`/`record` declaration. A nested `class Inner` inside
 *  `class Outer` yields `["Outer"]`; deeper nesting yields `["Outer", "Mid"]`; empty for a
 *  top-level declaration. Joined to the declaration's own simple name by the reflection
 *  separator `+` (Java's JVM binary name is `Outer$Inner`; the analyzer's canonical key is
 *  `Outer+Inner` — same boundary), DISJOINT from the package `.` so a nested key lives in a
 *  string space no dot-only candidate can collide with (separator isolation). */
function enclosingTypeChain(node: Node): string[] {
  const parts: string[] = [];
  let cur: Node | null = node.parent;
  while (cur !== null) {
    if (DECLARATION_TYPES.has(cur.type)) {
      const name = cur.childForFieldName('name')?.text;
      if (name !== undefined && name !== '') parts.unshift(name);
    }
    cur = cur.parent;
  }
  return parts;
}

/**
 * The FULLY-QUALIFIED symbol keys this file DEFINES — a thin parity layer. Java v1 resolves
 * dependencies by PATH (the package = directory convention; `uses()` emits only `path` hints
 * that never touch the SymbolTable), so this table is NOT load-bearing for Java resolution
 * today; it exists for parity with the symbol-resolved languages and for any future symbol
 * consumer. Reads the file's `package_declaration`, then for each `class`/`interface`/`enum`/
 * `record` declaration (top-level AND nested) emits `<package>.<TypeKey>` (or `<TypeKey>` for
 * the unnamed package).
 *
 * `<TypeKey>` is the enclosing-TYPE chain joined to the declaration's own simple name by `+`:
 * a top-level `Order` is `Order`; a nested `Inner` inside `Outer` is `Outer+Inner`. A NESTED
 * declaration emits ONLY its `+` key — NEVER also a bare flat `Inner`. Keying a nested type
 * flat (the latent v1 shape, mirrored on the pre-fix Kotlin bug) manufactured a phantom
 * top-level name: `class Outer { class Inner }` produced the bare `Inner`, which — the instant
 * any Java symbol consumer existed — a top-level `import <pkg>.Inner` (in Java that names a
 * TOP-LEVEL type, never the nested `Outer.Inner`) would mis-bind to this file (a false
 * positive), or which would collide with a real `<pkg>.Inner` in another node and silence its
 * legitimate edge. The `+` key lives in a string space disjoint from the dot-only namespace,
 * so it cannot collide; a nested-type use resolves to it through the resolver's guarded
 * `+`-boundary split. (This change is parity-data only: Java resolution is path-based and
 * never reads these keys, so no current edge changes — the latent phantom is removed.)
 */
function declarations(file: ParsedFile): DeclaredSymbol[] {
  const out: DeclaredSymbol[] = [];
  const pkg = packageFqn(file);
  walk(file.tree.rootNode, (node) => {
    if (!DECLARATION_TYPES.has(node.type)) return undefined;
    const nameNode = node.childForFieldName('name');
    if (nameNode === null || nameNode.text === '') return undefined;
    const typeKey = [...enclosingTypeChain(node), nameNode.text].join('+');
    const symbolKey = pkg === '' ? typeKey : `${pkg}.${typeKey}`;
    out.push({ symbolKey, line: node.startPosition.row + 1 });
    return undefined;
  });
  return out;
}

export const javaExtractor: DependencyExtractor = {
  languages: new Set(['java']),
  declarations,
  uses,
};
