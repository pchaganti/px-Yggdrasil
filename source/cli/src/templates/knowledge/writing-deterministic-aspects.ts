export const summary =
  'How to write check.mjs for the deterministic reviewer: single-file style (tree-sitter API, helpers, async-fs example) and graph-aware style (ctx surface, allowed reads, three cookbook examples).';

export const content = `# Writing deterministic aspects

A deterministic aspect declares \`reviewer: { type: deterministic }\` and ships
a \`check.mjs\` file. The check runs locally at zero LLM cost and returns a
\`Violation[]\`. Deterministic aspects do not use reviewer tiers —
\`reviewer.tier:\` is rejected together with \`type: deterministic\`.

There are two ways to scope a deterministic aspect:

- **Single-file style** — scope the check to ad-hoc files and inspect each
  file's parsed syntax tree (tree-sitter). Best for per-file syntactic rules:
  forbidden imports, banned API calls, naming conventions, structural shape.
- **Graph-aware style** — scope the check to a graph node and inspect the
  node's files, the file system, and the graph topology through a \`ctx\`
  surface. Best for cross-node consistency rules: file existence, directory
  structure, multi-file consistency, relations between nodes.

Both styles share the same runtime contract: a named export \`check\`, returning
a synchronous \`Violation[]\`. Choose the style that matches the rule's scope.

## The \`yg-aspect.yaml\`

A deterministic aspect's \`yg-aspect.yaml\` declares the reviewer type; the
runner detects each file's language from its extension:

\`\`\`yaml
# .yggdrasil/aspects/my-rule/yg-aspect.yaml
name: MyRule
description: What this rule enforces.
reviewer:
  type: deterministic
\`\`\`

The aspect's identity is its directory path under \`aspects/\` (here
\`my-rule\`) — there is no \`id:\` field; \`name:\` and \`description:\` are
required. There is no \`language:\` field to declare and no \`ctx.language\` —
the runner is language-agnostic.

---

# Single-file style

Use the single-file style when the rule is structural and lives inside one
file at a time:
- Forbidden import paths ("never import from \`db/\` in \`ui/\`")
- Forbidden API calls (\`fs.readFileSync\` banned in async code)
- Naming conventions (exported classes must be PascalCase)
- Structural shape (every exported function must be async)

Use the LLM reviewer for semantic rules that require reading intent.

## Runtime contract

\`\`\`javascript
// check.mjs
export function check(ctx) {
  // ctx.files — array of { path, content, ast }
  //   path:    string source path
  //   content: string raw source text
  //   ast:     tree-sitter Tree — reach the root via file.ast.rootNode
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

The runner raises typed runtime errors when the contract is broken:

| Error code | Cause |
|---|---|
| \`AST_CHECK_FILE_NOT_IN_CONTEXT\` | \`check\` touched a file that is not in \`ctx.files\` |
| \`AST_CHECK_ASYNC\` | \`check\` returned a thenable/Promise — it must be synchronous |
| \`AST_CHECK_RETURN_SHAPE\` | \`check\` returned a non-array — it must return \`Violation[]\` |

## Iterating over the files

A node's mapping may include non-parseable files (e.g. \`.md\`, \`.sh\`,
\`.json\`). For those files \`file.ast\` is \`undefined\`. **Always guard
before touching \`file.ast\`**:

\`\`\`javascript
import { walk, report, inFile, closest } from '@chrisdudek/yg/ast';

export function check(ctx) {
  const violations = [];
  for (const file of ctx.files) {
    if (!file.ast) continue;  // skip non-parseable files (no tree-sitter AST)
    walk(file.ast.rootNode, node => {
      // ... inspect node, push report(file, node, ...) on a hit ...
    });
  }
  return violations;
}
\`\`\`

Content/regex checks that only use \`file.content\` (and never touch
\`file.ast\`) do **not** need this guard — they should iterate all files
including non-parseable ones.

If a rule should apply only to a subset of files, filter on \`file.path\`
(for example with \`inFile(file, { glob: 'src/api/**' })\`) — there is no
\`ctx.language\` and no per-language invocation today; every mapped file
arrives in the one \`check.mjs\` invocation.

## Minimal API — imports from \`@chrisdudek/yg/ast\`

| Export | Signature | Purpose |
|---|---|---|
| \`walk(node, visitor)\` | \`(node, (n) => boolean|void) => void\` | DFS traversal; visitor returning \`false\` skips descent into that subtree |
| \`report(file, node, message)\` | \`(file, TreeNode, string) => Violation\` | Build a \`{ file, line, column, message }\` — \`line\` 1-based, \`column\` 0-based |
| \`inFile(file, pattern)\` | \`(file, { glob } | { regex } | { contains }) => boolean\` | Path filter (discriminated object form) |
| \`findComments(target)\` | \`(file | node) => TreeNode[]\` | Returns comment nodes within the file or subtree |
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
\`node-types.json\` files shipped inside the installed package under
\`dist/grammars/\`.  Each file is named after its grammar:

\`\`\`
<yg install>/dist/grammars/tree-sitter-typescript.node-types.json
<yg install>/dist/grammars/tree-sitter-tsx.node-types.json
<yg install>/dist/grammars/tree-sitter-javascript.node-types.json
<yg install>/dist/grammars/tree-sitter-python.node-types.json
\`\`\`

(and so on for every other shipped grammar — one \`.node-types.json\`
per \`.wasm\` file in the same directory.)

Each entry lists its \`type\`, whether it is \`named\`, and the \`fields\`
object whose keys are the field names usable with \`childForFieldName\`.

## Example: forbid direct DB import in API layer

\`\`\`javascript
import { walk, report, inFile } from '@chrisdudek/yg/ast';

export function check(ctx) {
  const violations = [];
  for (const file of ctx.files) {
    if (!file.ast) continue;  // skip non-parseable files (no tree-sitter AST)
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

## Quick reference — raw tree-sitter API

Common patterns using the direct tree-sitter API:

| Pattern | Code |
|---|---|
| Call expression | \`walk(rootNode, n => n.type === 'call_expression')\` + \`n.childForFieldName('function')\` |
| Import statements | \`walk(rootNode, n => n.type === 'import_statement')\` |
| Export statements | \`walk(rootNode, n => n.type === 'export_statement')\` |
| Decorators on node | \`node.childForFieldName('decorators')?.namedChildren ?? []\` |
| Modifier keywords | inspect leading children for modifier keyword nodes |
| JSX elements | \`walk(rootNode, n => n.type === 'jsx_element' \\|\\| n.type === 'jsx_self_closing_element')\` |
| PascalCase check | \`/^[A-Z][a-zA-Z0-9]*$/.test(name)\` |
| Node name | \`node.childForFieldName('name')?.text\` |
| Walk with function boundary | \`walk(parent, n => { if (n.type === type) ...; if (isFunction(n)) return false; })\` |
| Nearest ancestor | \`closest(node, types)\` — available in minimal API |
| File-path test | \`inFile(file, { glob \\| regex \\| contains })\` |
| Violation shape | \`{ file, line, column, message }\` — \`column\` is 0-based |

---

# Graph-aware style

The graph-aware style checks **graph and file-system shape** — cross-node
consistency rules that cannot be expressed as per-file syntax checks. The
reviewer receives a graph-aware \`ctx\` object: the node's own files, the file
system, the graph, and parsers (\`parseAst\`, \`parseYaml\`, \`parseJson\`,
\`parseToml\`). It does not receive an LLM — all logic is author-written
JavaScript. The runner does not enforce purity; \`check.mjs\` must not write
files, make network calls, or call \`process.exit\` — respecting that is your
responsibility.

The graph-aware style is the right choice when:
- The rule involves relations between nodes, not just code inside one file.
- The rule checks for file existence, directory structure, or multi-file consistency.
- The rule depends on the graph topology (children, ancestors, flow participants, relation targets).

## Minimal example

\`\`\`yaml
# .yggdrasil/aspects/example/yg-aspect.yaml
# (the aspect id is derived from the directory name — there is no 'id:' field)
name: example
description: "Always passes"
reviewer:
  type: deterministic
\`\`\`

\`\`\`javascript
// .yggdrasil/aspects/example/check.mjs
export function check(ctx) {
  return [];
}
\`\`\`

The runner invokes \`check.mjs\` once per affected node, regardless of file
types. Adding \`reviewer.tier:\` is a validator error — tiers apply only to LLM
aspects.

## The ctx surface

\`\`\`typescript
interface Ctx {
  // The node being reviewed
  node: GraphNode;

  // Alias for node.files — own files with child carve-out applied
  files: File[];

  fs: {
    exists(path: string): 'file' | 'dir' | false;
    list(dir: string): FsEntry[];
    read(path: string): string;
  };

  graph: {
    node(id: string): GraphNode | undefined;
    nodesByType(type: string): GraphNode[];
    relationsFrom(node: GraphNode): Relation[];
    relationsTo(node: GraphNode): Relation[];
    children(node: GraphNode): GraphNode[];
    flowParticipants(flowName: string): GraphNode[];
  };

  // Synchronous — pre-warmed by dispatcher (Decision A). Do NOT await.
  parseAst(file: File | string, language: string): unknown;

  parseYaml(file: File | string): unknown;
  parseJson(file: File | string): unknown;
  parseToml(file: File | string): unknown;
}

interface GraphNode {
  id: string;          // node path, e.g. 'billing/cancel'
  type: string;        // node_type id from yg-architecture.yaml
  mapping: string[];   // raw mapping entries from yg-node.yaml
  files: File[];       // materialized files (child carve-out applied for own node)
  ports: Record<string, { description: string; aspects: string[] }>;
}

interface File {
  path: string;    // repo-relative POSIX path
  content: string; // raw file content
}

interface FsEntry {
  name: string;        // basename only, e.g. 'foo.ts'
  kind: 'file' | 'dir';
}

interface Violation {
  message: string;
  file?: string;    // repo-relative POSIX path
  line?: number;    // 1-based
  column?: number;  // 0-based
  kind?: string;    // do NOT use 'structure-aspect-*' prefix — reserved for runtime
}
\`\`\`

## parseAst is synchronous

\`ctx.parseAst(file, language)\` returns the parsed tree synchronously. It does
not return a Promise and must not be awaited. The dispatcher pre-warms the AST
cache before invoking \`check(ctx)\`. This mirrors the single-file runner's approach.

\`\`\`javascript
// Correct:
const tree = ctx.parseAst(file, 'typescript');

// Wrong — do NOT do this:
// const tree = await ctx.parseAst(file, 'typescript');
\`\`\`

If \`parseAst\` is called on a file outside the pre-warmed set, the runtime throws
a violation with \`kind: 'structure-aspect-parseast-not-prewarmed'\`. This means
the file is not in the aspect's allowed reads set — see the section below.

For structured data files, prefer \`ctx.parseYaml\`, \`ctx.parseJson\`, or
\`ctx.parseToml\` — these are also synchronous without any pre-warming requirement.

## Allowed reads set (D9=A)

The graph-aware runner enforces a strict read boundary. Attempting to read outside
it throws a runtime violation instead of returning data.

This boundary is a read **discipline**, not a security sandbox. \`check.mjs\` runs
in the main Node process with full privileges — an adversarial check could still
write files or open sockets; the runner does not prevent it. The allow-list scopes
which files count as *tracked dependencies* for drift, not what the process is
capable of. Only run aspects you trust.

Paths in the allowed reads set for a node:

- **Own mapping** — files matching the node's \`mapping:\` entries, child carve-out applied.
- **Declared relation targets** — for each relation in \`yg-node.yaml\`, the target
  node's mapping files and their transitive descendants.
- **Ancestor mappings** — files belonging to parent and grandparent nodes.
- **Own descendant mappings** — files belonging to any child or deeper descendant node.

Accessing anything outside this set produces:

| Violation kind | Trigger |
|---|---|
| \`structure-aspect-undeclared-fs-read\` | \`ctx.fs.exists/list/read\` on a path outside the allowed set |
| \`structure-aspect-undeclared-graph-read\` | \`ctx.graph.node/nodesByType\` returning a node outside the allowed set |
| \`structure-aspect-parseast-not-prewarmed\` | \`ctx.parseAst\` on a file not in the pre-warmed set |

If your check needs to reach a node not currently in scope, add an explicit
relation in \`yg-node.yaml\` pointing to that node. Relations are the contract
that widens the allowed reads set.

The allowed reads set is the access *boundary* — the maximum the check is
permitted to touch. The **drift baseline** is narrower: it is the set of files
the check actually touched (read) at this run, recorded at approve time. Only a
later change to one of those actually-read files causes cascade drift and
re-approval — not every file the boundary would have allowed. Keep checks
focused: reading fewer files yields a tighter baseline and less spurious drift.

## Reserved violation kinds

The \`structure-aspect-*\` prefix is reserved for runtime-emitted violations. Author
code must NOT emit violations with this prefix. Use a plain \`kind\` or omit
\`kind\` entirely for author-defined violations.

Common runtime kinds (for reference, not for author use):

- \`structure-aspect-undeclared-fs-read\`
- \`structure-aspect-undeclared-graph-read\`
- \`structure-aspect-parseast-not-prewarmed\`

## Common helpers

The same single-file helpers are re-exported from
\`@chrisdudek/yg/structure\`. These are useful when your check also inspects
parsed AST trees via \`ctx.parseAst\`:

| Export | Signature | Purpose |
|---|---|---|
| \`walk(node, visitor)\` | \`(node, (n) => boolean|void) => void\` | DFS traversal; visitor returning \`false\` skips subtree |
| \`closest(node, types)\` | \`(TreeNode, string[]) => TreeNode | null\` | Nearest ancestor of one of the given types |
| \`report(file, node, message)\` | \`(file, TreeNode, string) => Violation\` | Build \`{ file, line, column, message }\` — line 1-based, column 0-based |
| \`inFile(file, pattern)\` | \`(file, { glob } | { regex } | { contains }) => boolean\` | Path filter |
| \`findComments(target)\` | \`(file | node) => TreeNode[]\` | Returns comment nodes |

These helpers are optional — most graph-aware checks work purely with \`ctx.graph\`
and \`ctx.fs\` without parsing AST trees at all.

## Cookbook

### Cookbook 1: sibling-test-file

Every node of type \`command\` must have a sibling test in a separate test-suite
node. The command node reaches that node through a declared relation — the
cross-node lookup a single-file check cannot express. Declare it in
the command node's \`yg-node.yaml\`: \`relations: [{ type: uses, target: tests/unit }]\`.

\`\`\`javascript
// .yggdrasil/aspects/sibling-test-file/check.mjs
export function check(ctx) {
  const violations = [];
  const sourceFile = ctx.node.files[0];
  if (!sourceFile) return violations;
  const stem = sourceFile.path.split('/').pop().replace(/\\.ts$/, '');
  const expected = \`/\${stem}.test.ts\`;

  // Reach the test-suite node via the declared relation. ctx.graph.node throws
  // if the target is outside the allowed read boundary (reachable only via
  // ancestors, own descendants, or a declared relation) — surface that as an
  // actionable fix.
  let testSuite;
  try {
    testSuite = ctx.graph.node('tests/unit');
  } catch {
    violations.push({
      file: sourceFile.path,
      message: "Cannot reach 'tests/unit' — add relations: [{ type: uses, target: tests/unit }] to this node's yg-node.yaml.",
      line: 1,
      column: 1,
    });
    return violations;
  }
  if (!testSuite) return violations; // reachable but not present — nothing to check

  // Walk the suite node and its child nodes; check the sibling test exists.
  const tests = collectFiles(testSuite, ctx);
  if (!tests.some(f => f.path.endsWith(expected))) {
    violations.push({
      file: sourceFile.path,
      message: \`Missing sibling test '\${stem}.test.ts' under tests/unit/.\`,
      line: 1,
      column: 1,
    });
  }
  return violations;
}

function collectFiles(node, ctx) {
  const out = [...node.files];
  for (const child of ctx.graph.children(node)) out.push(...collectFiles(child, ctx));
  return out;
}
\`\`\`

The relation is what makes the test-suite node reachable: \`ctx.graph\` exposes only
this node, its ancestors, and nodes it declares a relation to. Reaching a sibling
subtree (the test suite) therefore requires the explicit \`uses\` relation — that is
the contract a graph-aware check enforces and a single-file check cannot.

### Cookbook 2: knowledge-topic-consistency

Every knowledge topic file in \`templates/knowledge/*.ts\` must be registered in
\`templates/knowledge/index.ts\`. Uses \`ctx.fs.list\` and \`ctx.fs.read\`.

\`\`\`javascript
// .yggdrasil/aspects/knowledge-topic-consistency/check.mjs
export function check(ctx) {
  const violations = [];
  const dir = 'source/cli/src/templates/knowledge';
  const entries = ctx.fs.list(dir);
  const topicFiles = entries
    .filter(e => e.kind === 'file' && e.name.endsWith('.ts') && e.name !== 'index.ts')
    .map(e => e.name.replace(/\\.ts$/, ''));
  const indexContent = ctx.fs.read(\`\${dir}/index.ts\`);
  for (const topic of topicFiles) {
    if (!indexContent.includes(topic)) {
      violations.push({
        message: \`Knowledge topic '\${topic}' not registered in index.ts\`,
        file: \`\${dir}/index.ts\`,
        line: 1,
        column: 1,
      });
    }
  }
  return violations;
}
\`\`\`

Both the knowledge topic files and \`index.ts\` must be in the allowed reads set.
Because they are all mapped to the same node, the own mapping channel covers them.

### Cookbook 3: child-type composition

Every child of a node of type \`engine\` must itself be of type \`engine-component\`.
Uses \`ctx.graph.children\`.

\`\`\`javascript
// .yggdrasil/aspects/engine-composition/check.mjs
export function check(ctx) {
  const violations = [];
  if (ctx.node.type !== 'engine') return violations;
  for (const child of ctx.graph.children(ctx.node)) {
    if (child.type !== 'engine-component') {
      violations.push({
        message: \`Engine '\${ctx.node.id}' has child '\${child.id}' of type '\${child.type}'; expected 'engine-component'.\`,
      });
    }
  }
  return violations;
}
\`\`\`

Child nodes are always in the own descendant mappings channel — no additional
relation declarations are required to access them via \`ctx.graph.children\`.

---

## Testing with yg deterministic-test

Run a deterministic aspect's \`check.mjs\` without recording a baseline or
triggering drift. Scope it either to a graph node or to ad-hoc files:

\`\`\`bash
# Graph-scoped: run the check against a named node
yg deterministic-test --aspect sibling-test-file --node orders/handler

# Ad-hoc: run the check against specific files
yg deterministic-test --aspect no-sync-fs --files src/orders/handler.ts src/other.ts

# Verify the check is deterministic (same violations on every run)
yg deterministic-test --aspect sibling-test-file --node orders/handler --check-determinism
\`\`\`

Exits 1 if violations exist. Use during \`check.mjs\` development before
attaching the aspect to nodes. Run against both compliant and non-compliant
inputs to confirm no false positives and no false negatives.
\`--check-determinism\` runs the check twice and fails if the violation sets
differ, catching side effects in \`check.mjs\`.

## Purity rule

The check function is deterministic and synchronous. Across the single-file and
graph-aware styles the same purity requirements hold:

- Named export \`check\`, synchronous. No \`async\`, no \`Promise\`.
- Do not write files, make network calls, or call \`process.exit\`.
- Read only within the allowed reads set (graph-aware) or \`ctx.files\`
  (single-file) — reaching outside throws a runtime violation.

Respecting purity keeps the check reproducible: the same inputs must always
yield the same violations, which is what \`--check-determinism\` verifies.

## Suppression in deterministic aspects

\`\`\`typescript
// yg-suppress(my-aspect/id) reason — suppresses following line
someCall();

// yg-suppress-disable(my-aspect/id) reason
someCall();
// yg-suppress-enable(my-aspect/id)

// yg-suppress-disable(*) reason — all deterministic aspects in range
// yg-suppress-enable(*)
\`\`\`

A specific \`enable(<id>)\` does NOT punch through \`disable(*)\`.
Full delimiter table and multi-language bracket syntax: \`yg knowledge read suppress-syntax\`.

## Adoption workflow

Deterministic aspects follow the same three-level status as LLM aspects:

- **draft** — \`check.mjs\` is never invoked. Zero cost. Use while authoring.
- **advisory** — \`check.mjs\` runs; violations render as warnings. Does not block CI.
- **enforced** — \`check.mjs\` runs; violations block \`yg check\`. Default.

Recommended path: start at \`draft\`, iterate until the check returns correct
violations on test inputs, promote to \`advisory\` to gather signal across the
repo, then promote to \`enforced\` when the rule is confirmed stable.

For full status mechanics: \`yg knowledge read aspect-status\`.
`;
