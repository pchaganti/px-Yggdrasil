// reference/relations/case-is-tested — relations-kind aspect (Layer 2).
//
// For every `<id>.md` in this reference node, the matching matrix test must REALLY
// exercise the case:
//   - an `it('<id>', …)` exists, and its body calls `runCase('<id>')` with the SAME
//     id literal (so the documented code in the .md is the code under test);
//   - the test is not `it.skip` / `it.todo` (a parked test verifies nothing).
//
// runCase loading the .md and asserting its `## Expect` is what guarantees the
// documented code is the tested code; this aspect verifies only the delegation +
// non-skip — fully deterministic.

export function check(ctx) {
  const violations = [];

  const caseIds = [];
  let anyMd;
  for (const file of ctx.node.files) {
    if (!file.path.endsWith('.md')) continue;
    anyMd = file.path;
    caseIds.push({ id: file.path.split('/').pop().replace(/\.md$/, ''), file: file.path });
  }
  if (caseIds.length === 0) return violations;

  const testFiles = collectRelatedTestFiles(ctx);
  const combined = testFiles.map((f) => f.content).join('\n\n');

  for (const { id, file } of caseIds) {
    const block = itBlockFor(combined, id);
    if (block === undefined) {
      // has-test aspect reports the missing it() — here we only need a present block.
      continue;
    }
    if (block.skipped) {
      violations.push({
        file,
        message: `Matrix test it('${id}') is skipped/todo (it.skip / it.todo); a parked test exercises nothing. Remove the .skip/.todo.`,
        line: 1,
        column: 1,
      });
      continue;
    }
    const runCaseLit = /\brunCase\s*\(\s*(['"])([^'"]+)\1\s*\)/.exec(block.body);
    if (!runCaseLit) {
      violations.push({
        file,
        message: `Matrix test it('${id}') does not call runCase('${id}'). Rewrite it as it('${id}', () => runCase('${id}')) so the documented case is the tested case.`,
        line: 1,
        column: 1,
      });
      continue;
    }
    if (runCaseLit[2] !== id) {
      violations.push({
        file,
        message: `Matrix test it('${id}') calls runCase('${runCaseLit[2]}') — the id literal must match. Use runCase('${id}').`,
        line: 1,
        column: 1,
      });
    }
  }

  return violations;
}

function collectRelatedTestFiles(ctx) {
  const out = [];
  for (const rel of ctx.graph.relationsFrom(ctx.node)) {
    if (rel.type !== 'uses') continue;
    let target;
    try {
      target = ctx.graph.node(rel.target);
    } catch {
      continue;
    }
    if (!target) continue;
    for (const f of collectFiles(target, ctx)) {
      if (f.path.endsWith('.test.ts')) out.push(f);
    }
  }
  return out;
}

function collectFiles(node, ctx) {
  const out = [...node.files];
  for (const child of ctx.graph.children(node)) out.push(...collectFiles(child, ctx));
  return out;
}

// The source of the `it()` block for `id`: { body, skipped } or undefined if absent.
function itBlockFor(content, id) {
  const esc = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Capture an optional `.skip`/`.todo`/`.only` modifier before the literal.
  const re = new RegExp(`\\bit(\\.[a-zA-Z]+)?\\(\\s*(['"])${esc}\\2`, 'g');
  const m = re.exec(content);
  if (!m) return undefined;
  const modifier = m[1] ?? '';
  const skipped = modifier === '.skip' || modifier === '.todo';
  // Body = from the match to the next top-level it( or EOF.
  const nextRe = /\bit(\.[a-zA-Z]+)?\(\s*['"]/g;
  nextRe.lastIndex = m.index + m[0].length;
  const next = nextRe.exec(content);
  const body = content.slice(m.index, next ? next.index : content.length);
  return { body, skipped };
}
