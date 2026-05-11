# Aspect Reviewers

Aspects are verified by reviewers. Yggdrasil ships two reviewer types — both operate on the same aspect-node-flow graph; the `reviewer` field in `yg-aspect.yaml` selects which one runs.

- **LLM reviewer** (`reviewer: llm`, the default): ships a `content.md` rule file. An LLM reads the rule and the node's source code, then accepts or rejects.
- **AST reviewer** (`reviewer: ast`): ships a `check.mjs` module. A deterministic runner parses the source files with tree-sitter and executes your `check` function against the AST.

`content.md` and `check.mjs` are mutually exclusive — exactly one must be present per aspect. `yg check` enforces this.

---

## Choosing a reviewer

| Use AST when the rule is **structural**         | Use LLM when the rule requires **semantic judgment** |
|--------------------------------------------------|-----------------------------------------------------|
| Forbidden API calls (`fs.readFileSync`, `eval`)  | "Mutations must emit audit events"                  |
| Naming conventions (PascalCase exports)          | "Error responses must follow the API contract"      |
| Import restrictions (no cross-module relatives)  | "Business logic must respect rounding rules"        |
| Missing guards (`@Log` decorator required)       | "This handler must validate input semantically"     |

If you can write a regex or an AST traversal to verify the rule, use AST. If a human reviewer would need to read surrounding context to decide, use LLM.

LLM is the default — reach for AST only when the rule is provably fully structural.

---

## LLM reviewer

The LLM reviewer is a separate LLM call from the coding agent — one LLM verifying the work of another. `yg approve` sends each aspect's `content.md` plus the relevant source files to the reviewer. The reviewer responds with SATISFIED or NOT SATISFIED per aspect. One LLM call per aspect per node.

### Directory structure

```
.yggdrasil/aspects/
  requires-audit/
    yg-aspect.yaml       ← reviewer: llm (default, can be omitted)
    content.md           ← the rule, in plain Markdown
```

### `yg-aspect.yaml`

```yaml
name: Audit Logging
description: "Every mutation must emit an audit event"
# reviewer: llm           # default — can be omitted
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

Set `consensus: 3` (or any odd number) in `yg-config.yaml` to run multiple review passes and take the majority vote. Higher confidence, proportionally higher cost. Useful for high-stakes aspects or noisy borderline rules.

---

## AST reviewer

The AST reviewer is deterministic. The runner parses each source file with tree-sitter and calls your `check(ctx)` function with the parse tree. Whatever `Violation[]` you return is the verdict — no LLM, no nondeterminism, no per-call cost.

### Directory structure

```
.yggdrasil/aspects/
  async-fs/
    yg-aspect.yaml       ← reviewer: ast
    check.mjs            ← your check function
```

### `yg-aspect.yaml`

```yaml
name: No Sync FS
description: Forbid synchronous fs calls — use async equivalents
reviewer: ast
```

The `reviewer: ast` field is all that's needed. Everything else (`implies`, `when`, `aspects` on nodes) works identically for both reviewer types.

### Writing `check.mjs`

```javascript
// check.mjs — must export a named 'check' function (not default)
import { ast } from '@chrisdudek/yg/ast';

export function check(ctx) {
  const violations = [];
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
  ast: Tree;          // web-tree-sitter parse tree
}

interface Violation {
  file: string;       // relative to project root
  line: number;       // 1-based
  message: string;
}
```

### End-to-end example — async-fs

```javascript
// .yggdrasil/aspects/async-fs/check.mjs
import { ast } from '@chrisdudek/yg/ast';

export function check(ctx) {
  const violations = [];
  for (const file of ctx.files) {
    for (const node of ast.within(file.ast.rootNode, 'call_expression', { crossFunctions: true })) {
      const m = ast.call(node, { object: 'fs', method: /Sync$/ });
      if (m) {
        violations.push(
          ast.report(file, node, `fs.${m.property.text} is synchronous — use async equivalent`)
        );
      }
    }
  }
  return violations;
}
```

This flags any call matching `fs.<anythingSync>()` anywhere in the files, across function boundaries.

### Helper library

The twelve helpers are imported from `@chrisdudek/yg/ast` — no installation required. If `yg` works on the machine, the import resolves at runtime.

```javascript
import { ast } from '@chrisdudek/yg/ast';

ast.report(file, node, message)     // create a Violation from a tree-sitter node
ast.nameOf(node)                     // extract identifier name from declarations
ast.inFile(file, pattern)            // glob / regex / substring path filter
ast.exports(rootNode)                // all exported declarations
ast.imports(rootNode)                // all import statements and require() calls
ast.call(node, target)               // match a call_expression (bare name or member)
ast.closest(node, types)             // walk up to nearest ancestor of given types
ast.within(parent, type, opts?)      // descendants of type, respecting function boundaries
ast.decoratorsOf(node)               // all decorators on a class or member
ast.modifiersOf(node)                // access/readonly/abstract/etc. modifiers
ast.jsxElements(rootNode)            // all JSX opening and self-closing elements
ast.casing.pascal(name)              // naming conventions: pascal, camel, upperSnake, kebab
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

**With helpers** (~8 lines):

```javascript
import { ast } from '@chrisdudek/yg/ast';

for (const fn of ast.within(file.ast.rootNode, 'function_declaration', { crossFunctions: true })) {
  const params = collectParamNames(fn);
  for (const callNode of ast.within(fn, 'call_expression')) {
    const m = ast.call(callNode, { method: /^(push|splice|pop|sort|reverse)$/ });
    if (m && params.has(m.object?.text ?? '')) {
      violations.push(ast.report(file, callNode, `Mutating parameter via .${m.property?.text}() is forbidden`));
    }
  }
}
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

## Suppression — shared across reviewer types

Source code comments can carry a `yg-suppress` marker to waive a specific aspect. Both reviewer types honor the same syntax; they differ only in how scope is interpreted.

**Format:** `yg-suppress(<aspect-path>) <reason>`

- `<aspect-path>` — full aspect path (e.g., `cqrs/single-responsibility`)
- `<reason>` — required free-text explanation. Empty or whitespace-only reasons fail with `SUPPRESS_MARKER_MISSING_REASON`.
- Markers must live inside **comment nodes** — string literals are not matched.

### Single-line suppress

```typescript
// yg-suppress(async-fs) legacy code, refactor tracked in JIRA-456
const data = fs.readFileSync(path, 'utf-8');
```

- **AST reviewer:** applies to the **immediately following line**. Deterministic, no scope inference.
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

The drift model is identical for both reviewer types:

- **LLM aspect:** baseline records the hash of `content.md`. Change → cascade re-approve.
- **AST aspect:** baseline records the hash of `check.mjs`. Change → cascade re-approve.

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
