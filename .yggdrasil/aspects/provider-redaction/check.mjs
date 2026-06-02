import { walk, report, inFile } from '@chrisdudek/yg/ast';

// Identifiers that may carry raw LLM prompt or response data
const SENSITIVE_VARS = new Set(['prompt', 'response', 'content', 'body']);

function containsSensitiveIdentifier(node) {
  if (node.type === 'identifier' && SENSITIVE_VARS.has(node.text)) return true;
  for (const child of node.children) {
    if (containsSensitiveIdentifier(child)) return true;
  }
  return false;
}

function isInsideRedactCall(node) {
  let cur = node.parent;
  while (cur) {
    if (cur.type === 'call_expression') {
      const fn = cur.childForFieldName('function');
      if (fn && fn.text === 'redactSecrets') return true;
    }
    cur = cur.parent;
  }
  return false;
}

export function check(ctx) {
  const violations = [];
  for (const file of ctx.files) {
    if (!file.ast) continue;
    if (!inFile(file, { glob: '**/src/llm/*.ts' })) continue;

    walk(file.ast.rootNode, (node) => {
      if (node.type !== 'call_expression') return;
      const fn = node.childForFieldName('function');
      if (fn === null) return;

      // Check debugWrite() or process.stderr.write() calls
      const isDebugWrite = fn.type === 'identifier' && fn.text === 'debugWrite';
      const isStderrWrite =
        fn.type === 'member_expression' &&
        fn.childForFieldName('object')?.text === 'process.stderr' &&
        fn.childForFieldName('property')?.text === 'write';
      if (!isDebugWrite && !isStderrWrite) return;

      const argsNode = node.childForFieldName('arguments');
      if (argsNode === null) return;

      for (const arg of argsNode.children) {
        if (arg.type === ',' || arg.type === '(' || arg.type === ')') continue;
        if (containsSensitiveIdentifier(arg) && !isInsideRedactCall(node)) {
          violations.push(
            report(
              file,
              arg,
              `raw sensitive variable referenced in log call without redactSecrets() wrapping`,
            ),
          );
        }
      }
    });
  }
  return violations;
}
