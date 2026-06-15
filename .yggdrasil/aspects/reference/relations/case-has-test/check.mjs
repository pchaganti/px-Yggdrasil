// reference/relations/case-has-test — relations-kind aspect (Layer 2).
//
// Enforces the catalogue ↔ matrix-test correspondence for the relations kind:
//   FORWARD : every `<id>.md` in this reference node has an `it('<id>')` in the
//             matrix test file reached via the node's `uses` relation.
//   REVERSE : every matrix `it('<id>')` whose body calls `runCase(...)` has a
//             matching `<id>.md`.
//
// SCOPING (Phase-0 proof, documented so Phase 1 can widen): the reverse direction
// only inspects `it()`s that ALREADY delegate to `runCase` — i.e. cases migrated to
// the catalogue. Legacy descriptive `it('PASS R…: …')` rows that have not yet been
// migrated carry no `runCase` call and are intentionally ignored, so the single
// migrated case goes green without forcing all sibling rows to migrate at once.
// Phase 1 rewrites every matrix `it()` to `it('<id>', () => runCase('<id>'))`; once
// no non-runCase `it()` remains, this reverse check covers the WHOLE matrix and the
// correspondence is fully 1:1 — no aspect edit needed, the scoping dissolves on its own.

export function check(ctx) {
  const violations = [];

  // Catalogue ids = the node's own .md stems.
  const caseIds = new Set();
  let anyMd;
  for (const file of ctx.node.files) {
    if (!file.path.endsWith('.md')) continue;
    anyMd = file.path;
    caseIds.add(file.path.split('/').pop().replace(/\.md$/, ''));
  }
  if (caseIds.size === 0) return violations; // descriptor-only node — nothing to pair

  // Matrix test files reached via the node's `uses` relations.
  const testFiles = collectRelatedTestFiles(ctx, violations, anyMd);

  // it('<id>') literals declared in the matrix, and which of them call runCase.
  const itIds = new Set();
  const runCaseIds = new Set();
  for (const tf of testFiles) {
    for (const { id, callsRunCase } of parseItBlocks(tf.content)) {
      itIds.add(id);
      if (callsRunCase) runCaseIds.add(id);
    }
  }

  // FORWARD: every catalogue case has a matching it().
  for (const id of caseIds) {
    if (!itIds.has(id)) {
      violations.push({
        file: anyMd,
        message: `Reference case '${id}.md' has no matching it('${id}') in the related matrix test. Every case must have a test (add it('${id}', () => runCase('${id}'))).`,
        line: 1,
        column: 1,
      });
    }
  }

  // REVERSE (scoped to runCase-backed tests): every migrated it() has a case .md.
  for (const id of runCaseIds) {
    if (!caseIds.has(id)) {
      violations.push({
        file: testFiles[0]?.path ?? anyMd,
        message: `Matrix test it('${id}') calls runCase but has no matching reference case '${id}.md'. Add the case doc, or revert the test to a non-runCase form.`,
        line: 1,
        column: 1,
      });
    }
  }

  return violations;
}

// All files of every test-suite node this node declares a `uses` relation to.
function collectRelatedTestFiles(ctx, violations, anchorFile) {
  const out = [];
  let sawRelation = false;
  for (const rel of ctx.graph.relationsFrom(ctx.node)) {
    if (rel.type !== 'uses') continue;
    sawRelation = true;
    let target;
    try {
      target = ctx.graph.node(rel.target);
    } catch {
      violations.push({
        file: anchorFile,
        message: `Cannot reach relation target '${rel.target}'. Declare 'relations: [{ type: uses, target: ${rel.target} }]' on this node's yg-node.yaml.`,
        line: 1,
        column: 1,
      });
      continue;
    }
    if (!target) continue;
    for (const f of collectFiles(target, ctx)) {
      if (f.path.endsWith('.test.ts')) out.push(f);
    }
  }
  if (!sawRelation) {
    violations.push({
      file: anchorFile,
      message:
        "This reference node declares no 'uses' relation to a matrix test-suite node, so its cases cannot be paired with tests. Add relations: [{ type: uses, target: <matrix-test-node> }].",
      line: 1,
      column: 1,
    });
  }
  return out;
}

function collectFiles(node, ctx) {
  const out = [...node.files];
  for (const child of ctx.graph.children(node)) out.push(...collectFiles(child, ctx));
  return out;
}

// Find every `it('<id>'` / `it("<id>"` occurrence and whether its block body (up to a
// rough end) references runCase. Returns [{ id, callsRunCase }].
function parseItBlocks(content) {
  const out = [];
  const re = /\bit\(\s*(['"])([^'"]+)\1/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    const id = m[2];
    // Look at the slice from this it( up to the next it( (or EOF) for a runCase call.
    re.lastIndex; // current position is just after the matched literal
    const tailStart = m.index;
    const nextRe = /\bit\(\s*['"]/g;
    nextRe.lastIndex = m.index + m[0].length;
    const next = nextRe.exec(content);
    const block = content.slice(tailStart, next ? next.index : content.length);
    out.push({ id, callsRunCase: /\brunCase\s*\(/.test(block) });
  }
  return out;
}
