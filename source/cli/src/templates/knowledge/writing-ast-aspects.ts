export const summary = 'How to write check.mjs for AST reviewer: 12 helpers, within boundary, suppression, testing';

export const content = `# Writing AST aspects

AST aspects use \`reviewer: ast\` and ship a \`check.mjs\` file. The check
function is deterministic, synchronous, and costs zero LLM calls.

## When to use AST

Use AST when the rule is structural:
- Forbidden import paths ("never import from \`db/\` in \`ui/\`")
- Forbidden API calls (\`fs.readFileSync\` banned in async code)
- Naming conventions (exported classes must be PascalCase)
- Structural shape (every exported function must be async)

Use LLM for semantic rules that require reading intent.

## Skeleton

\`\`\`javascript
import { ast } from '@chrisdudek/yg/ast';

export function check(ctx) {
  const violations = [];
  for (const file of ctx.files) {
    for (const node of ast.within(file.ast.rootNode, 'call_expression')) {
      const m = ast.call(node, { object: 'fs', method: /Sync$/ });
      if (m) violations.push(ast.report(file, node, 'use async fs API'));
    }
  }
  return violations;
}
\`\`\`

Return \`Violation[]\` — synchronous only. No \`async\`, no \`Promise\`.

## The 12 helpers

Import all from \`@chrisdudek/yg/ast\` — zero install required.

| Helper | Purpose |
|--------|---------|
| \`ast.report(file, node, msg)\` | Create Violation (line 1-based) |
| \`ast.nameOf(node)\` | Identifier name from declarations |
| \`ast.inFile(file, pattern)\` | Glob / regex / substring path filter |
| \`ast.exports(rootNode)\` | All exported declarations |
| \`ast.imports(rootNode)\` | All ES imports, require(), dynamic imports |
| \`ast.call(node, target)\` | Match call_expression by name/object/method |
| \`ast.closest(node, types)\` | Nearest ancestor of given types |
| \`ast.within(parent, type, opts?)\` | Descendants of type |
| \`ast.decoratorsOf(node)\` | Decorators on class or member |
| \`ast.modifiersOf(node)\` | Set of modifiers (public, static, async, ...) |
| \`ast.jsxElements(rootNode)\` | All JSX opening and self-closing elements |
| \`ast.casing.pascal(name)\` | Naming checks: also camel, upperSnake, kebab |

## Critical: \`ast.within\` boundary behavior

By default, \`ast.within\` stops at function boundaries. This is intentional:
if your rule is "X within this function", the default is correct.

Use \`crossFunctions: true\` when the rule is "X anywhere in the file":

\`\`\`javascript
// File-level scan — crosses all function boundaries
for (const node of ast.within(file.ast.rootNode, 'call_expression', { crossFunctions: true })) { ... }

// Function-scoped scan — stops at nested functions
for (const node of ast.within(functionNode, 'await_expression')) { ... }
\`\`\`

Using the wrong setting silently misses violations.

## Matching calls

\`\`\`javascript
// Bare function call: foo()
ast.call(node, 'foo')

// Method call: obj.method()
ast.call(node, { object: 'db', method: 'query' })

// Regex on method name: obj.methodAsync(), obj.methodSync()
ast.call(node, { object: 'fs', method: /Sync$/ })
\`\`\`

Returns the match object (truthy) if matched, null if not.

## Suppression in AST aspects

Suppression markers inside comments are honored by the runner:

\`\`\`typescript
// yg-suppress(my-aspect/id) reason here
someCall(); // this line is suppressed

// yg-suppress-disable(my-aspect/id) reason
someCall();
anotherCall();
// yg-suppress-enable(my-aspect/id)
\`\`\`

Wildcard: \`disable(*)\` suppresses all AST aspects in range.

## Purity rule

\`check.mjs\` must not write files, make network calls, or call
\`process.exit\`. The runner does not enforce this — violating it produces
non-deterministic results.

## Testing

\`\`\`bash
yg ast-test --aspect <id> --files src/example.ts
yg ast-test --aspect <id> --node <node-path>
\`\`\`

Exits 1 if violations exist. Use this during development before wiring
the aspect to nodes.

## Example: forbid direct DB import in API layer

\`\`\`javascript
import { ast } from '@chrisdudek/yg/ast';

export function check(ctx) {
  const violations = [];
  for (const file of ctx.files) {
    if (!ast.inFile(file, 'src/api/**')) continue;
    for (const imp of ast.imports(file.ast.rootNode)) {
      if (/^db\\//.test(imp.source)) {
        violations.push(ast.report(file, imp.node, 'API layer cannot import from db/ directly'));
      }
    }
  }
  return violations;
}
\`\`\`
`;
