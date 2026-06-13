import type { Node } from 'web-tree-sitter';
import { walk } from '../../ast/walk.js';
import type { DependencyExtractor, DetectedDep, DeclaredSymbol, ParsedFile } from './types.js';

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
 * Fully-qualified INLINE references without a `use` (`new \App\X()`, `\App\X::y()`) are
 * also out of v1 scope — reduced recall, never a false positive.
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
 *   - function / const imports `use function App\Util\format;` / `use const App\Util\MAX;`
 *       the clause carries an anonymous `function` / `const` token child. These import
 *       a function or constant, not a class — SKIPPED (they would resolve to a
 *       different symbol kind; dropping them costs recall, never a false positive).
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

/** True when a `use` declaration imports a FUNCTION or CONST (anonymous token child),
 *  not a class-like symbol. Such imports are skipped — out of v1 class-dependency scope. */
function isFunctionOrConstUse(decl: Node): boolean {
  for (let j = 0; j < decl.childCount; j++) {
    const c = decl.child(j);
    if (c !== null && !c.isNamed && (c.type === 'function' || c.type === 'const')) return true;
  }
  // A grouped function/const use carries the token on each clause instead of the
  // declaration; check the first clause as a representative.
  for (let j = 0; j < decl.namedChildCount; j++) {
    const clause = decl.namedChild(j);
    if (clause === null || clause.type !== 'namespace_use_clause') continue;
    for (let k = 0; k < clause.childCount; k++) {
      const c = clause.child(k);
      if (c !== null && !c.isNamed && (c.type === 'function' || c.type === 'const')) return true;
    }
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
    out.push({ targetHint: { kind: 'path', specifier: cleaned }, kind: 'import', line });
  };

  walk(file.tree.rootNode, (node) => {
    if (node.type !== 'namespace_use_declaration') return undefined;
    // Skip function/const imports — they bind a function/constant, not a class.
    if (isFunctionOrConstUse(node)) return undefined;

    const base = groupBase(node);

    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child === null) continue;

      if (child.type === 'namespace_use_clause') {
        // Plain / aliased clause directly under the declaration.
        const name = clauseNameText(child);
        emit(name, child);
      } else if (child.type === 'namespace_use_group') {
        // Grouped form: prepend the leading base namespace to each group clause.
        for (let g = 0; g < child.namedChildCount; g++) {
          const clause = child.namedChild(g);
          if (clause === null || clause.type !== 'namespace_use_clause') continue;
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
  declarations,
  uses,
};
