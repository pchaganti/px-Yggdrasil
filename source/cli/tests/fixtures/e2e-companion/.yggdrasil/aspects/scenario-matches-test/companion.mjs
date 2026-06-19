// Per-unit companion resolver for the scenario-matches-test LLM aspect.
//
// Each scenario .md carries a `---` frontmatter block naming its paired test:
//
//   ---
//   title: Checkout happy path
//   test: checkout.spec.ts
//   ---
//
// This hook reads ONLY the one paired spec (via ctx.fs.read), so editing one spec
// re-bills only the pair that reads it — true per-unit isolation. It never touches
// ctx.graph (which would materialize and read every sibling scenario + every spec,
// folding them all into this unit's verdict and breaking per-pair isolation). The
// allowed-reads boundary — derived from the node's declared `uses` relation to the
// spec node — is what authorizes the single ctx.fs.read; an out-of-reach read fails
// closed automatically. The hook resolves the prompt only — it never judges — so
// any unresolved pairing THROWS (→ infra-fail, nothing written).

// The directory that holds the paired specs. The hook reads ONE file under here
// (ctx.fs.read), keeping the touched set to exactly the paired spec so a sibling
// spec edit never invalidates this unit. Reachability is enforced by allowed-reads
// (the `uses` relation to the spec node); the path layout is the spec node's mapping.
const SPEC_DIR = 'apps/e2e/tests';

export function companion(ctx) {
  // ctx.subject is the unit's subject file(s). This aspect is per:file, so it is
  // exactly one scenario document.
  const scenario = ctx.subject[0];
  if (!scenario) {
    throw new Error('companion: no subject scenario file for this unit');
  }

  // Extract the `---...---` frontmatter block and parse its simple `key: value`
  // lines with a regex. (ctx.parseYaml is path-based — it reads a file from disk —
  // so it cannot parse an in-memory string; the design lists a regex / manual
  // `---` split as the supported way to read pairing keys from subject content.)
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(scenario.content);
  if (!match) {
    throw new Error(`companion: scenario '${scenario.path}' has no --- frontmatter block`);
  }
  const meta = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (kv) meta[kv[1]] = kv[2].trim();
  }
  const testName = meta.test;
  if (typeof testName !== 'string' || testName.length === 0) {
    throw new Error(`companion: scenario '${scenario.path}' frontmatter has no 'test:' key`);
  }
  const title = typeof meta.title === 'string' && meta.title.length > 0 ? meta.title : testName;

  // Read ONLY the single paired spec via ctx.fs.read. This records exactly one
  // read: observation (the paired spec), so a sibling spec edit never invalidates
  // this unit. The read is authorized by the allowed-reads boundary (the node's
  // `uses` relation to the spec node); if that relation is removed the read throws
  // an undeclared-read error → infra-fail (fail closed), never a silent miss.
  const specPath = `${SPEC_DIR}/${testName}`;
  // ctx.fs.read throws if the path is unreachable (no relation) or missing — both
  // are infra-fail conditions surfaced to the runner. Reading it folds the spec's
  // bytes into the verdict hash so editing the spec invalidates only this pair.
  void ctx.fs.read(specPath);

  return [{ path: specPath, label: `paired test: ${title}` }];
}
