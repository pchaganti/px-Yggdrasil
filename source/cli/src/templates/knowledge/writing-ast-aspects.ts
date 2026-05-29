export const summary = 'How to write check.mjs for AST reviewer: runtime contract, tree-sitter API, multi-language dispatch, migration from removed helpers';

export const content = `# Writing AST aspects

AST aspects declare \`reviewer: { type: ast }\` and ship a \`check.mjs\` file.
The check function is deterministic, synchronous, and costs zero LLM calls.
AST aspects do not use reviewer tiers — \`reviewer.tier:\` is rejected
together with \`type: ast\`.

## When to use AST

Use AST when the rule is structural:
- Forbidden import paths ("never import from \`db/\` in \`ui/\`")
- Forbidden API calls (\`fs.readFileSync\` banned in async code)
- Naming conventions (exported classes must be PascalCase)
- Structural shape (every exported function must be async)

Use LLM for semantic rules that require reading intent.

## Required: \`language:\` field in yg-aspect.yaml

Every AST aspect must declare the languages it handles:

\`\`\`yaml
# .yggdrasil/aspects/my-rule/yg-aspect.yaml
name: MyRule
description: What this structural rule enforces.
reviewer:
  type: ast
language: [typescript, tsx, javascript]
\`\`\`

The aspect's identity is its directory path under \`aspects/\` (here
\`my-rule\`) — there is no \`id:\` field; \`name:\` and \`description:\` are
required.

The runner invokes \`check.mjs\` once per declared language, passing only the
files for that language via \`ctx.language\` and \`ctx.files\`. Four validator
errors enforce the shape:

| Error code | Cause |
|---|---|
| \`aspect-ast-missing-language\` | \`language:\` field absent |
| \`aspect-language-not-array\` | value is not a list |
| \`aspect-empty-language-list\` | list is empty |
| \`aspect-unknown-language\` | id not in language registry |

## Runtime contract

\`\`\`javascript
// check.mjs
export function check(ctx) {
  // ctx.language  — string id of the current language (e.g. 'typescript')
  // ctx.files     — array of { path: string, ast: { rootNode } }
  const violations = [];
  // ... inspect each file ...
  return violations;  // Violation[] — synchronous only
}
\`\`\`

Rules:
- Named export \`check\`, synchronous. No \`async\`, no \`Promise\`.
- Return an array of \`{ file, line, column, message }\` objects (use \`report()\`).
- Do not write files, make network calls, or call \`process.exit\`.
- Do not access \`ctx.files\` of a file not in \`ctx.files\` — runtime error
  \`AST_CHECK_FILE_NOT_IN_CONTEXT\`.

## Dispatch pattern for multiple languages

When behaviour differs per language, switch on \`ctx.language\`:

\`\`\`javascript
import { walk, report, inFile, closest } from '@chrisdudek/yg/ast';

export function check(ctx) {
  switch (ctx.language) {
    case 'typescript':
    case 'tsx':
      return checkTs(ctx);
    case 'javascript':
      return checkJs(ctx);
    default:
      // Always include a default — future registry expansions may pass
      // an unexpected language id if the aspect yaml is updated before
      // check.mjs is.
      return [];
  }
}
\`\`\`

## Minimal API — imports from \`@chrisdudek/yg/ast\`

| Export | Signature | Purpose |
|---|---|---|
| \`walk(node, visitor)\` | \`(node, (n) => boolean|void) => void\` | DFS traversal; visitor returning \`false\` skips descent into that subtree |
| \`report(file, node, message)\` | \`(file, TreeNode, string) => Violation\` | Build a \`{ file, line, column, message }\` — \`line\` 1-based, \`column\` 0-based |
| \`inFile(file, pattern)\` | \`(file, { glob } | { regex } | { contains }) => boolean\` | Path filter (discriminated object form) |
| \`findComments(target)\` | \`(file | node) => TreeNode[]\` | Returns comment nodes; reads comment node types from language registry |
| \`closest(node, types)\` | \`(TreeNode, string[]) => TreeNode | null\` | Nearest ancestor whose \`type\` is in \`types\` |

## tree-sitter node API

Each \`node\` object from the AST exposes:

| Property / method | Type | Notes |
|---|---|---|
| \`node.type\` | \`string\` | Grammar node type (e.g. \`'call_expression'\`) |
| \`node.text\` | \`string\` | Raw source text of the node |
| \`node.namedChildren\` | \`TreeNode[]\` | Named (non-anonymous) children |
| \`node.childForFieldName(name)\` | \`TreeNode | null\` | Child at a named grammar field |
| \`node.startPosition\` | \`{ row: number, column: number }\` | Zero-based row and column |
| \`node.parent\` | \`TreeNode | null\` | Parent node |

### Reading node-types.json

To learn the grammar's node types and field names, inspect the
\`node-types.json\` shipped by the tree-sitter grammar package:

\`\`\`
node_modules/tree-sitter-typescript/typescript/node-types.json
node_modules/tree-sitter-javascript/node-types.json
\`\`\`

Each entry lists its \`type\`, whether it is \`named\`, and the \`fields\`
object whose keys are the field names usable with \`childForFieldName\`.

## Example: forbid direct DB import in API layer

\`\`\`javascript
import { walk, report, inFile } from '@chrisdudek/yg/ast';

export function check(ctx) {
  const violations = [];
  for (const file of ctx.files) {
    if (!inFile(file, { glob: 'src/api/**' })) continue;
    walk(file.ast.rootNode, node => {
      if (node.type !== 'import_statement') return;
      const source = node.childForFieldName('source');
      if (source && /^\\"db\\//.test(source.text)) {
        violations.push(report(file, node, 'API layer cannot import from db/ directly'));
      }
    });
  }
  return violations;
}
\`\`\`

## Testing with yg ast-test

\`\`\`bash
yg ast-test --aspect <id> --files src/example.ts src/other.ts
yg ast-test --aspect <id> --node <node-path>
\`\`\`

Exits 1 if violations exist. Use during \`check.mjs\` development before
wiring the aspect to nodes. Run against both violating and non-violating
files to confirm no false positives.

## Suppression in AST aspects

\`\`\`typescript
// yg-suppress(my-aspect/id) reason — suppresses following line
someCall();

// yg-suppress-disable(my-aspect/id) reason
someCall();
// yg-suppress-enable(my-aspect/id)

// yg-suppress-disable(*) reason — all AST aspects in range
// yg-suppress-enable(*)
\`\`\`

A specific \`enable(<id>)\` does NOT punch through \`disable(*)\`.
Full delimiter table and multi-language bracket syntax: \`yg knowledge read suppress-syntax\`.

## Migration table — removed helpers → raw tree-sitter

The old \`ast.*\` namespace helpers were removed. Use direct tree-sitter API:

| Removed | Replacement |
|---|---|
| \`ast.call(node, { object: 'fs', method: 'readFileSync' })\` | \`walk(rootNode, n => n.type === 'call_expression')\` + \`n.childForFieldName('function')\` |
| \`ast.imports(rootNode)\` | \`walk(rootNode, n => n.type === 'import_statement')\` |
| \`ast.exports(rootNode)\` | \`walk(rootNode, n => n.type === 'export_statement')\` |
| \`ast.decoratorsOf(node)\` | \`node.childForFieldName('decorators')?.namedChildren ?? []\` |
| \`ast.modifiersOf(node)\` | inspect leading children for modifier keywords |
| \`ast.jsxElements(rootNode)\` | \`walk(rootNode, n => n.type === 'jsx_element' \\|\\| n.type === 'jsx_self_closing_element')\` |
| \`ast.casing.pascal(name)\` | \`/^[A-Z][a-zA-Z0-9]*$/.test(name)\` |
| \`ast.nameOf(node)\` | \`node.childForFieldName('name')?.text\` |
| \`ast.within(parent, type, opts)\` | \`walk(parent, n => { if (n.type === type) ...; if (!opts.crossFunctions && isFunction(n)) return false; })\` |
| \`ast.closest(node, types)\` | \`closest(node, types)\` — RETAINED in minimal API |
| \`ast.inFile(file, '<string>')\` | \`inFile(file, { glob \\| regex \\| contains })\` |
| violation shape: \`{ file, line, message }\` | \`{ file, line, column, message }\` — NEW \`column\` field |

## Aspect status

AST aspects also declare \`status: draft | advisory | enforced\` (default
\`enforced\`). Draft AST aspects cost zero — the \`check.mjs\` function is
never invoked. Advisory and enforced both run the check synchronously (no
LLM cost) but differ in how violations render. An aspect in draft status
is useful for development and review purposes without blocking CI. See:
\`yg knowledge read aspect-status\`.
`;
