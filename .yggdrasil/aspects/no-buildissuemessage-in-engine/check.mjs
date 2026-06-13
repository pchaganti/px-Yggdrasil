import { walk, report } from '@chrisdudek/yg/ast';

// Engine-layer source roots (repo-relative POSIX prefixes). The check
// self-scopes to these so it is safe to attach broadly: a file outside
// these directories (e.g. a cli/ command module that legitimately renders
// messages) is skipped entirely.
const ENGINE_PREFIXES = [
  'source/cli/src/core/',
  'source/cli/src/io/',
  'source/cli/src/ast/',
];

function inEngineLayer(filePath) {
  return ENGINE_PREFIXES.some((prefix) => filePath.startsWith(prefix));
}

export function check(ctx) {
  const violations = [];
  for (const file of ctx.files) {
    if (!file.ast) continue;
    if (!inEngineLayer(file.path)) continue;
    walk(file.ast.rootNode, (node) => {
      if (node.type !== 'call_expression') return;
      // The callee lives in the `function` field. A bare-identifier callee is
      // the only form we flag — `buildIssueMessage(...)` whether used as a
      // statement, an argument (e.g. `super(buildIssueMessage(...))`), or an
      // initializer. Member-access callees (foo.buildIssueMessage) are not
      // matched: they are not the imported renderer.
      const callee = node.childForFieldName('function');
      if (!callee || callee.type !== 'identifier') return;
      if (callee.text !== 'buildIssueMessage') return;
      violations.push(
        report(
          file,
          node,
          'engine module calls buildIssueMessage — engine layers return structured {what,why,next} data; the CLI command layer renders it (move the call to the CLI layer or return messageData).',
        ),
      );
    });
  }
  return violations;
}
