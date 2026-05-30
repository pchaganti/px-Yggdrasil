export const summary =
  'How to write check.mjs for structure reviewer: ctx surface, allowed-reads set, draft→advisory→enforced workflow, and three cookbook examples.';

export const content = `# Writing Structure Aspects

Structure aspects declare \`reviewer: { type: structure }\` and ship a \`check.mjs\` file.
The check function is deterministic, synchronous, and costs zero LLM calls.

## Minimal example

\`\`\`yaml
# .yggdrasil/aspects/example/yg-aspect.yaml
# (the aspect id is derived from the directory name — there is no 'id:' field)
name: example
description: "Always passes"
reviewer:
  type: structure
\`\`\`

\`\`\`javascript
// .yggdrasil/aspects/example/check.mjs
export function check(ctx) {
  return [];
}
\`\`\`

## What is a structure aspect

A structure aspect checks **graph and file-system shape** — cross-node consistency
rules that cannot be expressed as per-file syntax checks. The reviewer receives a
graph-aware \`ctx\` object: the node's own files, the file system, the graph, and
parsers (\`parseAst\`, \`parseYaml\`, \`parseJson\`, \`parseToml\`). It does not receive
an LLM — all logic is author-written JavaScript. The runner does not enforce
purity; \`check.mjs\` must not write files, make network calls, or call
\`process.exit\` — respecting that is your responsibility.

## Reviewer type decision tree

| Reviewer | When to use |
|---|---|
| LLM | Subjective rules requiring judgment ("audit log messages must be meaningful") |
| AST | Per-file syntactic rules ("no imports from \`internal/*\`") |
| Structure | Graph or file-system shape rules ("every command node must have a sibling test file"; "every child of an engine node must be of type engine-component") |

Structure is the right choice when:
- The rule involves relations between nodes, not just code inside one file.
- The rule checks for file existence, directory structure, or multi-file consistency.
- The rule depends on the graph topology (children, ancestors, flow participants, relation targets).

## No \`language:\` field

Structure aspects declare no \`language:\` field — they are language-agnostic.
The runner invokes \`check.mjs\` once per affected node, regardless of file types.
Adding \`reviewer.tier:\` to a structure aspect is also a validator error — tiers
apply only to LLM aspects.

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
cache before invoking \`check(ctx)\`. This mirrors the AST aspect runner's approach.

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

The structure runner enforces a strict read boundary. Attempting to read outside
it throws a runtime violation instead of returning data.

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

The same helpers available in AST aspects are re-exported from
\`@chrisdudek/yg/structure\`. These are useful when your check also inspects
parsed AST trees via \`ctx.parseAst\`:

| Export | Signature | Purpose |
|---|---|---|
| \`walk(node, visitor)\` | \`(node, (n) => boolean|void) => void\` | DFS traversal; visitor returning \`false\` skips subtree |
| \`closest(node, types)\` | \`(TreeNode, string[]) => TreeNode | null\` | Nearest ancestor of one of the given types |
| \`report(file, node, message)\` | \`(file, TreeNode, string) => Violation\` | Build \`{ file, line, column, message }\` — line 1-based, column 0-based |
| \`inFile(file, pattern)\` | \`(file, { glob } | { regex } | { contains }) => boolean\` | Path filter |
| \`findComments(target)\` | \`(file | node) => TreeNode[]\` | Returns comment nodes |

These helpers are optional — most structure checks work purely with \`ctx.graph\`
and \`ctx.fs\` without parsing AST trees at all.

## Adoption workflow

Structure aspects follow the same three-level status as LLM and AST aspects:

- **draft** — \`check.mjs\` is never invoked. Zero cost. Use while authoring.
- **advisory** — \`check.mjs\` runs; violations render as warnings. Does not block CI.
- **enforced** — \`check.mjs\` runs; violations block \`yg check\`. Default.

Recommended path: start at \`draft\`, iterate until the check returns correct
violations on test nodes, promote to \`advisory\` to gather signal across the
repo, then promote to \`enforced\` when the rule is confirmed stable.

For full status mechanics: \`yg knowledge read aspect-status\`.

## Authoring loop

\`\`\`bash
# Test the check function against a specific node without wiring the aspect
yg structure-test --aspect <id> --node <path>

# Verify the check is deterministic (same violations on every run)
yg structure-test --aspect <id> --node <path> --check-determinism
\`\`\`

Exits 1 if violations exist. Use during \`check.mjs\` development before
attaching the aspect to nodes. Run against both compliant and non-compliant
nodes to confirm no false positives and no false negatives.

---

## Cookbook

### Cookbook 1: sibling-test-file

Every node of type \`command\` must have a sibling test in a separate test-suite
node. The command node reaches that node through a declared relation — the
cross-node lookup an AST aspect on a single file cannot express. Declare it in
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
  // if this node has no relation reaching it — surface that as an actionable fix.
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
the contract a structure aspect enforces and an AST aspect cannot.

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
`;
