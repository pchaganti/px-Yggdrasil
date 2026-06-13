import { walk } from '@chrisdudek/yg/ast';

// The entry-point file (bin.ts) must catch every uncaught error — synchronous
// and asynchronous — and exit with code 1. This check enforces the STRUCTURAL
// presence of both handlers; the exact stderr message wording ("Error: <msg>")
// is NOT machine-checked.
//
// (1) A try/catch wraps the synchronous entry point program.parse(), and the
//     catch clause calls process.exit(1).
// (2) A top-level process.on('unhandledRejection', ...) handler exists whose
//     handler body calls process.exit(1).

// Is `node` a call to `obj.prop(...)` (a member-expression callee)?
function isMemberCall(node, objName, propName) {
  if (!node || node.type !== 'call_expression') return false;
  const callee = node.childForFieldName('function');
  if (!callee || callee.type !== 'member_expression') return false;
  const obj = callee.childForFieldName('object');
  const prop = callee.childForFieldName('property');
  return Boolean(obj && prop && obj.text === objName && prop.text === propName);
}

// Does the subtree rooted at `root` contain a call to process.exit(1)?
function containsProcessExit1(root) {
  let found = false;
  walk(root, (node) => {
    if (found) return false;
    if (isMemberCall(node, 'process', 'exit')) {
      const args = node.childForFieldName('arguments');
      const first = args?.namedChildren?.[0];
      if (first && first.text === '1') {
        found = true;
        return false;
      }
    }
  });
  return found;
}

// Does the subtree rooted at `root` contain a call to program.parse(...)?
function containsProgramParse(root) {
  let found = false;
  walk(root, (node) => {
    if (found) return false;
    if (isMemberCall(node, 'program', 'parse')) {
      found = true;
      return false;
    }
  });
  return found;
}

export function check(ctx) {
  const violations = [];
  for (const file of ctx.files) {
    if (!file.ast) continue;
    const root = file.ast.rootNode;

    // (1) try/catch around program.parse() whose catch calls process.exit(1).
    let hasGuardedParse = false;
    walk(root, (node) => {
      if (node.type !== 'try_statement') return;
      const body = node.childForFieldName('body');
      const handler = node.childForFieldName('handler'); // catch_clause
      if (!body || !handler) return;
      if (!containsProgramParse(body)) return;
      const handlerBody = handler.childForFieldName('body');
      if (handlerBody && containsProcessExit1(handlerBody)) {
        hasGuardedParse = true;
      }
    });
    if (!hasGuardedParse) {
      violations.push({
        file: file.path,
        line: 1,
        column: 0,
        message:
          "missing top-level error handler — wrap the synchronous entry point 'program.parse()' in a try/catch whose catch calls process.exit(1)",
      });
    }

    // (2) top-level process.on('unhandledRejection', handler) where the handler
    //     body calls process.exit(1).
    let hasUnhandledRejection = false;
    walk(root, (node) => {
      if (!isMemberCall(node, 'process', 'on')) return;
      const args = node.childForFieldName('arguments');
      const named = args?.namedChildren ?? [];
      const first = named[0];
      // first arg is the event-name string literal 'unhandledRejection'
      const eventName = first?.type === 'string' ? first.text.slice(1, -1) : undefined;
      if (eventName !== 'unhandledRejection') return;
      const handler = named[1];
      if (handler && containsProcessExit1(handler)) {
        hasUnhandledRejection = true;
      }
    });
    if (!hasUnhandledRejection) {
      violations.push({
        file: file.path,
        line: 1,
        column: 0,
        message:
          "missing unhandledRejection handler — add a top-level process.on('unhandledRejection', ...) whose handler calls process.exit(1)",
      });
    }
  }
  return violations;
}
