import { report } from '@chrisdudek/yg/ast';

// Single-responsibility heuristic (advisory): a focused portal backend file exports
// a small set of RUNTIME symbols. Many runtime exports usually means the file is doing
// several jobs and should be split into derivation children. Type-only exports
// (interface / type) are cheap and not counted.
//
// AST-based, counting each RUNTIME binding the file exports — not each export STATEMENT:
//   - `export function f` / `export class C`              → 1 each.
//   - `export const a = 1, b = 2`                         → one per DECLARATOR (here 2),
//     since each declarator introduces its own runtime binding.
//   - `export { a, b, c }`  (named export_clause)         → one per export_specifier,
//     EXCEPT a specifier carrying an inline `type` token (`export { type T }`), which is
//     type-only and not counted. A whole `export type { … }` clause is likewise skipped.
//   - bare re-exports `export { x } from './m'` count their specifiers too (still runtime
//     surface), while `export type { x } from './m'` does not.

const MAX_RUNTIME_EXPORTS = 4;

// Declaration node types that introduce a RUNTIME binding directly on the export.
const RUNTIME_DECL_TYPES = new Set([
  'function_declaration',
  'generator_function_declaration',
  'class_declaration',
  'abstract_class_declaration',
]);

// Declaration node types whose DECLARATORS each introduce a runtime binding.
const MULTI_DECLARATOR_TYPES = new Set([
  'lexical_declaration', // const / let
  'variable_declaration', // var
]);

/** True iff this export_statement is a type-only export (`export type { … }` / `export type X`). */
function isTypeOnlyExport(stmt) {
  // tree-sitter places a `type` keyword child immediately after `export` for type-only exports.
  for (const child of stmt.children) {
    if (child.type === 'type') return true;
    // Stop scanning once we reach the clause / declaration — `type` precedes them.
    if (child.type === 'export_clause' || child.type === 'export_specifier') break;
  }
  return false;
}

/** True iff a single export_specifier is inline-type-only (`export { type T }`). */
function isTypeOnlySpecifier(spec) {
  for (const child of spec.children) {
    if (child.type === 'type') return true;
  }
  return false;
}

/** Count the runtime bindings introduced by one top-level export_statement. */
function countRuntimeExports(stmt) {
  if (isTypeOnlyExport(stmt)) return 0;

  // Direct declaration export: `export function f`, `export const a = 1, b = 2`.
  const decl = stmt.childForFieldName('declaration');
  if (decl) {
    if (RUNTIME_DECL_TYPES.has(decl.type)) return 1;
    if (MULTI_DECLARATOR_TYPES.has(decl.type)) {
      const n = decl.namedChildren.filter((c) => c.type === 'variable_declarator').length;
      return n > 0 ? n : 1; // a malformed/empty declaration still names at least one binding
    }
    return 0; // type/interface declaration, or another non-runtime form
  }

  // Named export clause: `export { a, b, c }` / `export { a, type T }` / re-export.
  const clause = stmt.namedChildren.find((c) => c.type === 'export_clause');
  if (clause) {
    let n = 0;
    for (const spec of clause.namedChildren) {
      if (spec.type !== 'export_specifier') continue;
      if (isTypeOnlySpecifier(spec)) continue;
      n += 1;
    }
    return n;
  }

  return 0;
}

export function check(ctx) {
  const violations = [];

  for (const file of ctx.files) {
    if (!file.ast) continue;

    let runtimeExports = 0;
    let firstExportNode = null;

    // Only inspect TOP-LEVEL statements (program children) — keeps the count to the
    // file's own surface.
    for (const stmt of file.ast.rootNode.namedChildren) {
      if (stmt.type !== 'export_statement') continue;
      const n = countRuntimeExports(stmt);
      if (n > 0) {
        runtimeExports += n;
        if (!firstExportNode) firstExportNode = stmt;
      }
    }

    if (runtimeExports > MAX_RUNTIME_EXPORTS) {
      violations.push(
        report(
          file,
          firstExportNode ?? file.ast.rootNode,
          `Portal backend file exports ${runtimeExports} runtime symbols (advisory cap ` +
            `${MAX_RUNTIME_EXPORTS}). Consider splitting it into focused derivation children — ` +
            `one responsibility per file.`,
        ),
      );
    }
  }

  return violations;
}
