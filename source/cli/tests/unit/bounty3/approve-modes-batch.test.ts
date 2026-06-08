/**
 * BOUNTY 3 — adversarial coverage for `yg approve` MODES + batch partial-failure +
 * exit codes.
 *
 * TARGET subsystem:
 *   - src/cli/approve.ts          (runBatch, formatBatchOutput, batch orchestration,
 *                                  the exit-code derivation `some/every action === 'refused'`)
 *   - src/core/approve.ts         (approveNode — real drift engine)
 *   - src/core/approve-cascade-select.ts (selectDriftedAspects — carry-forward selection)
 *
 * What the EXISTING tests already cover (NOT duplicated here):
 *   - run-batch.test.ts            : runBatch order / concurrency / each-once
 *   - approve-action-guards.test.ts: runBatch single + concurrent throw isolation; --dry-run guard
 *   - approve-batch.test.ts        : filterCascadeNodes prefix matching
 *   - approve-aspect-cascade.test.ts: filterAspectCascadeNodes typed attribution
 *   - approve-flow-cascade.test.ts : filterFlowCascadeNodes participation
 *   - approve-select-drifted-aspects.test.ts: selectDriftedAspects basic cases
 *   - cli-llm-reviewer-mock.test.ts: SINGLE-node reviewer mechanics (approve/refuse/draft/...)
 *
 * GAPS this file adds — the high-value INVARIANTS that, if broken, mean a
 * false-green / lost drift / wrong verdict:
 *   1. runBatch exit-code aggregation: a batch with ANY refused node fails (exit 1),
 *      while no-change / initial / approved all count as NOT-failed. The
 *      `results.some(r => r.result.action === 'refused')` derivation is exercised
 *      directly across the full action matrix — the previous suites only test
 *      approved-vs-thrown, never the no-change / initial actions in the predicate.
 *   2. runBatch independence: a refused node does NOT abort or suppress the
 *      sibling's approved result (partial-failure isolation at the predicate level).
 *   3. selectDriftedAspects: a batch of upstream changes where ONE is
 *      un-attributable forces a full re-run (undefined) even if the others
 *      attribute cleanly — the conservative invariant.
 *   4. INTEGRATION (real approveNode + real classifyDrift): an aspect-only cascade
 *      yields a changedUpstream attributable to exactly one aspect, so
 *      selectDriftedAspects re-runs ONLY that aspect and carries the rest forward.
 *   5. E2E (spawned binary + in-process mock reviewer): multi-node `--node` batch
 *      partial failure exits 1, BOTH nodes are reported, the surviving node is
 *      approved, and `yg check` stays RED for the refused node (drift not lost).
 *      Plus `--aspect` cascade re-runs only the changed aspect, `--flow` cascade,
 *      Scenario-A draft no-op, no-cascade no-op, and all the target guards.
 *
 * Determinism: no randomness, no wall-clock reads inside assertions, temp trees
 * via mkdtemp under os.tmpdir() removed in finally/afterEach. The repo's own
 * files / src / .yggdrasil are never touched. The E2E mock binds an ephemeral
 * loopback port and is paired with ASYNC spawn (spawnSync would deadlock the
 * in-process server's event loop).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runBatch, type BatchResult } from '../../../src/cli/approve.js';
import { selectDriftedAspects } from '../../../src/cli/approve.js';
import type { LlmApproveResult } from '../../../src/cli/approve.js';
import type { ApproveResult, DriftNodeState, AnnotatedChange } from '../../../src/model/drift.js';
import { DRIFT_STATE_SCHEMA_VERSION } from '../../../src/model/drift.js';
import type { Graph, GraphNode, AspectDef } from '../../../src/model/graph.js';
import { loadGraph } from '../../../src/core/graph-loader.js';
import { classifyDrift } from '../../../src/core/check.js';
import { approveNode } from '../../../src/core/approve.js';
import { readNodeDriftState } from '../../../src/io/drift-state-store.js';
import { yggPrefixOf } from '../../../src/core/graph/files.js';
import { recordBaselineForAllMappedNodes } from '../helpers/seed-baseline.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// tests/unit/bounty3 -> tests/unit -> tests -> cli root
const CLI_ROOT = path.join(__dirname, '..', '..', '..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const E2E_FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'e2e-lifecycle');
const distExists = existsSync(BIN_PATH);

// ════════════════════════════════════════════════════════════════════════
// 1. runBatch — exit-code aggregation + partial-failure independence
// ════════════════════════════════════════════════════════════════════════
//
// The command derives the exit code from `results.some(r => r.result.action ===
// 'refused')` (multi --node branch and runBatchApprove's `.every(... !==
// 'refused')`). We re-derive the SAME predicate over the runBatch output and
// assert across the full action matrix. The headline invariant: ANY refused
// node ⇒ failure; no-change / initial / approved never count as failure.

const anyFailed = (results: BatchResult[]): boolean =>
  results.some(r => r.result.action === 'refused');
const allPassed = (results: BatchResult[]): boolean =>
  results.every(r => r.result.action !== 'refused');

describe('runBatch — exit-code aggregation invariant', () => {
  it('a single refused node makes the whole batch fail; siblings still run and are reported', async () => {
    const approveOne = async (nodePath: string): Promise<LlmApproveResult> => {
      if (nodePath === 'b') {
        return { action: 'refused', currentHash: '', refuseReasonData: { what: 'x', why: 'y', next: 'z' } };
      }
      return { action: 'approved', currentHash: 'h' };
    };
    const results = await runBatch(['a', 'b', 'c'], 1, approveOne);

    // All reported, in input order — independence: b's failure did not abort a or c.
    expect(results.map(r => r.nodePath)).toEqual(['a', 'b', 'c']);
    expect(results.find(r => r.nodePath === 'a')!.result.action).toBe('approved');
    expect(results.find(r => r.nodePath === 'c')!.result.action).toBe('approved');
    // The exit-code derivation: any refused ⇒ fail.
    expect(anyFailed(results)).toBe(true);
    expect(allPassed(results)).toBe(false);
  });

  it('no-change and initial actions count as NOT-failed (a cascade-only / first-approve batch passes)', async () => {
    // This is the gap: the existing suites only put `approved` (or a thrown
    // synthetic refused) through the predicate. A real batch routinely contains
    // `no-change` (cascade re-approve with carried-forward verdicts) and
    // `initial` (first approve). Neither must be mistaken for a failure.
    const approveOne = async (nodePath: string): Promise<LlmApproveResult> => {
      const action = ({ a: 'no-change', b: 'initial', c: 'approved' } as const)[nodePath]!;
      return { action, currentHash: 'h' };
    };
    const results = await runBatch(['a', 'b', 'c'], 2, approveOne);
    expect(results.map(r => r.result.action)).toEqual(['no-change', 'initial', 'approved']);
    expect(anyFailed(results)).toBe(false);
    expect(allPassed(results)).toBe(true);
  });

  it('a batch with EVERY action refused fails (no false-green)', async () => {
    const approveOne = async (): Promise<LlmApproveResult> =>
      ({ action: 'refused', currentHash: '', refuseReasonData: { what: 'x', why: 'y', next: 'z' } });
    const results = await runBatch(['a', 'b'], 2, approveOne);
    expect(anyFailed(results)).toBe(true);
    expect(allPassed(results)).toBe(false);
  });

  it('mixed approved + no-change + refused under concurrency>1 — order preserved, failure detected', async () => {
    const approveOne = async (nodePath: string): Promise<LlmApproveResult> => {
      // Vary completion order vs input order to stress the index-keyed write.
      const delay = nodePath === 'first' ? 15 : 1;
      await new Promise(r => setTimeout(r, delay));
      if (nodePath === 'mid') {
        return { action: 'refused', currentHash: '', refuseReasonData: { what: 'x', why: 'y', next: 'z' } };
      }
      return { action: nodePath === 'first' ? 'approved' : 'no-change', currentHash: 'h' };
    };
    const results = await runBatch(['first', 'mid', 'last'], 3, approveOne);
    expect(results.map(r => r.nodePath)).toEqual(['first', 'mid', 'last']);
    expect(results[0].result.action).toBe('approved');
    expect(results[1].result.action).toBe('refused');
    expect(results[2].result.action).toBe('no-change');
    expect(anyFailed(results)).toBe(true);
  });

  it('the skippedDraftAspects mirror is populated from each result (footer tally source)', async () => {
    const approveOne = async (nodePath: string): Promise<LlmApproveResult> =>
      nodePath === 'a'
        ? { action: 'no-change', currentHash: '', skippedDraftAspects: ['wip-rule'] }
        : { action: 'approved', currentHash: 'h' };
    const results = await runBatch(['a', 'b'], 2, approveOne);
    expect(results.find(r => r.nodePath === 'a')!.skippedDraftAspects).toEqual(['wip-rule']);
    // Missing skippedDraftAspects defaults to [] (so the footer reduce never NaNs).
    expect(results.find(r => r.nodePath === 'b')!.skippedDraftAspects).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════════════
// 2. selectDriftedAspects — conservative full re-run on a mixed upstream batch
// ════════════════════════════════════════════════════════════════════════
//
// The existing suite tests single-cause results. The high-value invariant is
// the LOOP in selectDriftedAspects: if ANY upstream change has no non-draft
// owner, the whole node goes node-global (undefined), even when the other
// changes attribute cleanly. Missing this would re-run too few aspects and
// silently carry forward a verdict that should have been recomputed.

const NODE = 'orders/handler';

function aspectDef(id: string, type: 'llm' | 'deterministic'): AspectDef {
  return { id, name: id, reviewer: { type }, artifacts: [] } as AspectDef;
}

function miniGraph(ownAspects: string[], aspects: AspectDef[]): Graph {
  const node: GraphNode = {
    path: NODE,
    meta: { name: 'handler', type: 'command', aspects: ownAspects },
    children: [],
    parent: null,
  } as GraphNode;
  return {
    nodes: new Map<string, GraphNode>([[NODE, node]]),
    aspects,
    flows: [],
    architecture: { node_types: {} },
  } as unknown as Graph;
}

const STORED_VERDICTS: DriftNodeState = {
  schemaVersion: DRIFT_STATE_SCHEMA_VERSION,
  hash: 'h',
  files: {},
  identity: { ownSubset: 'o', ports: {}, aspects: {} },
  aspectVerdicts: { llmA: { verdict: 'approved' }, llmB: { verdict: 'approved' } },
};

function result(over: Partial<ApproveResult>): ApproveResult {
  return { action: 'no-change', currentHash: 'h', ...over };
}
function upstream(...paths: string[]): AnnotatedChange[] {
  return paths.map(p => ({ filePath: p, annotation: 'x' }));
}

describe('selectDriftedAspects — mixed upstream batch is conservative', () => {
  const aspects = [aspectDef('llmA', 'llm'), aspectDef('llmB', 'llm')];

  it('one attributable + one un-attributable upstream change ⇒ undefined (full re-run)', () => {
    const graph = miniGraph(['llmA', 'llmB'], aspects);
    const r = result({
      changedUpstream: upstream(
        '.yggdrasil/aspects/llmA/content.md', // attributable to llmA
        '.yggdrasil/model/orders/yg-node.yaml', // parent metadata — un-attributable
      ),
    });
    expect(selectDriftedAspects(graph, NODE, r, STORED_VERDICTS, '.yggdrasil')).toBeUndefined();
  });

  it('two distinct attributable changes accumulate both aspects (no premature undefined)', () => {
    const graph = miniGraph(['llmA', 'llmB'], aspects);
    const r = result({
      changedUpstream: upstream(
        '.yggdrasil/aspects/llmA/content.md',
        '.yggdrasil/aspects/llmB/yg-aspect.yaml',
      ),
    });
    expect(selectDriftedAspects(graph, NODE, r, STORED_VERDICTS, '.yggdrasil')).toEqual(
      new Set(['llmA', 'llmB']),
    );
  });

  it('an attributable change for a node MISSING from the graph ⇒ undefined (defensive)', () => {
    const graph = miniGraph(['llmA', 'llmB'], aspects);
    const r = result({ changedUpstream: upstream('.yggdrasil/aspects/llmA/content.md') });
    // nodePath not in graph.nodes — function cannot resolve effective aspects.
    expect(selectDriftedAspects(graph, 'ghost/node', r, STORED_VERDICTS, '.yggdrasil')).toBeUndefined();
  });
});

// ════════════════════════════════════════════════════════════════════════
// 3. INTEGRATION — real approveNode aspect-only cascade selects ONE aspect
// ════════════════════════════════════════════════════════════════════════
//
// This drives the REAL drift engine (classifyDrift not strictly needed; we feed
// approveNode's own changedUpstream into selectDriftedAspects) to prove the
// carry-forward invariant end-to-end: editing ONE aspect's content.md cascades,
// and the re-review subset is EXACTLY that aspect — the others keep their prior
// verdict (no LLM call). If this broke, an aspect-only cascade would re-run too
// many aspects (cost) or too few (lost verdict).

async function makeCascadeProject(label: string): Promise<{ root: string; ygg: string }> {
  const root = mkdtempSync(path.join(tmpdir(), `yg-b3-int-${label}-`));
  const ygg = path.join(root, '.yggdrasil');
  await mkdir(path.join(ygg, '.drift-state'), { recursive: true });
  await mkdir(path.join(ygg, 'schemas'), { recursive: true });
  await writeFile(path.join(ygg, 'schemas', 'yg-node.yaml'), 'type: node\n');
  await writeFile(path.join(ygg, 'schemas', 'yg-aspect.yaml'), 'type: aspect\n');
  await writeFile(path.join(ygg, 'schemas', 'yg-flow.yaml'), 'type: flow\n');
  await writeFile(path.join(ygg, 'yg-config.yaml'), 'version: "5.0.0"\n');

  // Two LLM aspects, both own-attached on a single mapped node.
  for (const id of ['alpha-rule', 'beta-rule']) {
    const d = path.join(ygg, 'aspects', id);
    await mkdir(d, { recursive: true });
    await writeFile(path.join(d, 'yg-aspect.yaml'), `name: ${id}\ndescription: ${id}\nreviewer:\n  type: llm\nstatus: enforced\n`);
    await writeFile(path.join(d, 'content.md'), `Rule for ${id}.\n`);
  }

  // Parent node so the child loads under the expected 'svc/one' path.
  await mkdir(path.join(ygg, 'model', 'svc'), { recursive: true });
  await writeFile(
    path.join(ygg, 'model', 'svc', 'yg-node.yaml'),
    'name: svc\ntype: module\ndescription: svc\n',
  );
  const nodeDir = path.join(ygg, 'model', 'svc', 'one');
  await mkdir(nodeDir, { recursive: true });
  await writeFile(
    path.join(nodeDir, 'yg-node.yaml'),
    'name: one\ntype: service\ndescription: one\naspects:\n  - alpha-rule\n  - beta-rule\nmapping:\n  - src/one.ts\n',
  );
  // log_required defaults true for unknown type 'service' in architecture (none defined) — but
  // approveNode here is invoked directly and we seed a clean baseline first, so the
  // cascade re-approve has no source change → no log gate trip.
  const srcDir = path.join(root, 'src');
  await mkdir(srcDir, { recursive: true });
  await writeFile(path.join(srcDir, 'one.ts'), 'export const one = 1;\n');
  return { root, ygg };
}

describe('aspect-only cascade selects only the changed aspect (real approveNode)', () => {
  const created: string[] = [];
  afterEach(() => {
    while (created.length) {
      try { rmSync(created.pop()!, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it('editing alpha-rule content cascades; selectDriftedAspects re-runs ONLY alpha-rule', async () => {
    const { root, ygg } = await makeCascadeProject('one-aspect');
    created.push(root);

    // Seed a consistent baseline (both aspects approved) for the mapped node.
    let graph = await loadGraph(root);
    await recordBaselineForAllMappedNodes(graph);

    // Edit ONLY alpha-rule's content → upstream cascade for the node.
    await writeFile(path.join(ygg, 'aspects', 'alpha-rule', 'content.md'), 'Rule for alpha-rule. UPDATED.\n');

    graph = await loadGraph(root);
    // Sanity: classifyDrift sees an upstream-drift for the node.
    const issues = await classifyDrift(graph);
    const drift = issues.find(i => i.code === 'upstream-drift' && i.nodePath === 'svc/one');
    expect(drift).toBeDefined();

    // Real approveNode produces the typed changedUpstream the selector consumes.
    const approve = await approveNode(graph, 'svc/one');
    expect(approve.action).toBe('approved'); // binary model: any change ⇒ approved
    expect(approve.changedSource).toBeUndefined(); // aspect-only, no source change
    expect((approve.changedUpstream ?? []).length).toBeGreaterThan(0);

    const stored = await readNodeDriftState(graph.rootPath, 'svc/one');
    const subset = selectDriftedAspects(graph, 'svc/one', approve, stored, yggPrefixOf(graph));

    // The carry-forward invariant: ONLY alpha-rule is re-verified; beta-rule keeps
    // its prior approved verdict (not in the subset, not undefined).
    expect(subset).toEqual(new Set(['alpha-rule']));
  });

  it('a SOURCE change makes selectDriftedAspects return undefined (node-global re-run)', async () => {
    // Spec (drift-and-cascade): "A SOURCE change is node-global — every effective
    // non-draft aspect re-runs", vs an aspect-only cascade which re-runs just the
    // changed aspect. selectDriftedAspects is the unit deciding that: a non-empty
    // changedSource means full re-run (undefined = no per-aspect subset). Drive
    // the selector directly with that contract input (approveNode's branch for
    // LLM aspects without a configured reviewer is exercised by the repo's
    // reviewer-backed approve tests, not here).
    const { root } = await makeCascadeProject('src-edit');
    created.push(root);
    const graph = await loadGraph(root);
    await recordBaselineForAllMappedNodes(graph);
    const stored = await readNodeDriftState(graph.rootPath, 'svc/one');
    const approve: ApproveResult = {
      action: 'approved',
      currentHash: 'h',
      changedSource: ['src/one.ts'],
      changedUpstream: [],
    };
    expect(selectDriftedAspects(graph, 'svc/one', approve, stored, yggPrefixOf(graph))).toBeUndefined();
  });
});

// ════════════════════════════════════════════════════════════════════════
// 4. E2E — spawned binary + in-process mock reviewer
// ════════════════════════════════════════════════════════════════════════
//
// Hermetic: the mock speaks the Ollama wire protocol on an ephemeral loopback
// port. Paired with ASYNC spawn so the parent event loop stays alive to serve
// the child's HTTP calls (spawnSync would deadlock — documented in
// e2e/support/mock-reviewer.ts).

interface ChatReq { prompt: string }
type Reply = { satisfied: boolean; reason?: string } | { httpStatus: number } | { rawContent: string };

interface Mock {
  endpoint: string;
  chat: ChatReq[];
  close(): Promise<void>;
}

async function startMock(respond: (r: ChatReq, i: number) => Reply): Promise<Mock> {
  const chat: ChatReq[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = '';
    req.on('data', c => (raw += c));
    req.on('end', () => {
      let body: Record<string, unknown> = {};
      try { body = JSON.parse(raw); } catch { /* keep {} */ }
      const json = (s: number, o: unknown): void => {
        res.writeHead(s, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(o));
      };
      if (req.url === '/api/tags') return json(200, { models: [{ name: 'mock' }] });
      if (req.url === '/api/show') return json(200, { model_info: { 'general.context_length': 32768 } });
      if (req.url === '/api/chat') {
        const messages = body.messages as Array<{ content?: string }> | undefined;
        const cr: ChatReq = { prompt: messages?.[0]?.content ?? '' };
        const idx = chat.length;
        chat.push(cr);
        const reply = respond(cr, idx);
        if ('httpStatus' in reply) return json(reply.httpStatus, { error: 'mock-error' });
        const content = 'rawContent' in reply
          ? reply.rawContent
          : JSON.stringify({ satisfied: reply.satisfied, reason: reply.reason ?? '' });
        return json(200, { message: { content } });
      }
      json(404, { error: 'not found' });
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return {
    endpoint: `http://127.0.0.1:${port}`,
    chat,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  };
}

interface RunResult { status: number | null; all: string }
function runAsync(args: string[], cwd: string): Promise<RunResult> {
  return new Promise(resolve => {
    const child = spawn('node', [BIN_PATH, ...args], { cwd });
    let out = '';
    let err = '';
    child.stdout.on('data', d => (out += String(d)));
    child.stderr.on('data', d => (err += String(d)));
    child.on('close', code => resolve({ status: code, all: out + err }));
  });
}

function e2eFixture(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-b3-e2e-${label}-`));
  cpSync(E2E_FIXTURE, dir, { recursive: true });
  return dir;
}
function pointReviewer(dir: string, endpoint: string): void {
  const p = path.join(dir, '.yggdrasil', 'yg-config.yaml');
  writeFileSync(p, readFileSync(p, 'utf-8').replace(/endpoint:\s*["']?[^"'\n]+["']?/, `endpoint: "${endpoint}"`), 'utf-8');
}
const baselinePath = (dir: string, node: string): string =>
  path.join(dir, '.yggdrasil', '.drift-state', ...node.split('/')) + '.json';
const ALWAYS_OK = (): Reply => ({ satisfied: true, reason: 'ok' });

describe.skipIf(!distExists)('E2E — approve modes, batch partial-failure, exit codes', () => {
  // ── Target guards (no LLM call reached) ──────────────────────
  it('no target ⇒ exit 1', async () => {
    const dir = e2eFixture('no-target');
    try {
      const r = await runAsync(['approve'], dir);
      expect(r.status).toBe(1);
      expect(r.all).toContain('No target specified');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('multiple targets ⇒ exit 1', async () => {
    const dir = e2eFixture('multi-target');
    try {
      const r = await runAsync(['approve', '--node', 'services/orders', '--aspect', 'has-doc-comment'], dir);
      expect(r.status).toBe(1);
      expect(r.all).toContain('Multiple targets specified');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('unknown --node ⇒ exit 1', async () => {
    const dir = e2eFixture('unknown-node');
    try {
      const r = await runAsync(['approve', '--node', 'services/ghost'], dir);
      expect(r.status).toBe(1);
      expect(r.all).toContain("Node 'services/ghost' does not exist");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('unknown --aspect ⇒ exit 1', async () => {
    const dir = e2eFixture('unknown-aspect');
    try {
      const r = await runAsync(['approve', '--aspect', 'no-such-aspect'], dir);
      expect(r.status).toBe(1);
      expect(r.all).toContain("Aspect 'no-such-aspect' does not exist");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('unknown --flow ⇒ exit 1', async () => {
    const dir = e2eFixture('unknown-flow');
    try {
      const r = await runAsync(['approve', '--flow', 'no-such-flow'], dir);
      expect(r.status).toBe(1);
      expect(r.all).toContain("Flow 'no-such-flow' does not exist");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('--aspect on a draft-default aspect is a no-op exit 0 (Scenario A) and never calls the reviewer', async () => {
    const dir = e2eFixture('aspect-draft');
    const mock = await startMock(ALWAYS_OK);
    try {
      pointReviewer(dir, mock.endpoint);
      const r = await runAsync(['approve', '--aspect', 'wip-rule'], dir);
      expect(r.status).toBe(0);
      expect(r.all).toContain('draft');
      expect(mock.chat.length).toBe(0);
    } finally { await mock.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  // ── Multi --node batch happy path ────────────────────────────
  it('--node A --node B approves both independently (exit 0), one reviewer call per node', async () => {
    const dir = e2eFixture('multi-node-ok');
    const mock = await startMock(ALWAYS_OK);
    try {
      pointReviewer(dir, mock.endpoint);
      const r = await runAsync(['approve', '--node', 'services/orders', '--node', 'services/payments'], dir);
      expect(r.status).toBe(0);
      expect(r.all).toContain('services/orders');
      expect(r.all).toContain('services/payments');
      expect(r.all).toContain('2 approved, 0 failed');
      // One enforced LLM aspect (has-doc-comment) per node ⇒ 2 calls. The draft
      // wip-rule on orders is skipped (no extra call).
      expect(mock.chat.length).toBe(2);
      expect(existsSync(baselinePath(dir, 'services/orders'))).toBe(true);
      expect(existsSync(baselinePath(dir, 'services/payments'))).toBe(true);
    } finally { await mock.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  // ── THE headline invariant: batch partial failure ────────────
  it('--node batch with ONE node refused ⇒ exit 1, BOTH reported, surviving node approved, drift stays RED', async () => {
    const dir = e2eFixture('multi-node-partial');
    // Refuse only the orders node (its prompt references orders.ts); approve payments.
    const mock = await startMock((cr) =>
      cr.prompt.includes('orders.ts') ? { satisfied: false, reason: 'orders has no comment' } : { satisfied: true, reason: 'ok' });
    try {
      pointReviewer(dir, mock.endpoint);
      const r = await runAsync(['approve', '--node', 'services/orders', '--node', 'services/payments'], dir);

      // INDEPENDENCE: one node's failure did not abort the other.
      expect(r.status).toBe(1);
      expect(r.all).toContain('services/orders');
      expect(r.all).toContain('services/payments');
      expect(r.all).toContain('Approved: services/payments'); // sibling survived
      expect(r.all).toContain('orders has no comment'); // refusal reason surfaced
      expect(r.all).toContain('1 approved, 1 failed'); // per-node tally

      // LOST-DRIFT GUARD: yg check must stay RED for the refused node — the
      // refused verdict is recorded, so the gate does not go green over
      // unverified/violating code.
      const check = await runAsync(['check'], dir);
      expect(check.status).toBe(1);
      expect(check.all).toContain('services/orders');
      expect(check.all).toContain('has-doc-comment');
    } finally { await mock.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  // ── --aspect cascade re-runs ONLY the changed aspect ─────────
  it('--aspect cascade re-approves every drifted node and re-runs ONLY the changed aspect', async () => {
    const dir = e2eFixture('aspect-cascade');
    const mock = await startMock(ALWAYS_OK);
    try {
      pointReviewer(dir, mock.endpoint);
      // Clean baseline for both service nodes.
      const seed = await runAsync(['approve', '--node', 'services/orders', '--node', 'services/payments'], dir);
      expect(seed.status).toBe(0);
      const afterSeed = mock.chat.length;
      expect(afterSeed).toBe(2);

      // Change the has-doc-comment aspect content → cascade to both service nodes.
      const aspPath = path.join(dir, '.yggdrasil', 'aspects', 'has-doc-comment', 'content.md');
      writeFileSync(aspPath, readFileSync(aspPath, 'utf-8') + '\nAn additional clause.\n', 'utf-8');

      const r = await runAsync(['approve', '--aspect', 'has-doc-comment'], dir);
      expect(r.status).toBe(0);
      expect(r.all).toContain("cascaded from aspect 'has-doc-comment'");
      expect(r.all).toContain('2 approved, 0 failed');

      // Carry-forward invariant: exactly one re-review per node (the changed
      // aspect only). Deterministic aspects re-run locally (no LLM call).
      const cascadeCalls = mock.chat.length - afterSeed;
      expect(cascadeCalls).toBe(2);
      for (const c of mock.chat.slice(afterSeed)) {
        expect(c.prompt).toContain('has-doc-comment');
      }
    } finally { await mock.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it('--aspect cascade with one node refusing the changed aspect ⇒ exit 1, sibling approved', async () => {
    const dir = e2eFixture('aspect-cascade-partial');
    try {
      const seedMock = await startMock(ALWAYS_OK);
      try {
        pointReviewer(dir, seedMock.endpoint);
        const seed = await runAsync(['approve', '--node', 'services/orders', '--node', 'services/payments'], dir);
        expect(seed.status).toBe(0);
      } finally { await seedMock.close(); }

      // Re-run mock that refuses only orders on the cascade re-review.
      const mock = await startMock((cr) =>
        cr.prompt.includes('orders.ts') ? { satisfied: false, reason: 'orders fails the new clause' } : { satisfied: true, reason: 'ok' });
      try {
        pointReviewer(dir, mock.endpoint);
        const aspPath = path.join(dir, '.yggdrasil', 'aspects', 'has-doc-comment', 'content.md');
        writeFileSync(aspPath, readFileSync(aspPath, 'utf-8') + '\nA stricter clause.\n', 'utf-8');

        const r = await runAsync(['approve', '--aspect', 'has-doc-comment'], dir);
        expect(r.status).toBe(1);
        expect(r.all).toContain('1 approved, 1 failed');
        expect(r.all).toContain('Approved: services/payments');
        expect(r.all).toContain('orders fails the new clause');
      } finally { await mock.close(); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('--aspect with no cascade drift is a no-op exit 0', async () => {
    const dir = e2eFixture('aspect-no-cascade');
    const mock = await startMock(ALWAYS_OK);
    try {
      pointReviewer(dir, mock.endpoint);
      await runAsync(['approve', '--node', 'services/orders', '--node', 'services/payments'], dir);
      const before = mock.chat.length;
      const r = await runAsync(['approve', '--aspect', 'has-doc-comment'], dir);
      expect(r.status).toBe(0);
      expect(r.all).toContain('No cascade drift found');
      expect(mock.chat.length).toBe(before); // nothing re-reviewed
    } finally { await mock.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  // ── --flow cascade ───────────────────────────────────────────
  it('--flow cascade re-approves flow participants; a deterministic-aspect change costs ZERO LLM calls', async () => {
    const dir = e2eFixture('flow-cascade');
    const mock = await startMock(ALWAYS_OK);
    try {
      pointReviewer(dir, mock.endpoint);
      await runAsync(['approve', '--node', 'services/orders', '--node', 'services/payments'], dir);
      const before = mock.chat.length;

      // Change the flow-attached DETERMINISTIC aspect (no-todo-comments) → cascade
      // to both flow participants. Re-review runs the deterministic check locally.
      const checkPath = path.join(dir, '.yggdrasil', 'aspects', 'no-todo-comments', 'check.mjs');
      writeFileSync(checkPath, readFileSync(checkPath, 'utf-8') + '\n// cascade touch\n', 'utf-8');

      const r = await runAsync(['approve', '--flow', 'order-processing'], dir);
      expect(r.status).toBe(0);
      expect(r.all).toContain("cascaded from flow 'order-processing'");
      expect(r.all).toContain('2 approved, 0 failed');
      // Cost invariant: a deterministic-only cascade makes NO reviewer call.
      expect(mock.chat.length).toBe(before);
    } finally { await mock.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it('--flow with no cascade drift is a no-op exit 0', async () => {
    const dir = e2eFixture('flow-no-cascade');
    const mock = await startMock(ALWAYS_OK);
    try {
      pointReviewer(dir, mock.endpoint);
      await runAsync(['approve', '--node', 'services/orders', '--node', 'services/payments'], dir);
      const r = await runAsync(['approve', '--flow', 'order-processing'], dir);
      expect(r.status).toBe(0);
      expect(r.all).toContain('No cascade drift found');
    } finally { await mock.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});
