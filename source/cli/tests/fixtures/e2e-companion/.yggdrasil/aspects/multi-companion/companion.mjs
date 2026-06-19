// A companion hook that returns ALL specs in every uses-related node, so a unit's
// prompt carries multiple companion files. The runner dedupes + sorts the paths,
// so ordering in the prompt is deterministic regardless of return order.
export function companion(ctx) {
  const self = ctx.graph.node(ctx.node.id);
  const out = [];
  for (const rel of ctx.graph.relationsFrom(self)) {
    if (rel.type !== 'uses') continue;
    const target = ctx.graph.node(rel.target);
    if (!target) continue;
    for (const file of target.files) {
      out.push({ path: file.path, label: file.path.split('/').pop() });
    }
  }
  if (out.length === 0) {
    throw new Error('multi-companion: no paired specs found in any uses-related node');
  }
  return out;
}
