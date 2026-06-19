// Per:node companion resolver. ctx.subject is the node's WHOLE subject set (all
// scenario documents). For each scenario, read its frontmatter `test:` and collect
// the matching spec from the uses-related node. Returns the union (fan-in). The
// runner dedupes + sorts, so a spec named by two scenarios appears once and the
// order is deterministic.
export function companion(ctx) {
  const self = ctx.graph.node(ctx.node.id);
  const specFiles = [];
  for (const rel of ctx.graph.relationsFrom(self)) {
    if (rel.type !== 'uses') continue;
    const target = ctx.graph.node(rel.target);
    if (!target) continue;
    for (const file of target.files) specFiles.push(file);
  }

  const out = [];
  for (const scenario of ctx.subject) {
    const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(scenario.content);
    if (!match) {
      throw new Error(`per-node-companion: scenario '${scenario.path}' has no --- frontmatter`);
    }
    let testName;
    for (const line of match[1].split(/\r?\n/)) {
      const kv = /^test:\s*(.*)$/.exec(line);
      if (kv) testName = kv[1].trim();
    }
    if (!testName) {
      throw new Error(`per-node-companion: scenario '${scenario.path}' has no 'test:' key`);
    }
    const spec = specFiles.find((f) => f.path.split('/').pop() === testName);
    if (!spec) {
      throw new Error(`per-node-companion: no paired spec for test '${testName}'`);
    }
    out.push({ path: spec.path, label: `paired test for ${scenario.path.split('/').pop()}` });
  }
  return out;
}
