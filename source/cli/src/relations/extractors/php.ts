import type { Node } from 'web-tree-sitter';
import { walk } from '../../ast/walk.js';
import type { DependencyExtractor, DetectedDep, DeclaredSymbol, ParsedFile } from './types.js';
import { single } from './types.js';

/**
 * PHP dependency extractor.
 *
 * v1 scope = EXISTENCE, not relation type. The unit of an inter-component edge in
 * PHP is the IMPORT: a top-level `namespace_use_declaration` (`use Foo\Bar;`) names a
 * fully-qualified class / interface / trait / enum. A dependency edge is therefore
 * established ONLY by a `use` import. Usage-site constructs — `extends` / `implements`
 * super-types, in-body trait `use`, `new`, static calls (`Foo::bar()`), type hints,
 * `instanceof`, attributes — would only REFINE the relation type of an already-imported
 * binding, and v1 does not enforce relation type, so this extractor performs NO
 * usage-site refinement. It emits exactly one path hint per imported symbol, whose
 * specifier is a PHP FULLY-QUALIFIED NAME with `\` separators (`Foo\Bar\Baz`); the
 * resolver maps that FQN → a file via composer.json PSR-4.
 *
 * Fully-qualified INLINE references WITH A LEADING BACKSLASH (`new \App\X()`,
 * `\App\X::y()`, `\App\X $param`, `extends \App\X`) ARE emitted. The leading `\` is PHP's
 * absoluteness marker: `\App\X` names the type `App\X` from the GLOBAL namespace, with no
 * dependence on the file's `namespace` or its `use` aliases — so it is shadow-free and maps
 * to a file by the SAME PSR-4 rule as an import. Detection is restricted two ways to stay
 * false-positive-free:
 *   - ONLY a leading-backslash `qualified_name` is read; a backslash-LESS `qualified_name`
 *     (`Sub\Rel`, `Rel`) is namespace-relative and would need the current namespace + use
 *     aliases to bind — out of reach for a source-only tool, so it stays silent.
 *   - ONLY when the reference sits in a CLASS-autoload position (a type, `new`, `extends` /
 *     `implements`, `::` static access, an attribute, `instanceof`). A leading-backslash
 *     name in FUNCTION-call position (`\App\f()`) or as a bare CONSTANT (`\App\FOO`) does
 *     NOT trigger class autoloading — PHP keeps functions/constants in separate namespaces
 *     resolved at call time, never mapped to a PSR-4 class file — so emitting them could
 *     bind to an unrelated class file that merely shares the path. Those positions are
 *     excluded; the emitted set is exactly the class references PSR-4 actually resolves.
 *
 * Grammar shapes this extractor reads (verified live against tree-sitter-php_only):
 *   - Plain      `use App\Payment\Gateway;`
 *       namespace_use_declaration > namespace_use_clause > qualified_name
 *       (`.text` = `App\Payment\Gateway`; a single bare `name` for a one-segment import).
 *   - Aliased    `use App\Payment\Gateway as G;`
 *       the clause has qualified_name + a trailing `name` alias. The FQN is the
 *       qualified_name; the alias is the LOCAL binding and is NEVER the target.
 *   - Leading \  `use \App\Payment\Gateway;`
 *       qualified_name's first child is the anonymous `\` token; its `.text` carries a
 *       leading backslash — strip exactly one.
 *   - Grouped    `use App\Payment\{Charge, Refund as R};`
 *       namespace_use_declaration has a leading `namespace_name` child (`App\Payment`)
 *       and a `namespace_use_group` of namespace_use_clause nodes. Each group clause's
 *       symbol is its own qualified_name (nested group) or a bare `name` (`Charge`);
 *       the imported FQN = leading base + `\` + that segment.
 *   - function / const imports — two grammar placements, both SKIPPED (importing a
 *     function or constant, not a class; dropping them costs recall, never a false positive):
 *       * declaration-level `use function App\Util\format;` / `use const App\Util\{A, B};`
 *         — the anonymous `function`/`const` token is a direct child of the declaration;
 *         every clause it introduces is a function/const, so the whole declaration is skipped.
 *       * per-clause inside a group `use App\Pkg\{function format, Gateway};` — the token sits
 *         on the individual namespace_use_clause; ONLY that clause is dropped, sibling class
 *         clauses (here `Gateway`) are still emitted.
 */

/** Strip a single leading backslash from a PHP FQN: `\App\X` → `App\X`. */
function stripLeadingBackslash(fqn: string): string {
  return fqn.startsWith('\\') ? fqn.slice(1) : fqn;
}

/** The FQN text of a clause's name node: its `qualified_name`, or a bare `name`.
 *  Returns the raw `.text` (backslashes preserved) or undefined when neither is present. */
function clauseNameText(clause: Node): string | undefined {
  for (let i = 0; i < clause.namedChildCount; i++) {
    const child = clause.namedChild(i);
    if (child === null) continue;
    if (child.type === 'qualified_name' || child.type === 'name') return child.text;
  }
  return undefined;
}

/** True when a `use` declaration imports a FUNCTION or CONST at the DECLARATION level
 *  (`use function Base\X;`, `use const Base\{A, B};`) — the anonymous `function` / `const`
 *  token sits directly under the declaration, so EVERY clause it introduces is a
 *  function/constant, not a class. Such declarations are skipped wholesale — out of v1
 *  class-dependency scope. A grouped use that carries the token on an INDIVIDUAL clause
 *  instead (`use Base\{function f, Klass};`) is NOT caught here; that is guarded per clause
 *  by clauseIsFunctionOrConst during expansion. */
function isFunctionOrConstUse(decl: Node): boolean {
  for (let j = 0; j < decl.childCount; j++) {
    const c = decl.child(j);
    if (c !== null && !c.isNamed && (c.type === 'function' || c.type === 'const')) return true;
  }
  return false;
}

/** True when a single `namespace_use_clause` carries its OWN `function` / `const` token
 *  (the per-clause form inside a grouped use, e.g. `{function format, Gateway}` — only the
 *  `function format` clause is a function import). Such a clause imports a function/constant,
 *  not a class, and is dropped while its sibling class clauses are kept. */
function clauseIsFunctionOrConst(clause: Node): boolean {
  for (let k = 0; k < clause.childCount; k++) {
    const c = clause.child(k);
    if (c !== null && !c.isNamed && (c.type === 'function' || c.type === 'const')) return true;
  }
  return false;
}

/** The leading base namespace of a grouped `use Base\{A, B};` declaration, or undefined.
 *  It is the `namespace_name` child sitting directly under the declaration (NOT inside a
 *  clause), present only in the grouped form. */
function groupBase(decl: Node): string | undefined {
  for (let i = 0; i < decl.namedChildCount; i++) {
    const child = decl.namedChild(i);
    if (child !== null && child.type === 'namespace_name') return child.text;
  }
  return undefined;
}

/**
 * The PARENT node types under which a leading-backslash `qualified_name` is a CLASS
 * reference that PHP autoloads via PSR-4 — the sound allowlist that keeps inline detection
 * false-positive-free. Verified against tree-sitter-php_only:
 *   - object_creation_expression     `new \App\X()`
 *   - named_type                     a type hint (param/return/property), incl. inside a
 *                                    union_type / intersection_type / optional_type and a
 *                                    catch `type_list` (which wraps each type in named_type)
 *   - base_clause                    `extends \App\Base`
 *   - class_interface_clause         `implements \App\Iface`
 *   - scoped_call_expression         `\App\X::method()`  (the qualified_name is the scope)
 *   - scoped_property_access_expression `\App\X::$prop`
 *   - class_constant_access_expression  `\App\X::CONST`, `\App\X::class`
 *   - attribute                      `#[\App\Route]`
 *   - use_declaration                an IN-BODY trait use `use \App\Mixin\Trait;` (a class's
 *                                    `use_declaration`, distinct from the top-level namespace
 *                                    import `namespace_use_declaration`) — a real trait dependency
 * `instanceof` (`$x instanceof \App\Y`) parses as a binary_expression and is handled
 * separately (isInstanceofClassRef) — its right operand is a class reference, but a
 * binary_expression is not a class context in general, so it is NOT in this set.
 */
const CLASS_REF_PARENTS = new Set([
  'object_creation_expression',
  'named_type',
  'base_clause',
  'class_interface_clause',
  'scoped_call_expression',
  'scoped_property_access_expression',
  'class_constant_access_expression',
  'attribute',
  'use_declaration',
]);

/** True when `qn` is the right operand of an `instanceof` binary expression
 *  (`$x instanceof \App\Y`) — a class reference. Detected by an anonymous `instanceof`
 *  token child on the binary_expression parent. */
function isInstanceofClassRef(qn: Node): boolean {
  const parent = qn.parent;
  if (parent === null || parent.type !== 'binary_expression') return false;
  for (let i = 0; i < parent.childCount; i++) {
    const c = parent.child(i);
    if (c !== null && !c.isNamed && c.type === 'instanceof') return true;
  }
  return false;
}

/** True when a leading-backslash `qualified_name` sits in a class-autoload position — the
 *  only positions an inline FQN is emitted from (see CLASS_REF_PARENTS / isInstanceofClassRef).
 *  A function-call (`\App\f()`) parent is `function_call_expression`; a bare constant parent
 *  is a generic expression — neither is in scope, so both are excluded. */
function isClassReferenceContext(qn: Node): boolean {
  const parent = qn.parent;
  if (parent === null) return false;
  if (CLASS_REF_PARENTS.has(parent.type)) return true;
  return isInstanceofClassRef(qn);
}

function uses(file: ParsedFile): DetectedDep[] {
  const out: DetectedDep[] = [];
  const seen = new Set<string>();

  const emit = (specifier: string | undefined, node: Node): void => {
    if (specifier === undefined || specifier === '') return;
    const cleaned = stripLeadingBackslash(specifier);
    if (cleaned === '') return;
    const line = node.startPosition.row + 1;
    const dedupKey = `${cleaned} ${line}`;
    if (seen.has(dedupKey)) return;
    seen.add(dedupKey);
    out.push(single({ kind: 'path', specifier: cleaned }, 'import', line));
  };

  walk(file.tree.rootNode, (node) => {
    // Inline class reference: a leading-backslash `qualified_name` in a class-autoload
    // position. The leading `\` is the absoluteness marker (resolved from the global
    // namespace, shadow-free); the position allowlist excludes function/constant FQNs.
    // An import's qualified_name sits under namespace_use_clause (not a class context) and
    // is never matched here, so imports are handled solely by the branch below.
    if (node.type === 'qualified_name') {
      if (node.text.startsWith('\\') && isClassReferenceContext(node)) emit(node.text, node);
      return undefined;
    }

    if (node.type !== 'namespace_use_declaration') return undefined;
    // Skip function/const imports — they bind a function/constant, not a class.
    if (isFunctionOrConstUse(node)) return undefined;

    const base = groupBase(node);

    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child === null) continue;

      if (child.type === 'namespace_use_clause') {
        // Plain / aliased clause directly under the declaration.
        if (clauseIsFunctionOrConst(child)) continue;
        const name = clauseNameText(child);
        emit(name, child);
      } else if (child.type === 'namespace_use_group') {
        // Grouped form: prepend the leading base namespace to each group clause.
        for (let g = 0; g < child.namedChildCount; g++) {
          const clause = child.namedChild(g);
          if (clause === null || clause.type !== 'namespace_use_clause') continue;
          if (clauseIsFunctionOrConst(clause)) continue;
          const seg = clauseNameText(clause);
          if (seg === undefined) continue;
          const segClean = stripLeadingBackslash(seg);
          const fqn =
            base !== undefined && base !== '' ? `${base}\\${segClean}` : segClean;
          emit(fqn, clause);
        }
      }
    }
    return undefined;
  });

  return out;
}

const DECLARATION_TYPES = new Set([
  'class_declaration',
  'interface_declaration',
  'trait_declaration',
  'enum_declaration',
]);

/**
 * Declared top-level types — a thin parity layer (PHP v1 resolves dependencies by
 * PATH via composer.json PSR-4, not by symbol, so a PHP SymbolTable is not
 * load-bearing). Emits the names of `class` / `interface` / `trait` / `enum`
 * declarations (field `name`).
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

export const phpExtractor: DependencyExtractor = {
  languages: new Set(['php']),
  rev: 1,
  declarations,
  uses,
};
