# AST Aspects

Yggdrasil supports two reviewer types for aspects:

- **LLM reviewer** (`reviewer: llm`, the default): ships a `content.md` rule file. An LLM reads the rule and the node's source code, then accepts or rejects.
- **AST reviewer** (`reviewer: ast`): ships a `check.mjs` module. A deterministic runner parses the source files with tree-sitter and executes your `check` function against the AST.

Both types work in the same aspect-node-flow graph. The reviewer field only changes how the check is performed.

---

## When to choose AST vs LLM

**Use AST when the rule is structural** — something that can be checked by looking at syntax alone:

- Forbidden API calls (`fs.readFileSync`, `eval`, `process.exit`)
- Naming conventions (exports must be PascalCase, constants UPPER_SNAKE_CASE)
- Import restrictions (no relative imports across module boundaries)
- Missing guards (every public class method must have an `@Log` decorator)

**Use LLM when the rule requires semantic judgment**:

- "This service must handle the domain event semantically correctly"
- "Error responses must follow the API contract documented in the spec"
- "Business logic must conform to the financial rounding rules"

If you can write a regex or an AST traversal to verify the rule, use AST. If a human reviewer would need to read surrounding context to decide, use LLM.

---

## Directory structure

```
.yggdrasil/
  aspects/
    async-fs/
      yg-aspect.yaml       ← declares reviewer: ast
      check.mjs            ← your check function
    requires-audit/
      yg-aspect.yaml       ← reviewer: llm (default)
      content.md           ← rule text for LLM
```

`content.md` and `check.mjs` are mutually exclusive — exactly one must be present. The validator (`yg check`) enforces this.

---

## `yg-aspect.yaml`

```yaml
name: No Sync FS
description: Forbid synchronous fs calls — use async equivalents
reviewer: ast
```

The `reviewer: ast` field is all that's needed in the YAML. Everything else (implies, when, aspects) works identically for both reviewer types.

---

## Writing `check.mjs`

### Signature

```javascript
// check.mjs — must export a named 'check' function (not default export)
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
  ast: Tree;          // web-tree-sitter parse tree (Tree type from 'web-tree-sitter')
}
```

A `Violation` is:
```typescript
interface Violation {
  file: string;   // relative to project root
  line: number;   // 1-based
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

ast.report(file, node, message)     // creates a Violation from a tree-sitter node
ast.nameOf(node)                     // extracts identifier name from declarations
ast.inFile(file, pattern)            // glob / regex / substring path filter
ast.exports(rootNode)                // all exported declarations
ast.imports(rootNode)                // all import statements and require() calls
ast.call(node, target)               // match a call_expression (bare name or member)
ast.closest(node, types)             // walk up to nearest ancestor of given types
ast.within(parent, type, opts?)      // descendants of type, respecting function boundaries
ast.decoratorsOf(node)               // all decorators on a class or member
ast.modifiersOf(node)                // access/readonly/abstract/etc. modifiers
ast.jsxElements(rootNode)            // all JSX opening and self-closing elements
ast.casing.pascal(name)              // naming convention checks: pascal, camel, upperSnake, kebab
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
  const params = new Set(ast.imports(fn).map(i => i.source));  // not quite right, illustrative only
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

---

## Running checks

```bash
# Verify an aspect against specific files (no graph attachment, no baseline)
yg ast-test --aspect async-fs --files src/utils/config.ts

# Use a node's mapping as the file list
yg ast-test --aspect async-fs --node orders/order-service

# Run as part of normal approve (AST aspects in a node's effective set run automatically)
yg approve --node orders/order-service
```

`yg ast-test` exits 0 for clean, 1 for violations. Output:
```
src/utils/config.ts
  L12: fs.readFileSync is synchronous — use async equivalent
```

---

## Suppression

Two forms are supported. Markers are only recognized inside **comment nodes** — string literals are not matched.

### Single-line suppress

```typescript
// yg-suppress(async-fs) legacy code, refactor tracked in JIRA-456
const data = fs.readFileSync(path, 'utf-8');   // ← this line is suppressed
```

Applies to the **immediately following line**. Reason is required — empty reason fails with `SUPPRESS_MARKER_MISSING_REASON`.

### Bracket suppress

```typescript
// yg-suppress-disable(async-fs) entire bootstrap block uses sync reads
const a = fs.readFileSync('a.json', 'utf-8');
const b = fs.readFileSync('b.json', 'utf-8');
const c = fs.readFileSync('c.json', 'utf-8');
// yg-suppress-enable(async-fs)
```

Applies to all lines between `disable` and `enable`. Reason is required on `disable`.

### Wildcard

Use `*` to suppress all aspects in a range:

```typescript
// yg-suppress-disable(*) generated block — do not edit
/* ... generated code ... */
// yg-suppress-enable(*)
```

A specific `enable(<id>)` does **not** punch through `disable(*)`. To re-enable a specific aspect inside a wildcard-disabled block, end the wildcard block first.

---

## Edge cases

### Imports inside check.mjs

Yggdrasil hashes only `check.mjs` itself. If your check imports a helper from node_modules, changes to that helper do **not** trigger drift — Yggdrasil does not know about transitive dependencies of `check.mjs`.

Guidance: keep all rule logic inside `check.mjs`. If you import a helper, consciously accept that bumping the helper version requires a manual `yg approve --aspect <id>` to refresh baselines.

### CLI version pinning

Tree-sitter grammar versions and helper implementations live inside `@chrisdudek/yg`. A CLI upgrade can shift AST node shapes or helper behavior. v1 does not include the CLI version in the drift baseline.

After a CLI upgrade that changes AST behavior (announced in CHANGELOG), re-approve manually:

```bash
yg approve --aspect <id>   # re-approve all nodes affected by this aspect
```

---

## See also

- [Core Concepts](/core-concepts) — nodes, aspects, and the graph
- [CLI Reference](/cli-reference) — `yg approve`, `yg ast-test`, `yg aspects`
- [Conditional Aspects](/conditional-aspects) — `when` predicates for selective aspect application
