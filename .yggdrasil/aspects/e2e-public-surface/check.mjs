import { walk, report } from '@chrisdudek/yg/ast';

// Forbid any e2e test file from importing a module that resolves into the CLI's
// internal source tree (source/cli/src/**), in ANY form:
//   - static:        import … from '…'   /   import type … from '…'
//   - re-export:     export … from '…'
//   - dynamic:       import('…')
//   - commonjs:      require('…')
//
// Detection is AST-based: we inspect import/export declaration `source` nodes and
// the string ARGUMENT of dynamic-import / require call expressions. We never scan
// the raw file text — so a string LITERAL that merely contains the word `import`
// (e.g. a fixture written via writeFileSync to seed an undeclared dependency) is
// not a false positive: it is a plain string node, not an import/call node.

// The CLI internal source root every e2e file must stay out of.
const SRC_ROOT = 'source/cli/src/';

/**
 * Pull the literal value out of a tree-sitter `string` node OR a no-substitution
 * `template_string` node. A backtick literal with no `${…}` (e.g. `import(`../src/x`)`)
 * is a static, statically-resolvable specifier — TS/esbuild/Node treat it identically
 * to a quoted string — so it must be caught too. An INTERPOLATED template literal is
 * genuinely non-static and out of scope (returns undefined).
 */
function stringValue(node) {
  if (!node) return undefined;
  if (node.type !== 'string' && node.type !== 'template_string') return undefined;
  // A template literal with any interpolation is not a static specifier — skip it.
  if (node.type === 'template_string' && node.namedChildren.some((c) => c.type === 'template_substitution')) {
    return undefined;
  }
  // Both `string` and `template_string` wrap a `string_fragment` (their raw text, no
  // delimiters); fall back to slicing the surrounding quote / backtick characters off.
  const frag = node.namedChildren.find((c) => c.type === 'string_fragment');
  if (frag) return frag.text;
  const t = node.text;
  if (t.length >= 2) return t.slice(1, -1);
  return '';
}

/**
 * Resolve a relative module specifier against the importing file's directory and
 * report whether the resolved repo-relative path lands under source/cli/src/.
 * Only relative specifiers (./ or ../) can reach the repo tree; bare/package
 * specifiers (e.g. 'vitest', '@chrisdudek/yg/ast', 'node:fs') never do.
 */
function resolvesIntoSrc(spec, importerPath) {
  if (typeof spec !== 'string' || spec.length === 0) return false;
  if (!spec.startsWith('./') && !spec.startsWith('../')) return false;

  // importerPath is a repo-relative POSIX path, e.g. source/cli/tests/e2e/foo.test.ts.
  const importerDir = importerPath.split('/').slice(0, -1);
  const segments = spec.split('/');
  const stack = [...importerDir];
  for (const seg of segments) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (stack.length === 0) return false; // escapes repo root — cannot be src
      stack.pop();
    } else {
      stack.push(seg);
    }
  }
  const resolved = stack.join('/');
  return resolved.startsWith(SRC_ROOT);
}

export function check(ctx) {
  const violations = [];

  for (const file of ctx.files) {
    if (!file.ast) continue; // non-parseable file — nothing to inspect

    walk(file.ast.rootNode, (node) => {
      // 1. import … from '…'  and  import type … from '…'
      // 2. export … from '…'  (re-export)
      if (node.type === 'import_statement' || node.type === 'export_statement') {
        let source = node.childForFieldName('source');
        if (!source) {
          // TS import-equals: `import x = require('…')` — the import_statement has no
          // own `source` field; the specifier lives on an import_require_clause child.
          const reqClause = node.namedChildren.find((c) => c.type === 'import_require_clause');
          if (reqClause) source = reqClause.childForFieldName('source');
        }
        const spec = stringValue(source);
        if (spec && resolvesIntoSrc(spec, file.path)) {
          violations.push(
            report(
              file,
              node,
              `e2e test imports the CLI internal module '${spec}' (resolves into ${SRC_ROOT}). ` +
                `E2E tests must use only the public CLI surface — spawn dist/bin.js and read committed ` +
                `artifacts; never import src/** modules. Move the assertion onto the public surface, or ` +
                `(if it genuinely needs an internal) into a unit test under source/cli/tests/unit/.`,
            ),
          );
        }
        return true;
      }

      // 3. dynamic import('…')  and  4. require('…')
      if (node.type === 'call_expression') {
        const fn = node.childForFieldName('function');
        if (!fn) return true;
        // Dynamic import: the callee is the `import` keyword node.
        // require(): the callee is an identifier whose text is exactly `require`.
        const isDynamicImport = fn.type === 'import';
        const isRequire = fn.type === 'identifier' && fn.text === 'require';
        if (!isDynamicImport && !isRequire) return true;

        const args = node.childForFieldName('arguments');
        const firstArg = args?.namedChildren[0];
        const spec = stringValue(firstArg);
        if (spec && resolvesIntoSrc(spec, file.path)) {
          const form = isDynamicImport ? 'dynamic import' : 'require';
          violations.push(
            report(
              file,
              node,
              `e2e test uses ${form}('${spec}') to load the CLI internal module (resolves into ${SRC_ROOT}). ` +
                `E2E tests must use only the public CLI surface — spawn dist/bin.js and read committed ` +
                `artifacts; never load src/** modules. Move the assertion onto the public surface, or ` +
                `(if it genuinely needs an internal) into a unit test under source/cli/tests/unit/.`,
            ),
          );
        }
        return true;
      }

      return true;
    });
  }

  return violations;
}
