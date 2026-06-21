// Per-document companion resolver — the meta-modeling feedback loop.
//
// Reads the requirement document's `enforced-by` front-matter, resolves the named
// enforcer's check.mjs UNDER .yggdrasil/, reads it via ctx.fs (channel 4 — proving a
// companion may read a .yggdrasil/ file when it is relation-reachable), and injects
// it as a companion (channel 3). Reachability comes from the requirement node's
// declared `uses` relation to the enforcer node that maps the check files; remove
// that relation and this read/return fails closed (negative case N1).
export function companion(ctx) {
  const doc = ctx.subject[0];
  if (!doc) throw new Error('companion: no subject requirement document for this unit');
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(doc.content);
  if (!m) throw new Error(`companion: requirement '${doc.path}' has no --- front-matter block`);
  const fm = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (kv) fm[kv[1]] = kv[2].trim();
  }
  const enforcedBy = fm['enforced-by'];
  if (!enforcedBy) throw new Error(`companion: requirement '${doc.path}' front-matter has no 'enforced-by' key`);
  const checkPath = `.yggdrasil/aspects/${enforcedBy}/check.mjs`;
  // Read the .yggdrasil/ check via ctx.fs — authorized by the node's `uses` relation
  // to the enforcer node; an out-of-reach read fails closed automatically.
  void ctx.fs.read(checkPath);
  return [{ path: checkPath, label: `enforcer check for ${enforcedBy}` }];
}
