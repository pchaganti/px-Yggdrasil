# Aspect Reviewers

Aspects are verified by reviewers. Yggdrasil ships three reviewer types — all operate on the same aspect-node-flow graph; the `reviewer` field in `yg-aspect.yaml` selects which one runs.

- **LLM reviewer** (`reviewer: { type: llm }`): ships a `content.md` rule file. An LLM reads the rule and the node's source code, then accepts or rejects.
- **AST reviewer** (`reviewer: { type: ast }`): ships a `check.mjs` module. A deterministic runner parses the source files with tree-sitter and executes your `check` function against the AST.
- **Structure reviewer** (`reviewer: { type: structure }`): ships a `check.mjs` module that runs in a sandboxed context (`ctx`) with read access to the node's own files plus, through declared relations, related nodes' files and graph metadata. Use it for cross-node structural rules a single-file AST check cannot express. See `yg knowledge read writing-structure-aspects`.

A `content.md` (LLM) and a `check.mjs` (AST or structure) are mutually exclusive — exactly one must be present per aspect, and `reviewer.type` selects which runner consumes the `check.mjs`. `yg check` enforces this. Both AST and structure aspects run locally at zero LLM cost.

---

## Choosing a reviewer

| Reviewer | Use when the rule is… | Examples |
|---|---|---|
| **AST** | a per-file **syntactic** check | Forbidden API calls (`fs.readFileSync`, `eval`); naming conventions (PascalCase exports); import restrictions (no cross-module relatives); missing guards (`@Log` decorator required) |
| **Structure** | a **graph or file-system shape** check spanning more than one file | "Every command node has a sibling test file"; "every child of an engine node is of type engine-component"; "every knowledge topic is registered in the index" |
| **LLM** | a **semantic judgment** a human reviewer would read surrounding context to make | "Mutations must emit audit events"; "Error responses must follow the API contract"; "Business logic must respect rounding rules"; "This handler must validate input semantically" |

If you can write a regex or an AST traversal over a single file to verify the rule, use AST. If the rule depends on graph topology or multi-file consistency that a single-file check cannot express, use structure. If a human reviewer would need to read surrounding context to decide, use LLM. AST and structure both run locally at zero LLM cost; only the LLM reviewer makes paid calls.

`reviewer.type` is **required** on every aspect — there is no implicit default. LLM aspects may also declare `reviewer.tier:` to opt into a specific tier from `yg-config.yaml` — see [Reviewer tiers](./configuration.md#reviewer-tiers) for tier configuration.

---

## LLM reviewer

The LLM reviewer is a separate LLM call from the coding agent — one LLM verifying the work of another. `yg approve` sends each aspect's `content.md` plus the relevant source files to the reviewer. The LLM reviewer also receives any reference files declared on the aspect, presented as authoritative context (not under review). The reviewer responds with SATISFIED or NOT SATISFIED per aspect. Each effective non-draft LLM aspect on a node costs at least one reviewer call during `yg approve`, multiplied by the tier's consensus count and by the number of prompt chunks.

**Effective-draft aspects are skipped before dispatch.** When an aspect's effective status on a node is `draft`, `yg approve` prints a skip line and never sends the rule to the reviewer — zero cost, zero verdict. Aspects with effective status `advisory` or `enforced` go through the reviewer normally; the level only changes how a refused verdict surfaces in `yg check` (warning vs. error). See [Aspect Status](/aspect-status) for the lifecycle.

### Directory structure

```
.yggdrasil/aspects/
  requires-audit/
    yg-aspect.yaml       ← reviewer: { type: llm }
    content.md           ← the rule, in plain Markdown
```

### `yg-aspect.yaml`

```yaml
name: Audit Logging
description: "Every mutation must emit an audit event"
reviewer:
  type: llm
```

### Writing `content.md`

Write rules the way you would write a code review comment — clear, specific, actionable.

```markdown
<!-- .yggdrasil/aspects/requires-audit/content.md -->
Every public mutation endpoint must emit an audit event before returning.

Use the shared `auditLog.emit()` utility. Do not build custom audit logic.
The event must include: user ID, action, timestamp, affected resource ID.
```

**Effective `content.md` is specific, not aspirational:**

- ✅ "Use `auditLog.emit()` before return. Event must include userId, action, timestamp, resourceId."
- ❌ "Audit logging should be appropriate and comprehensive."

The reviewer compares text against code. Vague rules produce vague verdicts; specific rules produce reproducible verdicts.

### Output and false positives

```text
$ yg approve --node payments

ERROR: Reviewer found aspect violations.
  requires-audit — chargeCard() does not emit an audit event.
    No call to auditLog.emit() found in any mutation path.
  Fix the violations and re-run: yg approve --node payments
```

If the reviewer rejects compliant code, the fix is improving the aspect's `content.md` — make the rule clearer and more specific. The escape hatch is better rules, not bypassing enforcement.

### Cost

A typical approve for a node with 3 aspects and 5 source files makes 3 LLM calls. Using a fast model (Haiku, GPT-4o-mini, Gemini Flash) keeps cost under a few cents per approval. For local review, Ollama runs on your machine with no API cost. See [Configuration](/configuration) for provider setup.

### Consensus

Set `consensus: 3` (or any odd number) on a tier in `yg-config.yaml` to run multiple review passes and take the majority vote. Higher confidence, proportionally higher cost. Useful for high-stakes aspects or noisy borderline rules.

```yaml
reviewer:
  tiers:
    thorough:
      provider: anthropic
      consensus: 3          # majority vote — 2 of 3 must agree
      config:
        model: claude-opus-4-7
```

---

## AST reviewer

The AST reviewer is deterministic. The runner parses each source file with tree-sitter and calls your `check(ctx)` function with the parse tree. Whatever `Violation[]` you return is the verdict — no LLM, no nondeterminism, no per-call cost.

### Directory structure

```
.yggdrasil/aspects/
  async-fs/
    yg-aspect.yaml       ← reviewer: { type: ast }
    check.mjs            ← your check function
```

### `yg-aspect.yaml`

```yaml
name: No Sync FS
description: Forbid synchronous fs calls — use async equivalents
reviewer:
  type: ast
language: [typescript, tsx, javascript]
```

The `reviewer.type: ast` and `language:` fields are required. Today the runner parses each source file by extension (the TypeScript/JavaScript family) and passes all files to a single `check.mjs` invocation — per-language dispatch and file filtering are designed but not yet built. Everything else (`implies`, `when`, `aspects` on nodes) works identically across all reviewer types.

### Writing `check.mjs`

```javascript
// check.mjs — must export a named 'check' function (not default)
import { walk, report, inFile } from '@chrisdudek/yg/ast';

export function check(ctx) {
  const violations = [];
  // ctx.files — the node's source files, each with a tree-sitter parse tree
  // ... examine ctx.files ...
  return violations;   // return Violation[], synchronous
}
```

`ctx` has shape:

```typescript
interface CheckContext {
  files: SourceFile[];
}

interface SourceFile {
  path: string;       // relative to project root
  content: string;    // raw file content
  ast: Tree;          // tree-sitter parse tree
}

interface Violation {
  file: string;       // relative to project root
  line: number;       // 1-based
  column: number;     // 0-based
  message: string;
}
```

### End-to-end example — async-fs

```javascript
// .yggdrasil/aspects/async-fs/check.mjs
import { walk, report } from '@chrisdudek/yg/ast';

export function check(ctx) {
  const violations = [];
  for (const file of ctx.files) {
    walk(file.ast.rootNode, node => {
      if (node.type !== 'call_expression') return;
      const fn = node.childForFieldName('function');
      if (fn?.type !== 'member_expression') return;
      const obj = fn.childForFieldName('object');
      const prop = fn.childForFieldName('property');
      if (obj?.text === 'fs' && /Sync$/.test(prop?.text ?? '')) {
        violations.push(report(file, node, `fs.${prop.text} is synchronous — use async equivalent`));
      }
    });
  }
  return violations;
}
```

This flags any call matching `fs.<anythingSync>()` anywhere in the files, across function boundaries.

### Minimal API

Five exports are available from `@chrisdudek/yg/ast` — no installation required. If `yg` works on the machine, the import resolves at runtime.

```javascript
import { walk, report, inFile, findComments, closest } from '@chrisdudek/yg/ast';

walk(node, visitor)           // DFS traversal; visitor returning false skips subtree
report(file, node, message)   // create a Violation — line 1-based, column 0-based
inFile(file, { glob })        // path filter: { glob }, { regex }, or { contains }
inFile(file, { regex })
inFile(file, { contains })
findComments(target)          // comment nodes for a file or subtree
closest(node, types)          // nearest ancestor whose type is in the array
```

Use direct tree-sitter node properties for everything else:

```javascript
node.type                        // grammar node type string
node.text                        // raw source text
node.namedChildren               // named children array
node.childForFieldName('name')   // child at a named grammar field
node.startPosition               // { row, column } — zero-based
node.parent                      // parent node
```

Full type signatures are in the CLI's `dist/ast.d.ts`. Locally installed users get editor completion automatically; global/npx users get runtime resolution.

### Worked example — before and after

**Rule:** no array-mutation methods called on function parameters.

**Without helpers** (~30 lines):

```javascript
const fnTypes = ['function_declaration', 'function_expression', 'arrow_function', 'method_definition'];
for (const fnType of fnTypes) {
  for (const fn of file.ast.rootNode.descendantsOfType(fnType)) {
    const params = new Set();
    for (const p of (fn.childForFieldName('parameters')?.namedChildren ?? [])) {
      const id = p.childForFieldName('pattern') ?? p.namedChildren[0];
      if (id?.type === 'identifier') params.add(id.text);
    }
    for (const call of fn.descendantsOfType('call_expression')) {
      const fn2 = call.childForFieldName('function');
      if (fn2?.type !== 'member_expression') continue;
      const obj = fn2.childForFieldName('object');
      const prop = fn2.childForFieldName('property');
      if (obj?.type === 'identifier' && params.has(obj.text) &&
          /^(push|splice|pop|sort|reverse)$/.test(prop?.text ?? '')) {
        violations.push({ file: file.path, line: call.startPosition.row + 1, message: '...' });
      }
    }
  }
}
```

**With minimal API** (~10 lines):

```javascript
import { walk, report } from '@chrisdudek/yg/ast';

walk(file.ast.rootNode, fn => {
  if (fn.type !== 'function_declaration') return;
  const params = collectParamNames(fn);
  walk(fn, callNode => {
    if (callNode.type !== 'call_expression') return;
    const fnNode = callNode.childForFieldName('function');
    if (fnNode?.type !== 'member_expression') return;
    const obj = fnNode.childForFieldName('object');
    const prop = fnNode.childForFieldName('property');
    if (obj?.type === 'identifier' && params.has(obj.text) &&
        /^(push|splice|pop|sort|reverse)$/.test(prop?.text ?? '')) {
      violations.push(report(file, callNode, `Mutating parameter via .${prop?.text}() is forbidden`));
    }
  });
});
```

### Purity rule

`check.mjs` must be pure: **no file writes, no network calls, no `process.exit`**. The runner does not sandbox or enforce this; respecting it is your responsibility. Impure checks produce non-deterministic results and can corrupt the project.

### Testing AST aspects

```bash
# Verify an aspect against specific files (no graph attachment, no baseline)
yg ast-test --aspect async-fs --files src/utils/config.ts

# Use a node's mapping as the file list
yg ast-test --aspect async-fs --node orders/order-service
```

`yg ast-test` exits 0 for clean, 1 for violations. Output:

```text
src/utils/config.ts
  L12: fs.readFileSync is synchronous — use async equivalent
```

---

## Structure reviewer

The structure reviewer is deterministic and language-agnostic. Like the AST reviewer it ships a `check.mjs` module and runs locally at zero LLM cost, but instead of a single file's parse tree it receives a graph-aware `ctx` object — the node being reviewed, its files, the file system, and the graph topology. Use it for cross-node structural rules a single-file AST check cannot express: "every command node has a sibling test file", "every child of an engine node is of type engine-component", "every knowledge topic is registered in the index". See `yg knowledge read writing-structure-aspects`.

### Directory structure

```
.yggdrasil/aspects/
  sibling-test-file/
    yg-aspect.yaml       ← reviewer: { type: structure }
    check.mjs            ← your check function
```

### `yg-aspect.yaml`

```yaml
name: sibling-test-file
description: "Every command node must have a sibling test file"
reviewer:
  type: structure
```

Structure aspects do NOT declare a `language:` array — the runner invokes `check.mjs` once per affected node regardless of file types. Setting `reviewer.tier:` on a structure aspect is a validator error; tiers apply only to LLM aspects.

### Writing `check.mjs`

The `check(ctx)` function is synchronous and returns `Violation[]`. The `ctx` object exposes the graph and the file system rather than a single parse tree:

```typescript
interface Ctx {
  node: GraphNode;     // the node being reviewed
  files: File[];       // alias for node.files — own files with child carve-out applied

  fs: {
    exists(path: string): 'file' | 'dir' | false;
    list(dir: string): { name: string; kind: 'file' | 'dir' }[];
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

  // Synchronous — pre-warmed by the dispatcher. Do NOT await.
  parseAst(file: File | string, language: string): unknown;
  parseYaml(file: File | string): unknown;
  parseJson(file: File | string): unknown;
  parseToml(file: File | string): unknown;
}

interface Violation {
  message: string;
  file?: string;    // repo-relative POSIX path
  line?: number;    // 1-based
  column?: number;  // 0-based
}
```

The same helper exports available to AST aspects (`walk`, `report`, `inFile`, `closest`, `findComments`) are re-exported from `@chrisdudek/yg/structure` for checks that also inspect parsed trees via `ctx.parseAst`. Most structure checks work purely with `ctx.graph` and `ctx.fs` without parsing any AST.

### Allowed reads

The structure runner enforces a strict read boundary — reading outside it throws a runtime violation instead of returning data. A node may read its own mapping files, its declared relation targets (and their descendants), its ancestor mappings, and its own descendant mappings. If a check needs to reach a node outside this set, add an explicit relation in `yg-node.yaml` pointing to it — relations are the contract that widens the allowed reads. The **drift baseline** is narrower than this boundary: it records only the files the check actually read at approve time, so only a later change to one of those files causes cascade re-approval.

### Testing structure aspects

```bash
# Test the check against a specific node without wiring the aspect
yg structure-test --aspect sibling-test-file --node orders/order-service

# Verify the check is deterministic (same violations on every run)
yg structure-test --aspect sibling-test-file --node orders/order-service --check-determinism
```

`yg structure-test` exits 1 if violations exist. Run it against both compliant and non-compliant nodes to confirm no false positives and no false negatives.

---

## Suppression — shared across reviewer types

Source code comments can carry a `yg-suppress` marker to waive a specific aspect. All reviewer types honor the same syntax; they differ only in how scope is interpreted.

**Format:** `yg-suppress(<aspect-path>) <reason>`

- `<aspect-path>` — full aspect path (e.g., `cqrs/single-responsibility`)
- `<reason>` — required free-text explanation. Empty or whitespace-only reasons fail with `SUPPRESS_MARKER_MISSING_REASON`.
- Markers must live inside **comment nodes** — string literals are not matched.

### Single-line suppress

```typescript
// yg-suppress(async-fs) legacy code, refactor tracked in JIRA-456
const data = fs.readFileSync(path, 'utf-8');
```

- **AST and structure reviewers:** applies to the **immediately following line**. Deterministic, no scope inference.
- **LLM reviewer:** the reviewer interprets scope **contextually** — a marker inside a function applies to that function, at file top it applies to the whole file.

### Bracket suppress

```typescript
// yg-suppress-disable(async-fs) bootstrap block uses sync reads
const a = fs.readFileSync('a.json', 'utf-8');
const b = fs.readFileSync('b.json', 'utf-8');
// yg-suppress-enable(async-fs)
```

Applies to all lines between `disable` and `enable`. Reason is required on `disable`. Without a closing `enable`, the range extends to end of file. Block comments work too.

### Wildcard

Use `*` to suppress all aspects in a range:

```typescript
// yg-suppress-disable(*) generated block — do not edit
/* ... generated code ... */
// yg-suppress-enable(*)
```

A specific `enable(<id>)` does **not** punch through `disable(*)`. To re-enable a specific aspect inside a wildcard-disabled block, end the wildcard block first.

### Agent behavior

Agents may propose adding a suppress marker but must **never** write one without explicit user confirmation. The reason field is provided or approved by the human, never invented by the agent.

---

## Drift and baseline — shared

The drift model is similar across all three reviewer types:

- **LLM aspect:** baseline records the hash of `content.md`. Change → cascade re-approve.
- **AST aspect:** baseline records the hash of `check.mjs`. Change → cascade re-approve.
- **Structure aspect:** baseline records the hash of `check.mjs` plus the files it touched (including cross-node files read through declared relations). A change to the check, or to any touched file, → cascade re-approve.

`yg check` compares file hashes — no LLM calls, runs instantly. Source drift on mapped files and upstream drift on aspect content both trigger re-approval through the same mechanism.

---

## Edge cases

### LLM reviewer

**Borderline rejections.** Compliant code can be rejected by an LLM that misread the rule. Fix: clarify `content.md`. The escape hatch is better rules, not `yg-suppress`.

**Cost spikes on cascade.** A widely-used aspect changed → every dependent node re-approves → N LLM calls. Before changing such an aspect, run `yg impact --aspect <id>` to see scope. Consider `consensus: 1` for high-fan-out aspects.

### AST reviewer

**Imports inside `check.mjs`.** Yggdrasil hashes only `check.mjs` itself. If your check imports a helper from `node_modules`, changes to that helper do **not** trigger drift — Yggdrasil does not know about transitive dependencies. Guidance: keep all rule logic inside `check.mjs`. If you import a helper, consciously accept that bumping the helper version requires a manual `yg approve --aspect <id>` to refresh baselines.

**CLI version pinning.** Tree-sitter grammar versions and helper implementations live inside `@chrisdudek/yg`. A CLI upgrade can shift AST node shapes or helper behavior. v1 does not include the CLI version in the drift baseline. After a CLI upgrade that changes AST behavior (announced in CHANGELOG), re-approve manually:

```bash
yg approve --aspect <id>   # re-approve all nodes affected by this aspect
```

---

## See also

- [Core Concepts](/core-concepts) — nodes, aspects, and the graph
- [CLI Reference](/cli-reference) — `yg approve`, `yg ast-test`, `yg aspects`
- [Configuration](/configuration) — reviewer provider setup
- [Conditional Aspects](/conditional-aspects) — `when` predicates for selective aspect application
