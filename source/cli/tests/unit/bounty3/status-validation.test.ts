/**
 * Bounty-hunt: aspect status subsystem — downgrade rejection, status_inherit,
 * drift-on-change, and the render flip (warning <-> blocking error).
 *
 * Target invariants (any break ⇒ false-green / lost drift / wrong verdict):
 *   I1. Effective status = max() across all cascading channels (1–6) + implies.
 *   I2. A silent downgrade attempt at an attach site is a validator error.
 *   I3. status_inherit (strictest vs own-default) governs implies-edge promotion,
 *       but can never LOWER an aspect below a value reaching it via a direct
 *       channel (max still wins).
 *   I4. draft -> advisory/enforced causes drift (newly-active, no baseline yet).
 *   I5. advisory <-> enforced is NOT a drift cause (hash stable) but FLIPS how a
 *       refused baseline renders: advisory => warning (exit 0), enforced =>
 *       blocking error (exit 1). The SAME baseline, no re-approve, must reclassify.
 *   I6. A draft aspect is skipped by the reviewer / produces no per-aspect finding.
 *
 * These tests deliberately attack edges the existing suites (validator-aspect-
 * status, aspect-status-downgrade-blocks, aspect-status-lifecycle,
 * aspect-status-hash-stability, bounty/eff-status, core/graph/aspect-status,
 * core/check-aspect-status) do NOT already cover — see gapsFound in the report.
 *
 * Hermetic: pure in-memory graphs for the validator/effective-status edges;
 * fresh mkdtemp temp repos for the drift / render-flip edges; the spawn E2E uses
 * the in-process Ollama-protocol mock reviewer (no network, no real model).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync, cpSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { validate } from '../../../src/core/validator.js';
import { checkAspectStatusDowngrade } from '../../../src/core/checks/aspect-contracts.js';
import { computeEffectiveAspectStatuses } from '../../../src/core/graph/aspects.js';
import { buildTestGraph, cleanupTestGraphs } from '../helpers/build-test-graph.js';
import { loadGraph } from '../../../src/core/graph-loader.js';
import { classifyDrift, runCheck } from '../../../src/core/check.js';
import { writeNodeDriftState } from '../../../src/io/drift-state-store.js';
import { hashTrackedFiles } from '../../../src/io/hash.js';
import { collectTrackedFiles } from '../../../src/core/graph/files.js';
import { DRIFT_STATE_SCHEMA_VERSION } from '../../../src/model/drift.js';
import type { DriftNodeState } from '../../../src/model/drift.js';
import type { Graph, GraphNode, AspectDef, ArchitectureDef, FlowDef, AspectStatus } from '../../../src/model/graph.js';

import { startMockReviewer, runAsync, type ChatReply, type ChatRequest } from '../../e2e/support/mock-reviewer.js';

// ============================================================================
// Local in-memory builders (mirror tests/unit/bounty/eff-status.test.ts style)
// ============================================================================

function makeAspect(id: string, status: AspectStatus = 'enforced', extra: Partial<AspectDef> = {}): AspectDef {
  return {
    id,
    name: id,
    reviewer: { type: 'llm' },
    artifacts: [{ filename: 'content.md', content: 'rule' }],
    status,
    ...extra,
  } as AspectDef;
}

function makeNode(p: string, type: string, aspects: string[] = [], aspectStatus?: Record<string, AspectStatus>): GraphNode {
  return { path: p, meta: { name: p, type, aspects, aspectStatus }, children: [], parent: null } as GraphNode;
}

function link(parent: GraphNode, child: GraphNode): void {
  child.parent = parent;
  parent.children.push(child);
}

function makeGraph(aspects: AspectDef[], nodes: GraphNode[] = [], opts: { flows?: FlowDef[]; architecture?: ArchitectureDef | null } = {}): Graph {
  return {
    aspects,
    nodes: new Map(nodes.map((n) => [n.path, n])),
    flows: opts.flows ?? [],
    architecture: opts.architecture ?? null,
  } as unknown as Graph;
}

// ============================================================================
// SECTION 1 — Downgrade rejection: the validator must catch a silent downgrade
//             at ANY attach site. (Invariant I2 + I1.)
// ============================================================================

describe('downgrade rejection — coverage of branches the existing suites skip', () => {
  afterEach(() => cleanupTestGraphs());

  // Existing validator-aspect-status.test.ts covers: own < default, own == default,
  // own > default, flow-vs-own cross channel, single-source fallback. It never
  // exercises a node that raises status ABOVE the default and below another raise,
  // nor a redundant-but-equal multi-channel set, nor the bump-not-downgrade rule
  // for type/port channels in isolation.

  it('bump above default on one channel + default on another → NO downgrade (raise is legal)', async () => {
    // aspect default advisory. parent explicitly raises to enforced (ch2),
    // child uses default (advisory, ch1 via own-list with no aspectStatus).
    // The raise must NOT be flagged; only DOWNGRADES are errors.
    const graph = buildTestGraph({
      aspects: [{ id: 'a', status: 'advisory' }],
      nodes: [
        { path: 'p', type: 'module', aspects: ['a'], aspectStatus: { a: 'enforced' } },
        { path: 'p/c', type: 'service', aspects: ['a'], parent: 'p' },
      ],
    });
    const { issues } = await validate(graph);
    expect(issues.some((i) => i.code === 'aspect-status-downgrade')).toBe(false);
  });

  it('type-channel explicit status equal to default → no downgrade (equal is legal)', () => {
    const aspect = makeAspect('a', 'enforced');
    const node = makeNode('n', 'service', ['a']);
    const architecture: ArchitectureDef = {
      node_types: { service: { description: 's', aspects: ['a'], aspectStatus: { a: 'enforced' } } },
    };
    const issues = checkAspectStatusDowngrade(makeGraph([aspect], [node], { architecture }));
    expect(issues).toHaveLength(0);
  });

  it('port-channel explicit advisory below enforced default, port is the ONLY source → downgrade fires on the consuming node', () => {
    // Channel 6 in isolation: the port declares 'a' at advisory while the aspect
    // default is enforced and no other channel supplies the aspect. The anchor
    // therefore falls back to the aspect default → downgrade.
    const aspect = makeAspect('a', 'enforced');
    const target: GraphNode = {
      path: 'svc',
      meta: { name: 'svc', type: 'service', ports: { p: { description: '', aspects: ['a'], aspectStatus: { a: 'advisory' } } } },
      children: [],
      parent: null,
    } as GraphNode;
    const consumer = makeNode('c', 'service');
    consumer.meta.relations = [{ target: 'svc', type: 'calls', consumes: ['p'] }];
    const issues = checkAspectStatusDowngrade(makeGraph([aspect], [target, consumer]));
    const onConsumer = issues.filter((i) => i.nodePath === 'c' && i.code === 'aspect-status-downgrade');
    expect(onConsumer.length).toBeGreaterThan(0);
    expect(onConsumer[0].messageData.what).toContain('port:p@svc');
  });

  it('draft-default aspect explicitly raised to advisory on one channel → no downgrade (raise from draft floor)', async () => {
    const graph = buildTestGraph({
      aspects: [{ id: 'a', status: 'draft' }],
      nodes: [{ path: 'n', type: 'service', aspects: ['a'], aspectStatus: { a: 'advisory' } }],
    });
    const { issues } = await validate(graph);
    expect(issues.some((i) => i.code === 'aspect-status-downgrade')).toBe(false);
  });

  // ── The headline gap: COLLUDING low sources defeat the anchor ──────────────
  // The downgrade anchor for each explicit source is max(OTHER sources' declared).
  // The aspect-level DEFAULT only becomes the anchor when there are NO other
  // sources (otherDeclared.length === 0). So when 2+ channels EACH explicitly
  // declare the same value below the default, every source's anchor is that same
  // low value → STATUS_ORDER[declared] < STATUS_ORDER[anchor] is false for all of
  // them → ZERO downgrade errors, even though the effective status sits below the
  // aspect default (a silent downgrade). This BREAKS I2.

  it('two explicit advisory channels on one node (default enforced) → downgrade IS flagged', () => {
    const aspect = makeAspect('a', 'enforced');
    const node = makeNode('n', 'service', ['a'], { a: 'advisory' }); // ch1 explicit advisory
    const flow: FlowDef = { path: 'f', name: 'f', nodes: ['n'], aspects: ['a'], aspectStatus: { a: 'advisory' } } as FlowDef; // ch5 explicit advisory
    const graph = makeGraph([aspect], [node], { flows: [flow] });

    const effective = computeEffectiveAspectStatuses(node, graph).get('a');
    // Effective status sits below the enforced default — a downgrade.
    expect(effective).toBe('advisory');

    // FIXED: the anchor always includes the aspect-level default, so two channels
    // colluding on the same sub-default value no longer escape detection.
    const issues = checkAspectStatusDowngrade(graph);
    expect(issues.filter((i) => i.code === 'aspect-status-downgrade').length).toBeGreaterThan(0);
  });

  it('single explicit advisory below enforced default (control) → downgrade DOES fire', () => {
    // Same shape as the bounty but with exactly ONE explicit source: the anchor
    // correctly falls back to the aspect default and the downgrade is caught.
    const aspect = makeAspect('a', 'enforced');
    const node = makeNode('n', 'service', ['a'], { a: 'advisory' });
    const issues = checkAspectStatusDowngrade(makeGraph([aspect], [node]));
    expect(issues.filter((i) => i.code === 'aspect-status-downgrade').length).toBeGreaterThan(0);
  });

  it('child with parent+own BOTH explicit advisory (default enforced) → BOTH flagged', () => {
    // Cross-node form of the collusion: the child sees ch1(own) and ch2(parent)
    // both at advisory. FIXED: the anchor includes the aspect default (enforced),
    // so the child's advisory is below it and is flagged too — no deep node can
    // silently relax an enforced aspect by colluding across channels.
    const aspect = makeAspect('a', 'enforced');
    const parent = makeNode('p', 'module', ['a'], { a: 'advisory' });
    const child = makeNode('p/c', 'service', ['a'], { a: 'advisory' });
    link(parent, child);
    const graph = makeGraph([aspect], [parent, child]);

    expect(computeEffectiveAspectStatuses(child, graph).get('a')).toBe('advisory');

    const issues = checkAspectStatusDowngrade(graph);
    expect(issues.filter((i) => i.nodePath === 'p').length).toBeGreaterThan(0); // parent caught
    expect(issues.filter((i) => i.nodePath === 'p/c').length).toBeGreaterThan(0); // child now caught too (fixed)
  });

  it('implies edge (channel 7) is NOT subject to downgrade detection — by design', () => {
    // status_inherit: own-default on an implies edge can drop the implied aspect's
    // effective status to its own (lower) default. getAspectStatusSources only
    // walks channels 1–6, so the implies edge never produces an AttachSource and
    // the downgrade check cannot see it. Characterization: no false positive here.
    const a = makeAspect('a', 'enforced', { implies: ['b'], impliesStatusInherit: { b: 'own-default' } });
    const b = makeAspect('b', 'advisory');
    const node = makeNode('n', 'service', ['a']);
    const graph = makeGraph([a, b], [node]);
    // b reaches the node only via implies, lands at advisory (own default).
    expect(computeEffectiveAspectStatuses(node, graph).get('b')).toBe('advisory');
    // No downgrade error: implies is not an attach site.
    expect(checkAspectStatusDowngrade(graph).filter((i) => i.code === 'aspect-status-downgrade')).toHaveLength(0);
  });
});

// ============================================================================
// SECTION 2 — status_inherit max-floor invariant (I3). A direct-channel value
//             always wins over an implies-edge own-default that is lower, across
//             the port/type/flow channels (existing eff-status only covers own +
//             parent for this floor).
// ============================================================================

describe('status_inherit cannot lower below a direct-channel value (max floor)', () => {
  it('own-default implies B(draft), B also enforced via PORT channel → B enforced', () => {
    const a = makeAspect('a', 'enforced', { implies: ['b'], impliesStatusInherit: { b: 'own-default' } });
    const b = makeAspect('b', 'draft');
    const target: GraphNode = {
      path: 'svc',
      meta: { name: 'svc', type: 'service', ports: { p: { description: '', aspects: ['b'], aspectStatus: { b: 'enforced' } } } },
      children: [],
      parent: null,
    } as GraphNode;
    const consumer = makeNode('c', 'service', ['a']);
    consumer.meta.relations = [{ target: 'svc', type: 'calls', consumes: ['p'] }];
    const r = computeEffectiveAspectStatuses(consumer, makeGraph([a, b], [target, consumer]));
    expect(r.get('b')).toBe('enforced');
  });

  it('own-default implies B(advisory), B also enforced via ARCH TYPE channel → B enforced', () => {
    const a = makeAspect('a', 'enforced', { implies: ['b'], impliesStatusInherit: { b: 'own-default' } });
    const b = makeAspect('b', 'advisory');
    const node = makeNode('n', 'service', ['a']);
    const architecture: ArchitectureDef = {
      node_types: { service: { description: 's', aspects: ['b'], aspectStatus: { b: 'enforced' } } },
    };
    const r = computeEffectiveAspectStatuses(node, makeGraph([a, b], [node], { architecture }));
    expect(r.get('b')).toBe('enforced');
  });

  it('own-default implies B(draft), B also advisory via FLOW channel → B advisory (own-default does not raise it)', () => {
    const a = makeAspect('a', 'enforced', { implies: ['b'], impliesStatusInherit: { b: 'own-default' } });
    const b = makeAspect('b', 'draft');
    const node = makeNode('n', 'service', ['a']);
    const flow: FlowDef = { path: 'f', name: 'f', nodes: ['n'], aspects: ['b'], aspectStatus: { b: 'advisory' } } as FlowDef;
    const r = computeEffectiveAspectStatuses(node, makeGraph([a, b], [node], { flows: [flow] }));
    // own-default keeps the implied edge at draft; the flow channel raises to advisory.
    expect(r.get('b')).toBe('advisory');
  });

  it('strictest from an ADVISORY implier does NOT lower an enforced implied (max(advisory, enforced) = enforced)', () => {
    const a = makeAspect('a', 'advisory', { implies: ['b'], impliesStatusInherit: { b: 'strictest' } });
    const b = makeAspect('b', 'enforced');
    const node = makeNode('n', 'service', ['a']);
    const r = computeEffectiveAspectStatuses(node, makeGraph([a, b], [node]));
    expect(r.get('b')).toBe('enforced');
  });
});

// ============================================================================
// Temp-repo helpers for SECTION 3/4 (drift-on-change + render flip).
// Direct baseline writes (no LLM) — mirrors core/check-aspect-status.test.ts.
// ============================================================================

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMAS_SRC = path.join(__dirname, '..', '..', 'fixtures', 'sample-project', '.yggdrasil', 'schemas');

const tmpRepos: string[] = [];

function makeRepo(aspectStatus: AspectStatus): string {
  const repo = mkdtempSync(path.join(tmpdir(), 'yg-bounty3-status-'));
  tmpRepos.push(repo);
  const ygg = path.join(repo, '.yggdrasil');
  mkdirSync(path.join(ygg, 'schemas'), { recursive: true });
  mkdirSync(path.join(ygg, 'aspects', 'a'), { recursive: true });
  mkdirSync(path.join(ygg, 'model', 'svc'), { recursive: true });
  mkdirSync(path.join(repo, 'src'), { recursive: true });
  for (const schema of ['yg-node.yaml', 'yg-aspect.yaml', 'yg-flow.yaml']) {
    copyFileSync(path.join(SCHEMAS_SRC, schema), path.join(ygg, 'schemas', schema));
  }
  writeFileSync(path.join(repo, 'src', 'svc.ts'), 'export const x = 1;\n', 'utf-8');
  writeFileSync(
    path.join(ygg, 'yg-config.yaml'),
    'version: "5.0.0"\nreviewer:\n  tiers:\n    standard:\n      provider: claude-code\n      consensus: 1\n      config:\n        model: sonnet\n',
    'utf-8',
  );
  writeFileSync(
    path.join(ygg, 'yg-architecture.yaml'),
    'node_types:\n  service:\n    description: Service\n    log_required: false\n    when:\n      path: "src/**"\n',
    'utf-8',
  );
  setAspectStatusFile(repo, aspectStatus);
  writeFileSync(path.join(ygg, 'aspects', 'a', 'content.md'), '# A\n', 'utf-8');
  writeFileSync(
    path.join(ygg, 'model', 'svc', 'yg-node.yaml'),
    'name: svc\ntype: service\ndescription: svc node\nmapping:\n  - src/svc.ts\naspects:\n  - a\n',
    'utf-8',
  );
  writeFileSync(path.join(ygg, 'model', 'svc', 'log.md'), '', 'utf-8');
  return repo;
}

function setAspectStatusFile(repo: string, status: AspectStatus): void {
  writeFileSync(
    path.join(repo, '.yggdrasil', 'aspects', 'a', 'yg-aspect.yaml'),
    `name: A\ndescription: t\nreviewer:\n  type: llm\nstatus: ${status}\n`,
    'utf-8',
  );
}

/**
 * Record a baseline for svc with the given verdicts, folding the SAME verdicts
 * into the canonical hash (mirrors production approve). Returns the recorded
 * canonical hash so callers can assert hash-stability across status flips.
 */
async function recordBaseline(repo: string, verdicts: DriftNodeState['aspectVerdicts']): Promise<string> {
  const graph = await loadGraph(repo);
  const node = graph.nodes.get('svc')!;
  const { trackedFiles, identity } = collectTrackedFiles(node, graph);
  const projectRoot = path.dirname(graph.rootPath);
  const { canonicalHash, fileHashes, fileMtimes } = await hashTrackedFiles(
    projectRoot, trackedFiles, undefined, [], identity, verdicts,
  );
  await writeNodeDriftState(graph.rootPath, 'svc', {
    schemaVersion: DRIFT_STATE_SCHEMA_VERSION,
    hash: canonicalHash,
    files: fileHashes,
    mtimes: fileMtimes,
    identity,
    aspectVerdicts: verdicts,
  });
  return canonicalHash;
}

// ============================================================================
// SECTION 3 — Render flip: SAME refused baseline, flip aspect default
//             advisory <-> enforced, NO re-approve. (Invariant I5.)
//             The existing lifecycle test RE-APPROVES between flips; here we
//             prove the verdict reclassifies from the SAME stored verdict with
//             NO new approve, AND that the status change alone does not drift.
// ============================================================================

describe('render flip: one refused baseline reclassifies on advisory <-> enforced (no re-approve)', () => {
  afterEach(() => {
    while (tmpRepos.length > 0) rmSync(tmpRepos.pop()!, { recursive: true, force: true });
  });

  it('advisory: refused baseline → warning (no error)', async () => {
    const repo = makeRepo('advisory');
    await recordBaseline(repo, { a: { verdict: 'refused', reason: 'nope', errorSource: 'codeViolation' } });
    const graph = await loadGraph(repo);
    const issues = await classifyDrift(graph);
    expect(issues.filter((i) => i.code === 'aspect-violation-advisory' && i.severity === 'warning')).toHaveLength(1);
    expect(issues.filter((i) => i.code === 'aspect-violation-enforced')).toHaveLength(0);
  });

  it('enforced: the SAME refused baseline → blocking error (no re-approve, verdict reused)', async () => {
    const repo = makeRepo('advisory');
    // Record the refused baseline while the aspect is advisory.
    await recordBaseline(repo, { a: { verdict: 'refused', reason: 'nope', errorSource: 'codeViolation' } });
    // Flip the aspect default advisory -> enforced. Do NOT re-approve, do NOT
    // touch source. The stored verdict is untouched.
    setAspectStatusFile(repo, 'enforced');
    const graph = await loadGraph(repo);
    const issues = await classifyDrift(graph);
    // Same stored refused verdict now renders as a blocking enforced error.
    expect(issues.filter((i) => i.code === 'aspect-violation-enforced' && i.severity === 'error')).toHaveLength(1);
    expect(issues.filter((i) => i.code === 'aspect-violation-advisory')).toHaveLength(0);
  });

  it('hash stability: the advisory<->enforced flip alone produces NO source/upstream drift', async () => {
    // I5 says advisory<->enforced is NOT a drift cause. Record an APPROVED
    // baseline at advisory, flip to enforced, and assert there is no
    // source-drift / upstream-drift / baseline-integrity for svc — only the
    // verdict-render path may differ (and here, approved, it stays silent).
    const repo = makeRepo('advisory');
    await recordBaseline(repo, { a: { verdict: 'approved' } });
    setAspectStatusFile(repo, 'enforced');
    const graph = await loadGraph(repo);
    const issues = await classifyDrift(graph);
    const driftish = issues.filter(
      (i) =>
        i.nodePath === 'svc' &&
        (i.code === 'source-drift' || i.code === 'upstream-drift' || i.code === 'baseline-integrity' || i.code === 'aspect-newly-active'),
    );
    expect(driftish).toHaveLength(0);
  });

  it('runCheck end-to-end: refused+advisory PASSES (exit-0 semantics), refused+enforced FAILS', async () => {
    // Advisory: only a warning → no error severity issues for svc.
    const repoAdv = makeRepo('advisory');
    await recordBaseline(repoAdv, { a: { verdict: 'refused', reason: 'soft', errorSource: 'codeViolation' } });
    const advResult = await runCheck(await loadGraph(repoAdv), null);
    expect(advResult.issues.some((i) => i.code === 'aspect-violation-advisory')).toBe(true);
    expect(advResult.issues.filter((i) => i.severity === 'error')).toHaveLength(0);
    expect(advResult.advisoryWarnings).toBe(1);

    // Enforced: the violation is now an error.
    const repoEnf = makeRepo('enforced');
    await recordBaseline(repoEnf, { a: { verdict: 'refused', reason: 'hard', errorSource: 'codeViolation' } });
    const enfResult = await runCheck(await loadGraph(repoEnf), null);
    expect(enfResult.issues.some((i) => i.code === 'aspect-violation-enforced' && i.severity === 'error')).toBe(true);
  });
});

// ============================================================================
// SECTION 4 — drift-on-change for draft -> non-draft (I4) and draft silence (I6).
// ============================================================================

describe('draft lifecycle drift-on-change', () => {
  afterEach(() => {
    while (tmpRepos.length > 0) rmSync(tmpRepos.pop()!, { recursive: true, force: true });
  });

  it('draft aspect: classifyDrift produces NO per-aspect finding and NO baseline requirement', async () => {
    const repo = makeRepo('draft');
    const graph = await loadGraph(repo);
    const issues = await classifyDrift(graph);
    // Draft is dormant: no newly-active, no unapproved, no violation.
    expect(
      issues.filter(
        (i) =>
          i.nodePath === 'svc' &&
          (i.code === 'aspect-newly-active' ||
            i.code === 'unapproved' ||
            i.code === 'aspect-violation-advisory' ||
            i.code === 'aspect-violation-enforced'),
      ),
    ).toHaveLength(0);
  });

  it('draft -> advisory with no baseline → aspect-newly-active OR unapproved (drift appears)', async () => {
    // Start draft (dormant), then promote to advisory. With no baseline, the
    // node now has a non-draft effective aspect that was never reviewed → drift.
    const repo = makeRepo('draft');
    // No baseline written at all (draft node never tracked).
    setAspectStatusFile(repo, 'advisory');
    const graph = await loadGraph(repo);
    const issues = await classifyDrift(graph);
    const svcDrift = issues.filter(
      (i) => i.nodePath === 'svc' && (i.code === 'aspect-newly-active' || i.code === 'unapproved'),
    );
    expect(svcDrift.length).toBeGreaterThan(0);
  });

  it('draft -> enforced with an EXISTING approved baseline but no verdict for the aspect → aspect-newly-active', async () => {
    // Subtle: a baseline exists (from a prior life) but carries no verdict for
    // aspect `a`. Promoting `a` from draft to enforced makes it effective and
    // newly-active, even though the file hash did not change.
    const repo = makeRepo('draft');
    // Write a baseline WITH empty verdicts while still draft. classifyDrift's
    // early-out (hasNonDraftEffectiveAspects=false) means this baseline is dormant.
    await recordBaseline(repo, {});
    setAspectStatusFile(repo, 'enforced');
    const graph = await loadGraph(repo);
    const issues = await classifyDrift(graph);
    const newly = issues.filter((i) => i.nodePath === 'svc' && i.code === 'aspect-newly-active');
    expect(newly).toHaveLength(1);
    expect(newly[0].messageData.what).toContain('enforced');
  });
});

// ============================================================================
// SECTION 5 — E2E spawn against the real binary (hermetic mock reviewer).
//             Proves the draft-skip + draft->advisory newly-active flip through
//             the actual CLI process and exit codes. (I4 + I6 + render flip.)
// ============================================================================

const CLI_ROOT = path.join(__dirname, '..', '..', '..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'e2e-lifecycle');
const distExists = existsSync(BIN_PATH);

const e2eDirs: string[] = [];

function fixtureCopy(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-bounty3-e2e-${label}-`));
  e2eDirs.push(dir);
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

function pointReviewer(dir: string, endpoint: string): void {
  const p = path.join(dir, '.yggdrasil', 'yg-config.yaml');
  writeFileSync(p, readFileSync(p, 'utf-8').replace(/endpoint:\s*["']?[^"'\n]+["']?/, `endpoint: "${endpoint}"`), 'utf-8');
}

function setFixtureAspectStatus(dir: string, status: 'draft' | 'advisory' | 'enforced'): void {
  const p = path.join(dir, '.yggdrasil', 'aspects', 'has-doc-comment', 'yg-aspect.yaml');
  writeFileSync(p, readFileSync(p, 'utf-8').replace(/status:\s*\w+/, `status: ${status}`), 'utf-8');
}

const ALWAYS_OK: (r: ChatRequest, i: number) => ChatReply = () => ({ satisfied: true, reason: 'ok' });

describe.skipIf(!distExists)('E2E (spawn) — draft skip & draft->advisory newly-active via the real CLI', () => {
  afterEach(() => {
    while (e2eDirs.length > 0) rmSync(e2eDirs.pop()!, { recursive: true, force: true });
  });

  it('approve at enforced (mock approves all), then yg check exits 0; flipping has-doc-comment to draft keeps it 0', async () => {
    const dir = fixtureCopy('draftskip');
    const mock = await startMockReviewer({ respond: ALWAYS_OK });
    try {
      pointReviewer(dir, mock.endpoint);

      // Approve both service nodes (mock approves every aspect).
      const approve = await runAsync(['approve', '--node', 'services/orders', '--node', 'services/payments'], dir);
      expect(approve.status).toBe(0);

      // Baseline now exists; check is clean.
      const check1 = await runAsync(['check'], dir);
      expect(check1.status).toBe(0);

      // Flip the enforced LLM aspect to draft. A draft aspect is skipped by the
      // reviewer and must not introduce a newly-active / drift error. The other
      // deterministic aspects remain approved, so check stays 0.
      setFixtureAspectStatus(dir, 'draft');
      const check2 = await runAsync(['check'], dir);
      expect(check2.status).toBe(0);
      expect(check2.all).not.toContain('has-doc-comment');
    } finally {
      await mock.close();
    }
  });

  it('flip has-doc-comment draft -> advisory with no baseline for it → yg check reports it (newly-active) and exits 1', async () => {
    const dir = fixtureCopy('newlyactive');
    const mock = await startMockReviewer({ respond: ALWAYS_OK });
    try {
      pointReviewer(dir, mock.endpoint);

      // Start with has-doc-comment as draft so the first approve does NOT record
      // a verdict for it.
      setFixtureAspectStatus(dir, 'draft');
      const approve = await runAsync(['approve', '--node', 'services/orders', '--node', 'services/payments'], dir);
      expect(approve.status).toBe(0);

      const checkClean = await runAsync(['check'], dir);
      expect(checkClean.status).toBe(0);

      // Promote has-doc-comment draft -> advisory. It is now effective with no
      // baseline verdict → newly-active drift. (advisory does NOT skip the
      // initial verdict requirement.) check must fail.
      setFixtureAspectStatus(dir, 'advisory');
      const checkDrift = await runAsync(['check'], dir);
      expect(checkDrift.status).toBe(1);
      expect(checkDrift.all).toContain('has-doc-comment');
    } finally {
      await mock.close();
    }
  });
});
