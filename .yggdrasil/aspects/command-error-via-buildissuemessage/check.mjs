import { walk, report, inFile } from '@chrisdudek/yg/ast';

// Approved error-emission helpers that wrap buildIssueMessage internally.
const ALLOWED_HELPERS = new Set(['loadGraphOrAbort', 'abortOnUnexpectedError']);

// Heuristic window (in chars) around a stderr.write call where we look for
// approved sibling helpers — small enough to be local, large enough to span
// the multi-line wrap idioms used in this codebase.
const SURROUNDING_WINDOW = 400;

export function check(ctx) {
  const violations = [];
  for (const file of ctx.files) {
    if (!inFile(file, { glob: '**/src/cli/*.ts' })) continue;

    const fileText = file.ast.rootNode.text;

    walk(file.ast.rootNode, (node) => {
      if (node.type !== 'call_expression') return;
      const fn = node.childForFieldName('function');
      if (fn === null) return;
      if (fn.text !== 'process.stderr.write') return;

      const args = node.childForFieldName('arguments');
      if (args === null) return;
      const argText = args.text;

      // Allowed: argument contains buildIssueMessage(...) directly.
      if (argText.includes('buildIssueMessage(')) return;

      // Allowed: not error-shaped at all (no chalk.red, no "Error" content,
      // no "ERROR" content). These are progress / info writes; skip.
      const looksLikeError =
        argText.includes('chalk.red') ||
        /\bError:\s/.test(argText) ||
        /\bERROR:\s/.test(argText);
      if (!looksLikeError) return;

      // Allowed: surrounding code routes the message through buildIssueMessage
      // upstream (variable assignment within the same function) or uses one of
      // the approved emission helpers nearby.
      const start = Math.max(0, node.startIndex - SURROUNDING_WINDOW);
      const end = Math.min(fileText.length, node.endIndex + SURROUNDING_WINDOW);
      const surrounding = fileText.slice(start, end);

      if (surrounding.includes('buildIssueMessage(')) return;

      for (const h of ALLOWED_HELPERS) {
        if (surrounding.includes(`${h}(`)) return;
      }

      violations.push(
        report(
          file,
          node,
          'raw stderr error write — command errors must be constructed via buildIssueMessage or routed through loadGraphOrAbort / abortOnUnexpectedError',
        ),
      );
    });
  }
  return violations;
}
