import { ast } from '@chrisdudek/yg/ast';

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
    if (!ast.inFile(file, 'src/llm/*.ts')) continue;

    // Check debugWrite() and process.stderr.write() calls for raw sensitive vars
    for (const node of ast.within(file.ast.rootNode, 'call_expression', { crossFunctions: true })) {
      const isLog = ast.call(node, 'debugWrite') || ast.call(node, { object: 'process.stderr', method: 'write' });
      if (!isLog) continue;

      const argsNode = node.childForFieldName('arguments');
      if (!argsNode) continue;

      for (const arg of argsNode.children) {
        if (arg.type === ',' || arg.type === '(' || arg.type === ')') continue;
        if (containsSensitiveIdentifier(arg) && !isInsideRedactCall(node)) {
          violations.push(
            ast.report(
              file,
              arg,
              `raw sensitive variable referenced in log call without redactSecrets() wrapping`,
            ),
          );
        }
      }
    }
  }
  return violations;
}
