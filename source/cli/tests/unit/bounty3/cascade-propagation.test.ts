import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  mkdtemp,
  mkdir,
  writeFile,
  rm,
} from 'node:fs/promises';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  cpSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { loadGraph } from '../../../src/core/graph-loader.js';
import { classifyDrift, runCheck } from '../../../src/core/check.js';
import { recordBaselineForAllMappedNodes } from '../helpers/seed-baseline.js';

// ===========================================================================
// BOUNTY 3 — cascade propagation: source vs upstream drift, and the
// flow / parent / port / type / implies cascade channels (incl. oversized-node
// cascade-sensitivity).
//
// These tests target the INVARIANTS that, if broken, mean a false-green check
// or lost drift:
//   1. SOURCE drift (mapped file content edited) vs UPSTREAM drift (aspect
//      content, node metadata, dependency, port, flow effective-set changed).
//   2. A COSMETIC flow edit (description only) does NOT cascade, while
//      ADDING / REMOVING a flow aspect or a flow PARTICIPANT DOES cascade —
//      and only on the nodes whose effective aspect set actually changed.
//   3. An aspect-content change cascades to EVERY effective node.
//   4. Port aspect-set changes cascade to the CONSUMER (channel 6), attributed
//      to the typed `port` identity cause.
//   5. oversized-node becomes cascade-SENSITIVE: a previously-unbounded node
//      (deterministic-only / draft-only) becomes bounded the moment a non-draft
//      LLM aspect reaches it via a type default, a flow, a port, or implies.
//
// The existing suites prove the rendering helpers (describeCascadeCause) and
// the per-layer e2e clears; the cases here pin the CLASSIFICATION decisions and
// the cascade-sensitivity of the budget gate, which they do not cover.
//
// Hermetic: every test builds a graph in a fresh mkdtemp tree, seeds a baseline
// with the production-shaped helper (no reviewer call), and rm's the tree in a
// finally / afterEach. No network, no real LLM. The single E2E case spawns the
// binary against a copy of the e2e-lifecycle fixture with the LLM aspect
// stripped and the reviewer endpoint killed — every verdict is deterministic.
// ===========================================================================

// ── Unit-level helpers ─────────────────────────────────────────────────────

const tmpDirs: string[] = [];
afterEach(async () => {
  while (tmpDirs.length > 0) {
    const d = tmpDirs.pop()!;
    await rm(d, { recursive: true, force: true });
  }
});

/** Create a fresh isolated project tree with the .yggdrasil scaffolding. */
async function freshProject(configYaml = 'version: "5.0.0"\n'): Promise<{ dir: string; ygg: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'yg-bounty3-'));
  tmpDirs.push(dir);
  const ygg = path.join(dir, '.yggdrasil');
  await mkdir(path.join(ygg, 'schemas'), { recursive: true });
  await mkdir(path.join(ygg, '.drift-state'), { recursive: true });
  await writeFile(path.join(ygg, 'schemas', 'yg-node.yaml'), 'type: node\n');
  await writeFile(path.join(ygg, 'schemas', 'yg-aspect.yaml'), 'type: aspect\n');
  await writeFile(path.join(ygg, 'schemas', 'yg-flow.yaml'), 'type: flow\n');
  await writeFile(path.join(ygg, 'yg-config.yaml'), configYaml);
  return { dir, ygg };
}

async function writeNode(ygg: string, nodePath: string, yaml: string): Promise<void> {
  const nodeDir = path.join(ygg, 'model', nodePath);
  await mkdir(nodeDir, { recursive: true });
  await writeFile(path.join(nodeDir, 'yg-node.yaml'), yaml);
}

async function writeLlmAspect(ygg: string, id: string, status?: string): Promise<void> {
  const aspDir = path.join(ygg, 'aspects', id);
  await mkdir(aspDir, { recursive: true });
  await writeFile(
    path.join(aspDir, 'yg-aspect.yaml'),
    `name: ${id}\ndescription: ${id} rule\nreviewer:\n  type: llm\n${status ? `status: ${status}\n` : ''}`,
  );
  await writeFile(path.join(aspDir, 'content.md'), `Rule for ${id}.\n`);
}

async function writeDetAspect(ygg: string, id: string, opts: { implies?: string[]; status?: string } = {}): Promise<void> {
  const aspDir = path.join(ygg, 'aspects', id);
  await mkdir(aspDir, { recursive: true });
  await writeFile(
    path.join(aspDir, 'yg-aspect.yaml'),
    `name: ${id}\ndescription: ${id} rule\nreviewer:\n  type: deterministic\n` +
      `${opts.status ? `status: ${opts.status}\n` : ''}` +
      `${opts.implies ? `implies:\n${opts.implies.map((i) => `  - ${i}`).join('\n')}\n` : ''}`,
  );
  await writeFile(path.join(aspDir, 'check.mjs'), 'export function check(ctx) { return []; }\n');
}

async function writeFlow(ygg: string, name: string, yaml: string): Promise<void> {
  const flowDir = path.join(ygg, 'flows', name);
  await mkdir(flowDir, { recursive: true });
  await writeFile(path.join(flowDir, 'yg-flow.yaml'), yaml);
}

async function writeSrc(dir: string, rel: string, content: string): Promise<void> {
  const abs = path.join(dir, rel);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, content);
}

const issuesFor = (issues: Awaited<ReturnType<typeof classifyDrift>>, nodePath: string) =>
  issues.filter((i) => i.nodePath === nodePath);

// ===========================================================================
// SECTION A — source vs upstream classification.
// ===========================================================================

describe('cascade: source vs upstream drift classification', () => {
  it('a mapped-file content edit is SOURCE drift, not upstream — no upstream-drift emitted', async () => {
    const { dir, ygg } = await freshProject();
    await writeNode(ygg, 'svc', 'name: Svc\ntype: service\ndescription: parent\n');
    await writeNode(ygg, 'svc/a', 'name: A\ntype: service\ndescription: x\naspects:\n  - own\nmapping:\n  - src/a.ts\n');
    await writeLlmAspect(ygg, 'own');
    await writeSrc(dir, 'src/a.ts', 'export const a = 1;\n');
    await recordBaselineForAllMappedNodes(await loadGraph(dir));
    // settled
    expect(await classifyDrift(await loadGraph(dir))).toHaveLength(0);

    // Edit ONLY the mapped source file.
    await writeSrc(dir, 'src/a.ts', 'export const a = 2;\n');
    const issues = issuesFor(await classifyDrift(await loadGraph(dir)), 'svc/a');
    const source = issues.filter((i) => i.code === 'source-drift');
    const upstream = issues.filter((i) => i.code === 'upstream-drift');
    expect(source).toHaveLength(1);
    expect(source[0].lifecycleState).toBe('ok');
    // INVARIANT: a pure source edit must NOT be misclassified as a cascade.
    expect(upstream).toHaveLength(0);
  });

  it('editing aspect content.md is UPSTREAM drift on the aspects layer (not source) and cascades to EVERY effective node', async () => {
    const { dir, ygg } = await freshProject();
    await writeNode(ygg, 'svc', 'name: Svc\ntype: service\ndescription: parent\n');
    // Two sibling nodes both use the same aspect.
    for (const n of ['a', 'b']) {
      await writeNode(
        ygg,
        `svc/${n}`,
        `name: ${n}\ntype: service\ndescription: x\naspects:\n  - shared\nmapping:\n  - src/${n}.ts\n`,
      );
      await writeSrc(dir, `src/${n}.ts`, `export const ${n} = 1;\n`);
    }
    await writeLlmAspect(ygg, 'shared');
    await recordBaselineForAllMappedNodes(await loadGraph(dir));
    expect(await classifyDrift(await loadGraph(dir))).toHaveLength(0);

    // Edit the shared aspect's rule content.
    await writeFile(path.join(ygg, 'aspects', 'shared', 'content.md'), 'Updated rule for shared.\n');
    const issues = await classifyDrift(await loadGraph(dir));
    // BOTH effective nodes drift; the change is on the 'aspects' layer (upstream),
    // never source-drift.
    for (const n of ['svc/a', 'svc/b']) {
      const ups = issuesFor(issues, n).filter((i) => i.code === 'upstream-drift');
      expect(ups, `node ${n} must have an upstream-drift`).toHaveLength(1);
      expect(ups[0].cascadeCauses!.some((c) => c.layer === 'aspects')).toBe(true);
      expect(issuesFor(issues, n).some((i) => i.code === 'source-drift')).toBe(false);
    }
  });
});

// ===========================================================================
// SECTION B — flow cascade: cosmetic edit vs effective-set change.
// ===========================================================================

describe('cascade: flow propagation (cosmetic vs effective-set)', () => {
  it('a description-only flow edit does NOT cascade (cosmetic — effective set unchanged)', async () => {
    const { dir, ygg } = await freshProject();
    await writeNode(ygg, 'a', 'name: A\ntype: service\ndescription: x\naspects:\n  - flowed\nmapping:\n  - src/a.ts\n');
    await writeLlmAspect(ygg, 'flowed');
    await writeSrc(dir, 'src/a.ts', 'export const a = 1;\n');
    await writeFlow(ygg, 'f1', 'name: F1\ndescription: original\nnodes:\n  - a\naspects:\n  - flowed\n');
    await recordBaselineForAllMappedNodes(await loadGraph(dir));
    expect(await classifyDrift(await loadGraph(dir))).toHaveLength(0);

    // Rewrite ONLY the flow description — the participant + aspect set is identical.
    await writeFlow(ygg, 'f1', 'name: F1\ndescription: REWRITTEN cosmetic text\nnodes:\n  - a\naspects:\n  - flowed\n');
    const issues = await classifyDrift(await loadGraph(dir));
    // INVARIANT: a cosmetic flow edit must not produce false drift.
    expect(issues).toHaveLength(0);
  });

  it('ADDING an aspect to a flow cascades to participants (aspect-newly-active + upstream-drift)', async () => {
    const { dir, ygg } = await freshProject();
    await writeNode(ygg, 'a', 'name: A\ntype: service\ndescription: x\naspects:\n  - own\nmapping:\n  - src/a.ts\n');
    await writeLlmAspect(ygg, 'own');
    await writeLlmAspect(ygg, 'flowed');
    await writeSrc(dir, 'src/a.ts', 'export const a = 1;\n');
    // Flow with NO aspect initially.
    await writeFlow(ygg, 'f1', 'name: F1\ndescription: d\nnodes:\n  - a\n');
    await recordBaselineForAllMappedNodes(await loadGraph(dir));
    expect(await classifyDrift(await loadGraph(dir))).toHaveLength(0);

    // Add the flow aspect → it becomes effective on the participant.
    await writeFlow(ygg, 'f1', 'name: F1\ndescription: d\nnodes:\n  - a\naspects:\n  - flowed\n');
    const issues = issuesFor(await classifyDrift(await loadGraph(dir)), 'a');
    // The newly-effective aspect has no baseline verdict → aspect-newly-active.
    expect(issues.some((i) => i.code === 'aspect-newly-active' && i.aspectId === 'flowed')).toBe(true);
    // The aspect's tracked artifacts/identity now participate → upstream-drift.
    expect(issues.some((i) => i.code === 'upstream-drift')).toBe(true);
  });

  it('ADDING a flow PARTICIPANT cascades ONLY to the newly-added node, not to nodes already in the flow', async () => {
    const { dir, ygg } = await freshProject();
    await writeNode(ygg, 'svc', 'name: Svc\ntype: service\ndescription: parent\n');
    for (const n of ['a', 'b']) {
      await writeNode(
        ygg,
        `svc/${n}`,
        `name: ${n}\ntype: service\ndescription: x\naspects:\n  - own\nmapping:\n  - src/${n}.ts\n`,
      );
      await writeSrc(dir, `src/${n}.ts`, `export const ${n} = 1;\n`);
    }
    await writeLlmAspect(ygg, 'own');
    await writeLlmAspect(ygg, 'flowed');
    // Flow carries `flowed`; only svc/a participates.
    await writeFlow(ygg, 'f1', 'name: F1\ndescription: d\nnodes:\n  - svc/a\naspects:\n  - flowed\n');
    await recordBaselineForAllMappedNodes(await loadGraph(dir));
    expect(await classifyDrift(await loadGraph(dir))).toHaveLength(0);

    // Add svc/b as a participant.
    await writeFlow(ygg, 'f1', 'name: F1\ndescription: d\nnodes:\n  - svc/a\n  - svc/b\naspects:\n  - flowed\n');
    const issues = await classifyDrift(await loadGraph(dir));
    // INVARIANT: only the newly-added participant's effective set changed.
    expect(issuesFor(issues, 'svc/b').length).toBeGreaterThanOrEqual(1);
    expect(issuesFor(issues, 'svc/b').some((i) => i.code === 'aspect-newly-active')).toBe(true);
    // svc/a already had `flowed` effective — its set is unchanged, no drift.
    expect(issuesFor(issues, 'svc/a')).toHaveLength(0);
  });

  it('REMOVING a flow PARTICIPANT cascades ONLY to the removed node (it loses the flow aspect)', async () => {
    const { dir, ygg } = await freshProject();
    await writeNode(ygg, 'svc', 'name: Svc\ntype: service\ndescription: parent\n');
    for (const n of ['a', 'b']) {
      await writeNode(
        ygg,
        `svc/${n}`,
        `name: ${n}\ntype: service\ndescription: x\naspects:\n  - own\nmapping:\n  - src/${n}.ts\n`,
      );
      await writeSrc(dir, `src/${n}.ts`, `export const ${n} = 1;\n`);
    }
    await writeLlmAspect(ygg, 'own');
    await writeLlmAspect(ygg, 'flowed');
    await writeFlow(ygg, 'f1', 'name: F1\ndescription: d\nnodes:\n  - svc/a\n  - svc/b\naspects:\n  - flowed\n');
    await recordBaselineForAllMappedNodes(await loadGraph(dir));
    expect(await classifyDrift(await loadGraph(dir))).toHaveLength(0);

    // Remove svc/b from the flow.
    await writeFlow(ygg, 'f1', 'name: F1\ndescription: d\nnodes:\n  - svc/a\naspects:\n  - flowed\n');
    const issues = await classifyDrift(await loadGraph(dir));
    // svc/b lost `flowed` → its tracked context shrank → drift.
    expect(issuesFor(issues, 'svc/b').some((i) => i.code === 'upstream-drift')).toBe(true);
    // svc/a is unaffected.
    expect(issuesFor(issues, 'svc/a')).toHaveLength(0);
  });

  it('REMOVING a flow aspect drifts every participant that lost it', async () => {
    const { dir, ygg } = await freshProject();
    await writeNode(ygg, 'a', 'name: A\ntype: service\ndescription: x\naspects:\n  - own\nmapping:\n  - src/a.ts\n');
    await writeLlmAspect(ygg, 'own');
    await writeLlmAspect(ygg, 'flowed');
    await writeSrc(dir, 'src/a.ts', 'export const a = 1;\n');
    await writeFlow(ygg, 'f1', 'name: F1\ndescription: d\nnodes:\n  - a\naspects:\n  - flowed\n');
    await recordBaselineForAllMappedNodes(await loadGraph(dir));
    expect(await classifyDrift(await loadGraph(dir))).toHaveLength(0);

    // Remove the flow aspect.
    await writeFlow(ygg, 'f1', 'name: F1\ndescription: d\nnodes:\n  - a\n');
    const issues = issuesFor(await classifyDrift(await loadGraph(dir)), 'a');
    // INVARIANT: dropping an effective aspect must drift the node (its tracked
    // context lost the aspect's artifacts).
    expect(issues.some((i) => i.code === 'upstream-drift')).toBe(true);
  });
});

// ===========================================================================
// SECTION C — parent / dependency / port cascade.
// ===========================================================================

describe('cascade: parent metadata, dependency, and port channels', () => {
  it('a parent node aspect-relevant metadata change cascades to descendants on the hierarchy layer', async () => {
    const { dir, ygg } = await freshProject();
    // Parent carries an aspect (so its aspect subset is meaningful) + child inherits.
    await writeNode(ygg, 'svc', 'name: Svc\ntype: service\ndescription: parent\naspects:\n  - parentasp\n');
    await writeNode(ygg, 'svc/a', 'name: A\ntype: service\ndescription: x\naspects:\n  - own\nmapping:\n  - src/a.ts\n');
    await writeLlmAspect(ygg, 'own');
    await writeLlmAspect(ygg, 'parentasp');
    await writeSrc(dir, 'src/a.ts', 'export const a = 1;\n');
    await recordBaselineForAllMappedNodes(await loadGraph(dir));
    expect(await classifyDrift(await loadGraph(dir))).toHaveLength(0);

    // Change the parent's aspect set (aspect-relevant subset) — its yg-node.yaml hash drifts.
    await writeNode(ygg, 'svc', 'name: Svc\ntype: service\ndescription: parent\naspects:\n  - parentasp\n  - own\n');
    const issues = issuesFor(await classifyDrift(await loadGraph(dir)), 'svc/a');
    const upstream = issues.filter((i) => i.code === 'upstream-drift');
    expect(upstream).toHaveLength(1);
    expect(upstream[0].cascadeCauses!.some((c) => c.layer === 'hierarchy')).toBe(true);
  });

  it("a `uses` dependency's yg-node.yaml change cascades to the dependent on the relational layer", async () => {
    const { dir, ygg } = await freshProject();
    await writeNode(ygg, 'svc', 'name: Svc\ntype: service\ndescription: parent\n');
    await writeNode(
      ygg,
      'svc/cons',
      'name: Cons\ntype: service\ndescription: x\naspects:\n  - own\nrelations:\n  - target: svc/dep\n    type: uses\nmapping:\n  - src/cons.ts\n',
    );
    await writeNode(ygg, 'svc/dep', 'name: Dep\ntype: service\ndescription: dependency\nmapping:\n  - src/dep.ts\n');
    await writeLlmAspect(ygg, 'own');
    await writeSrc(dir, 'src/cons.ts', 'export const c = 1;\n');
    await writeSrc(dir, 'src/dep.ts', 'export const d = 1;\n');
    await recordBaselineForAllMappedNodes(await loadGraph(dir));
    expect(await classifyDrift(await loadGraph(dir))).toHaveLength(0);

    // Change the dependency's aspect-relevant metadata.
    await writeNode(ygg, 'svc/dep', 'name: Dep\ntype: module\ndescription: dependency v2\nmapping:\n  - src/dep.ts\n');
    const issues = issuesFor(await classifyDrift(await loadGraph(dir)), 'svc/cons');
    const upstream = issues.filter((i) => i.code === 'upstream-drift');
    expect(upstream.length).toBeGreaterThanOrEqual(1);
    expect(upstream[0].cascadeCauses!.some((c) => c.layer === 'relational')).toBe(true);
  });

  it("changing a provider's PORT aspect set cascades to the consumer via the typed `port` identity cause", async () => {
    const { dir, ygg } = await freshProject();
    await writeNode(ygg, 'svc', 'name: Svc\ntype: service\ndescription: parent\n');
    // Provider exposes a port carrying an aspect.
    await writeNode(
      ygg,
      'svc/prov',
      'name: Prov\ntype: service\ndescription: x\nmapping:\n  - src/prov.ts\n' +
        'ports:\n  charge:\n    description: charge port\n    aspects:\n      - portasp\n',
    );
    // Consumer uses the provider and consumes the port.
    await writeNode(
      ygg,
      'svc/cons',
      'name: Cons\ntype: service\ndescription: x\naspects:\n  - own\n' +
        'relations:\n  - target: svc/prov\n    type: uses\n    consumes:\n      - charge\nmapping:\n  - src/cons.ts\n',
    );
    await writeLlmAspect(ygg, 'own');
    await writeLlmAspect(ygg, 'portasp');
    await writeSrc(dir, 'src/prov.ts', 'export const p = 1;\n');
    await writeSrc(dir, 'src/cons.ts', 'export const c = 1;\n');
    await recordBaselineForAllMappedNodes(await loadGraph(dir));
    expect(await classifyDrift(await loadGraph(dir))).toHaveLength(0);

    // Add an aspect to the port on the provider — the port aspect hash drifts.
    await writeNode(
      ygg,
      'svc/prov',
      'name: Prov\ntype: service\ndescription: x\nmapping:\n  - src/prov.ts\n' +
        'ports:\n  charge:\n    description: charge port\n    aspects:\n      - portasp\n      - own\n',
    );
    const issues = issuesFor(await classifyDrift(await loadGraph(dir)), 'svc/cons');
    const upstream = issues.filter((i) => i.code === 'upstream-drift');
    expect(upstream.length).toBeGreaterThanOrEqual(1);
    // INVARIANT: the port-aspect change is attributed to the typed `port`
    // identity cause (channel 6), not just any relational file change.
    expect(upstream[0].cascadeCauses!.some((c) => c.identity?.kind === 'port')).toBe(true);
  });
});

// ===========================================================================
// SECTION D — oversized-node cascade-sensitivity.
//
// The budget gate applies ONLY to nodes an LLM reviewer actually reads
// (>= 1 effective non-draft LLM aspect). It is therefore cascade-sensitive:
// a previously-unbounded node becomes bounded the moment a non-draft LLM
// aspect reaches it. These tests pin that for each cascade channel.
// ===========================================================================

describe('cascade: oversized-node is LLM-only and cascade-sensitive', () => {
  const TINY_BUDGET = 'version: "5.0.0"\nquality:\n  max_node_chars: 50\n';
  const oversizedCount = async (dir: string): Promise<number> =>
    (await runCheck(await loadGraph(dir), null)).issues.filter((i) => i.code === 'oversized-node').length;

  it('deterministic-only oversized node carries NO budget; adding an LLM aspect via TYPE DEFAULT brings it under the budget', async () => {
    const { dir, ygg } = await freshProject(TINY_BUDGET);
    await writeFile(path.join(ygg, 'yg-architecture.yaml'), 'node_types:\n  widget:\n    description: w\n');
    await writeNode(ygg, 'w', 'name: W\ntype: widget\ndescription: x\naspects:\n  - det\nmapping:\n  - src/big.ts\n');
    await writeDetAspect(ygg, 'det');
    await writeSrc(dir, 'src/big.ts', 'x'.repeat(400) + '\n');
    // Deterministic-only → not LLM-reviewed → no budget, despite a 400-char file.
    expect(await oversizedCount(dir)).toBe(0);

    // Attach an LLM aspect as a TYPE DEFAULT for widget — now the node is reviewed.
    await writeFile(
      path.join(ygg, 'yg-architecture.yaml'),
      'node_types:\n  widget:\n    description: w\n    aspects:\n      - llmrule\n',
    );
    await writeLlmAspect(ygg, 'llmrule');
    const issues = (await runCheck(await loadGraph(dir), null)).issues.filter((i) => i.code === 'oversized-node');
    expect(issues).toHaveLength(1);
    expect(issues[0].nodePath).toBe('w');
  });

  it('adding an LLM aspect via a FLOW brings a deterministic-only node under the budget', async () => {
    const { dir, ygg } = await freshProject(TINY_BUDGET);
    await writeFile(path.join(ygg, 'yg-architecture.yaml'), 'node_types:\n  service:\n    description: s\n');
    await writeNode(ygg, 'svc', 'name: Svc\ntype: service\ndescription: parent\n');
    await writeNode(ygg, 'svc/a', 'name: A\ntype: service\ndescription: x\naspects:\n  - det\nmapping:\n  - src/big.ts\n');
    await writeDetAspect(ygg, 'det');
    await writeLlmAspect(ygg, 'llmrule');
    await writeSrc(dir, 'src/big.ts', 'x'.repeat(400) + '\n');
    expect(await oversizedCount(dir)).toBe(0);

    // A flow attaches the LLM aspect to svc/a.
    await writeFlow(ygg, 'f1', 'name: F1\ndescription: d\nnodes:\n  - svc/a\naspects:\n  - llmrule\n');
    expect(await oversizedCount(dir)).toBe(1);
  });

  it('adding an LLM aspect via IMPLIES (a deterministic aspect implying an LLM one) brings the node under the budget', async () => {
    const { dir, ygg } = await freshProject(TINY_BUDGET);
    await writeFile(path.join(ygg, 'yg-architecture.yaml'), 'node_types:\n  service:\n    description: s\n');
    await writeNode(ygg, 'a', 'name: A\ntype: service\ndescription: x\naspects:\n  - det\nmapping:\n  - src/big.ts\n');
    await writeDetAspect(ygg, 'det');
    await writeLlmAspect(ygg, 'llmrule');
    await writeSrc(dir, 'src/big.ts', 'x'.repeat(400) + '\n');
    expect(await oversizedCount(dir)).toBe(0);

    // Make the deterministic aspect imply the LLM aspect.
    await writeDetAspect(ygg, 'det', { implies: ['llmrule'] });
    expect(await oversizedCount(dir)).toBe(1);
  });

  it('a DRAFT LLM aspect leaves the node unbounded; flipping it to advisory or enforced makes it bounded', async () => {
    const { dir, ygg } = await freshProject(TINY_BUDGET);
    await writeFile(path.join(ygg, 'yg-architecture.yaml'), 'node_types:\n  service:\n    description: s\n');
    await writeNode(ygg, 'a', 'name: A\ntype: service\ndescription: x\naspects:\n  - llmrule\nmapping:\n  - src/big.ts\n');
    await writeLlmAspect(ygg, 'llmrule', 'draft');
    await writeSrc(dir, 'src/big.ts', 'x'.repeat(400) + '\n');
    // Draft LLM aspect → never reviewed → no budget.
    expect(await oversizedCount(dir)).toBe(0);

    await writeLlmAspect(ygg, 'llmrule', 'advisory');
    expect(await oversizedCount(dir)).toBe(1);

    await writeLlmAspect(ygg, 'llmrule', 'enforced');
    expect(await oversizedCount(dir)).toBe(1);
  });
});

// ===========================================================================
// SECTION E — E2E: spawn the binary, prove the flow-aspect-add cascade end to
// end against a copy of the e2e-lifecycle fixture (deterministic, no LLM).
// ===========================================================================

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'e2e-lifecycle');
const distExists = existsSync(BIN_PATH);
const DEAD_ENDPOINT = 'http://127.0.0.1:1';

function runCli(args: string[], cwd: string): { status: number | null; all: string } {
  const r = spawnSync('node', [BIN_PATH, ...args], { cwd, encoding: 'utf-8' });
  return { status: r.status, all: (r.stdout ?? '') + (r.stderr ?? '') };
}

/**
 * Copy the e2e-lifecycle fixture into a fresh temp dir, strip the LLM
 * `has-doc-comment` aspect (so every effective aspect is deterministic), and
 * point the reviewer endpoint at a dead loopback address. Fully hermetic — no
 * network host, no LLM call.
 */
function deterministicFixture(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-bounty3-e2e-${label}-`));
  cpSync(FIXTURE, dir, { recursive: true });
  const archPath = path.join(dir, '.yggdrasil', 'yg-architecture.yaml');
  writeFileSync(
    archPath,
    readFileSync(archPath, 'utf-8').split('\n').filter((l) => l.trim() !== '- has-doc-comment').join('\n'),
    'utf-8',
  );
  rmSync(path.join(dir, '.yggdrasil', 'aspects', 'has-doc-comment'), { recursive: true, force: true });
  const cfgPath = path.join(dir, '.yggdrasil', 'yg-config.yaml');
  writeFileSync(
    cfgPath,
    readFileSync(cfgPath, 'utf-8').replace(/endpoint:\s*["']?[^"'\n]+["']?/, `endpoint: "${DEAD_ENDPOINT}"`),
    'utf-8',
  );
  return dir;
}

describe.skipIf(!distExists)('cascade E2E: flow-aspect-add cascades to every participant (deterministic)', () => {
  it('adding a deterministic aspect to the order-processing flow drifts BOTH participants; exit 1; --aspect re-approve clears it', () => {
    const dir = deterministicFixture('flow-add');
    try {
      // Author a NEW deterministic aspect (zero-cost, no reviewer needed).
      const aspDir = path.join(dir, '.yggdrasil', 'aspects', 'extra-det');
      mkdirSync(aspDir, { recursive: true });
      writeFileSync(
        path.join(aspDir, 'yg-aspect.yaml'),
        'name: ExtraDet\ndescription: An extra deterministic rule attached via the flow.\nreviewer:\n  type: deterministic\nstatus: enforced\n',
        'utf-8',
      );
      writeFileSync(path.join(aspDir, 'check.mjs'), 'export function check(ctx) { return []; }\n', 'utf-8');

      // Settle a clean baseline for both flow participants.
      expect(runCli(['approve', '--node', 'services/orders'], dir).status).toBe(0);
      expect(runCli(['approve', '--node', 'services/payments'], dir).status).toBe(0);
      expect(runCli(['check'], dir).status).toBe(0);

      // Add the new aspect to the flow → it becomes effective on every participant.
      const flowPath = path.join(dir, '.yggdrasil', 'flows', 'order-processing', 'yg-flow.yaml');
      writeFileSync(
        flowPath,
        readFileSync(flowPath, 'utf-8').replace('aspects:\n  - no-todo-comments', 'aspects:\n  - no-todo-comments\n  - extra-det'),
        'utf-8',
      );

      const drifted = runCli(['check'], dir);
      expect(drifted.status).toBe(1);
      // BOTH participants are newly subject to the flow aspect.
      expect(drifted.all).toContain('services/orders');
      expect(drifted.all).toContain('services/payments');
      // The new aspect is named and the cascade points at the documented clear.
      expect(drifted.all).toContain('extra-det');
      expect(drifted.all).toContain('yg approve --aspect extra-det');

      // The deterministic --aspect batch re-approve clears it at zero LLM cost.
      const reapprove = runCli(['approve', '--aspect', 'extra-det'], dir);
      expect(reapprove.status).toBe(0);
      expect(runCli(['check'], dir).status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
