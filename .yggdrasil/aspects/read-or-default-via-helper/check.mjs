import { walk, report, inFile } from '@chrisdudek/yg/ast';

// Forbids inline ENOENT-swallow try/catch wrapping a readFile call in IO files.
// The canonical helper is io/read-or-default.ts (readFileOrDefault).
//
// Smart enough to skip:
//  - The helper itself (read-or-default.ts).
//  - try blocks that don't actually call readFile (e.g. lstat, readdir, stat,
//    or recursive directory traversal). Those have legitimately different
//    semantics and are not the target of this aspect.
export function check(ctx) {
  const violations = [];
  for (const file of ctx.files) {
    if (inFile(file, { glob: '**/read-or-default.ts' })) continue;
    if (!inFile(file, { glob: '**/src/io/*.ts' })) continue;

    walk(file.ast.rootNode, (node) => {
      if (node.type !== 'try_statement') return;

      // tree-sitter TypeScript shape: try_statement -> body (statement_block), handler (catch_clause)
      const body = node.childForFieldName('body');
      const handler =
        node.childForFieldName('handler') ?? node.children.find((c) => c.type === 'catch_clause');
      if (!body || !handler) return;

      const bodyText = body.text || '';
      const handlerText = handler.text || '';

      // Only flag when:
      //   1) the try body invokes readFile (text-file reading), AND
      //   2) the catch checks for ENOENT (swallow pattern), AND
      //   3) the try body does NOT also invoke lstat/stat/readdir — compound
      //      try blocks have legitimate non-readFile semantics (symlink check,
      //      directory walk, etc.) and are not the target of this aspect.
      const callsReadFile = /\breadFile\s*\(/.test(bodyText);
      const callsOtherFs = /\b(lstat|stat|readdir|access|opendir)\s*\(/.test(bodyText);
      const handlesEnoent = handlerText.includes("'ENOENT'") || handlerText.includes('"ENOENT"');

      if (callsReadFile && handlesEnoent && !callsOtherFs) {
        violations.push(
          report(
            file,
            node,
            "inline ENOENT-swallow around readFile() — IO files must use readFileOrDefault() from io/read-or-default instead",
          ),
        );
      }
    });
  }
  return violations;
}
