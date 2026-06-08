// Bounty 3 — baseline-integrity / verdict-tamper detection.
//
// TARGET: core/check.ts classifyNodeDrift, the "unattributable hash divergence"
// branch (the baseline-integrity error) plus io/drift-state-store.ts read gate.
//
// INVARIANT under test: once the canonical drift hash recompute (files + typed
// identity + STORED verdicts) disagrees with the recorded `hash`, exactly one of
// the following must happen, and the gate must NEVER go silently green:
//   - a file change explains it          -> source-drift   (NOT baseline-integrity)
//   - an identity change explains it     -> upstream-drift (NOT baseline-integrity)
//   - nothing explains it (verdict tamper, hand-edited hash, stale scheme)
//                                         -> baseline-integrity (BLOCKS)
// and restoring the honest baseline clears it.
//
// The existing roundtrip test (approve-verdict-hash-roundtrip.test.ts) drives
// ONE refused->approved flip through runCheck. These tests cover the gaps it
// misses: a tampered `hash` field with no verdict change, an errorSource-only
// flip, the "file/identity cause wins over baseline-integrity" branches, the
// restore round-trip, the suggestedNext routing, and a spawned-binary E2E.
//
// Hermetic: a mocked LlmProvider (no network) for the unit graphs; an in-process
// Ollama-protocol mock for the E2E spawn. Fresh mkdtemp trees, cleaned in finally.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile, rm, utimes } from 'node:fs/promises';
import {
  existsSync,
  mkdtempSync,
  rmSync,
  cpSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { loadGraph } from '../../../src/core/graph-loader.js';
import { approveNode } from '../../../src/core/approve.js';
import { runApproveWithReviewer } from '../../../src/core/approve-reviewer.js';
import { runCheck } from '../../../src/core/check.js';
import { readNodeDriftState, writeNodeDriftState } from '../../../src/io/drift-state-store.js';
import type { LlmProvider } from '../../../src/llm/types.js';
import type { DriftNodeState } from '../../../src/model/drift.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '..', '..', '..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'e2e-lifecycle');

// ── Mock the LLM provider for the unit-level graphs ──────────────────────────

vi.mock('../../../src/llm/index.js', () => ({
  createLlmProvider: vi.fn(),
}));
import { createLlmProvider } from '../../../src/llm/index.js';
const mockCreateLlmProvider = vi.mocked(createLlmProvider);

const V5_REVIEWER_CONFIG =
  'reviewer:\n  tiers:\n    standard:\n      provider: ollama\n      consensus: 1\n      config:\n        model: llama3\n';

const NODE_PATH = 'svc/my-service';

function approvingProvider(): LlmProvider {
  return {
    verifyAspect: async () => ({ satisfied: true, reason: 'ok', errorSource: 'codeViolation' as const }),
    isAvailable: async () => true,
  };
}

/**
 * Build a minimal single-node graph on disk with ONE enforced LLM aspect plus
 * ONE enforced deterministic aspect, an honest log, and a source file. A single
 * mapped node keeps `baseline-integrity` the ONLY error in runCheck (no sibling
 * `unapproved` noise), so suggestedNext routing is deterministic.
 */
async function createTmpProject(name: string): Promise<string> {
  const tmpDir = path.join(__dirname, `../../fixtures/tmp-bi-${name}`);
  const yggRoot = path.join(tmpDir, '.yggdrasil');
  const nodeDir = path.join(yggRoot, 'model', NODE_PATH);
  const parentDir = path.join(yggRoot, 'model', 'svc');

  await rm(tmpDir, { recursive: true, force: true });
  await mkdir(nodeDir, { recursive: true });
  await mkdir(path.join(yggRoot, '.drift-state'), { recursive: true });
  await mkdir(path.join(yggRoot, 'schemas'), { recursive: true });
  await writeFile(path.join(yggRoot, 'schemas', 'yg-node.yaml'), 'type: node\n');
  await writeFile(path.join(yggRoot, 'schemas', 'yg-aspect.yaml'), 'type: aspect\n');
  await writeFile(path.join(yggRoot, 'schemas', 'yg-flow.yaml'), 'type: flow\n');
  await writeFile(path.join(yggRoot, 'yg-config.yaml'), V5_REVIEWER_CONFIG);
  await writeFile(path.join(parentDir, 'yg-node.yaml'), 'name: svc\ntype: service\ndescription: parent\n');
  await writeFile(
    path.join(nodeDir, 'yg-node.yaml'),
    'name: MyService\ntype: service\ndescription: test\naspects:\n  - det\n  - llm\nmapping:\n  - src/svc/index.ts\n',
  );
  await writeFile(path.join(nodeDir, 'log.md'), '## [2026-05-11T10:00:00.000Z]\nInitial setup.\n');

  const detDir = path.join(yggRoot, 'aspects', 'det');
  await mkdir(detDir, { recursive: true });
  await writeFile(path.join(detDir, 'yg-aspect.yaml'), 'name: Det\ndescription: structural shape\nreviewer:\n  type: deterministic\n');
  await writeFile(path.join(detDir, 'check.mjs'), 'export function check(_ctx) { return []; }\n');

  const llmDir = path.join(yggRoot, 'aspects', 'llm');
  await mkdir(llmDir, { recursive: true });
  await writeFile(path.join(llmDir, 'yg-aspect.yaml'), 'name: Llm\ndescription: must be deterministic\nreviewer:\n  type: llm\n');
  await writeFile(path.join(llmDir, 'content.md'), 'Code must be deterministic.\n');

  const srcAbs = path.join(tmpDir, 'src/svc/index.ts');
  await mkdir(path.dirname(srcAbs), { recursive: true });
  await writeFile(srcAbs, 'export const x = 1;\n');

  return tmpDir;
}

/** Honest approve of NODE_PATH; returns the committed (honest) baseline. */
async function honestApprove(tmpDir: string): Promise<DriftNodeState> {
  const graph = await loadGraph(tmpDir);
  const coreResult = await approveNode(graph, NODE_PATH);
  const storedEntry = await readNodeDriftState(graph.rootPath, NODE_PATH);
  const result = await runApproveWithReviewer({
    graph,
    nodePath: NODE_PATH,
    result: coreResult,
    rootPath: graph.rootPath,
    secretsByProvider: new Map(),
    storedEntry,
  });
  if (result.action === 'refused') {
    throw new Error(`approve refused unexpectedly: ${JSON.stringify(result.refuseReasonData)}`);
  }
  const written = await readNodeDriftState(graph.rootPath, NODE_PATH);
  expect(written).toBeDefined();
  return written!;
}

async function checkIssues(tmpDir: string) {
  const graph = await loadGraph(tmpDir);
  return runCheck(graph, null);
}

beforeEach(() => {
  vi.resetAllMocks();
  mockCreateLlmProvider.mockReturnValue(approvingProvider());
});

describe('baseline-integrity — unattributable divergence blocks (unit, runCheck gate)', () => {
  it('an honest baseline produces NO baseline-integrity error (control)', async () => {
    const tmpDir = await createTmpProject('control');
    try {
      await honestApprove(tmpDir);
      const result = await checkIssues(tmpDir);
      expect(result.issues.filter(i => i.code === 'baseline-integrity')).toHaveLength(0);
      // The whole single-node tree is clean after an honest approve.
      expect(result.issues.filter(i => i.severity === 'error')).toHaveLength(0);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('a hand-edited `hash` field (NO verdict/file/identity change) blocks as baseline-integrity', async () => {
    // Gap vs existing tests: those flip a VERDICT. Here only the recorded hash is
    // corrupted — the recompute over the (honest) files+identity+verdicts no
    // longer matches the stored garbage hash, and nothing else explains it.
    const tmpDir = await createTmpProject('hash-edit');
    try {
      const honest = await honestApprove(tmpDir);
      const graph = await loadGraph(tmpDir);
      const tampered: DriftNodeState = { ...honest, hash: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef' };
      await writeNodeDriftState(graph.rootPath, NODE_PATH, tampered);

      const result = await checkIssues(tmpDir);
      const integrity = result.issues.filter(i => i.code === 'baseline-integrity');
      expect(integrity).toHaveLength(1);
      expect(integrity[0].severity).toBe('error');
      expect(integrity[0].nodePath).toBe(NODE_PATH);
      // The honest verdicts are unchanged, so NO per-aspect violation is emitted —
      // the ONLY signal is the integrity error (the divergence is unattributable).
      expect(result.issues.some(i => i.code === 'aspect-violation-enforced')).toBe(false);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('flipping ONLY errorSource on a stored verdict (verdict stays the same) still blocks', async () => {
    // serializeVerdicts folds errorSource into the canonical hash. A baseline
    // whose verdict text is unchanged but whose errorSource was hand-edited (e.g.
    // codeViolation -> provider, to relabel a real violation as an infra blip)
    // must still diverge with no file/identity cause -> baseline-integrity.
    const tmpDir = await createTmpProject('errsrc');
    try {
      const honest = await honestApprove(tmpDir);
      const graph = await loadGraph(tmpDir);
      const tampered: DriftNodeState = {
        ...honest,
        aspectVerdicts: {
          ...honest.aspectVerdicts,
          // det is approved with no errorSource; stamp a provider errorSource.
          det: { verdict: 'approved', errorSource: 'provider' },
        },
      };
      await writeNodeDriftState(graph.rootPath, NODE_PATH, tampered);

      const result = await checkIssues(tmpDir);
      const integrity = result.issues.filter(i => i.code === 'baseline-integrity');
      expect(integrity).toHaveLength(1);
      expect(integrity[0].nodePath).toBe(NODE_PATH);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('the baseline-integrity message names the node and offers re-approve OR git restore', async () => {
    const tmpDir = await createTmpProject('msg');
    try {
      const honest = await honestApprove(tmpDir);
      const graph = await loadGraph(tmpDir);
      await writeNodeDriftState(graph.rootPath, NODE_PATH, { ...honest, hash: 'f'.repeat(64) });

      const result = await checkIssues(tmpDir);
      const integrity = result.issues.find(i => i.code === 'baseline-integrity')!;
      expect(integrity).toBeDefined();
      expect(integrity.messageData.what).toContain(`'${NODE_PATH}'`);
      // Both recovery paths are offered, with the node path interpolated (no template leak).
      expect(integrity.messageData.next).toContain(`yg approve --node ${NODE_PATH}`);
      expect(integrity.messageData.next).toContain(`.yggdrasil/.drift-state/${NODE_PATH}.json`);
      expect(integrity.messageData.next).not.toContain('${nodePath}');
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('suggestedNext for a pure baseline-integrity error routes through the structural branch', async () => {
    // baseline-integrity is a STRUCTURAL_CODE; with no drift/cascade/log errors
    // ahead of it, computeSuggestedNext must surface the structural hint naming it.
    const tmpDir = await createTmpProject('suggest');
    try {
      const honest = await honestApprove(tmpDir);
      const graph = await loadGraph(tmpDir);
      await writeNodeDriftState(graph.rootPath, NODE_PATH, { ...honest, hash: '0'.repeat(64) });

      const result = await checkIssues(tmpDir);
      expect(result.suggestedNext).toBeTruthy();
      expect(result.suggestedNext).toContain('baseline-integrity');
      expect(result.suggestedNext).toContain(NODE_PATH);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('baseline-integrity — a file/identity cause is reported INSTEAD (unit)', () => {
  it('a source edit ON TOP of a verdict tamper surfaces source-drift, NOT baseline-integrity', async () => {
    // Spec invariant: a divergence WITH a file cause is reported as that. The
    // verdict tamper alone would be unattributable, but a real source change is a
    // concrete cause, so source-drift wins and baseline-integrity must NOT fire.
    const tmpDir = await createTmpProject('file-cause');
    try {
      const honest = await honestApprove(tmpDir);
      const graph = await loadGraph(tmpDir);

      // Tamper a verdict refused->...; AND change the source file.
      const tampered: DriftNodeState = {
        ...honest,
        aspectVerdicts: { ...honest.aspectVerdicts, llm: { verdict: 'refused', errorSource: 'codeViolation' } },
      };
      await writeNodeDriftState(graph.rootPath, NODE_PATH, tampered);

      const srcAbs = path.join(tmpDir, 'src/svc/index.ts');
      await writeFile(srcAbs, 'export const x = 999;\n');
      const future = new Date(Date.now() + 120_000);
      await utimes(srcAbs, future, future);

      const result = await checkIssues(tmpDir);
      expect(result.issues.some(i => i.code === 'source-drift' && i.nodePath === NODE_PATH)).toBe(true);
      expect(result.issues.filter(i => i.code === 'baseline-integrity')).toHaveLength(0);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('an upstream identity change (aspect meta) surfaces upstream-drift, NOT baseline-integrity', async () => {
    // Editing the aspect's description changes its folded `meta` identity. The
    // hash diverges, but diffIdentity attributes it -> upstream-drift, never
    // baseline-integrity.
    const tmpDir = await createTmpProject('identity-cause');
    try {
      await honestApprove(tmpDir);
      // Change the LLM aspect definition (description) -> aspectIdentity.meta changes.
      await writeFile(
        path.join(tmpDir, '.yggdrasil/aspects/llm/yg-aspect.yaml'),
        'name: Llm\ndescription: must be deterministic and pure now\nreviewer:\n  type: llm\n',
      );

      const result = await checkIssues(tmpDir);
      expect(result.issues.some(i => i.code === 'upstream-drift' && i.nodePath === NODE_PATH)).toBe(true);
      expect(result.issues.filter(i => i.code === 'baseline-integrity')).toHaveLength(0);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('restoring the honest baseline after a tamper clears the baseline-integrity error', async () => {
    // "restoring drift-state from git clears it" — model the restore by writing
    // back the byte-identical honest baseline captured before the tamper.
    const tmpDir = await createTmpProject('restore');
    try {
      const honest = await honestApprove(tmpDir);
      const graph = await loadGraph(tmpDir);

      // Tamper -> integrity error appears.
      await writeNodeDriftState(graph.rootPath, NODE_PATH, { ...honest, hash: 'a'.repeat(64) });
      const tamperedResult = await checkIssues(tmpDir);
      expect(tamperedResult.issues.filter(i => i.code === 'baseline-integrity')).toHaveLength(1);

      // Restore the honest baseline -> integrity error gone, tree clean again.
      await writeNodeDriftState(graph.rootPath, NODE_PATH, honest);
      const restoredResult = await checkIssues(tmpDir);
      expect(restoredResult.issues.filter(i => i.code === 'baseline-integrity')).toHaveLength(0);
      expect(restoredResult.issues.filter(i => i.severity === 'error')).toHaveLength(0);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});

// ── E2E: spawned binary against a committed, hand-tampered baseline ──────────
//
// The format-gate E2E (cli-drift-state-format.test.ts) only covers
// corrupt/outdated SHAPES. A verdict-tamper baseline is structurally VALID — it
// passes the read gate, so the integrity check (not the shape gate) must catch
// it. That path has no spawned-binary coverage; this adds it.

const distExists = existsSync(BIN_PATH);

interface MockHandle { port: number; close: () => Promise<void>; }

function startOllamaMock(): Promise<MockHandle> {
  return new Promise((resolve) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        let body: Record<string, unknown> = {};
        try { body = JSON.parse(raw) as Record<string, unknown>; } catch { /* empty */ }
        const json = (status: number, obj: unknown): void => {
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(obj));
        };
        if (req.url === '/api/tags') return json(200, { models: [{ name: body.model ?? 'mock' }] });
        if (req.url === '/api/show') return json(200, { model_info: { 'general.context_length': 32768 } });
        if (req.url === '/api/chat') return json(200, { message: { content: JSON.stringify({ satisfied: true, reason: 'ok' }) } });
        return json(404, { error: 'not found' });
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ port, close: () => new Promise<void>((r) => server.close(() => r())) });
    });
  });
}

function runAsync(args: string[], cwd: string): Promise<{ status: number | null; all: string }> {
  return new Promise((resolve) => {
    const child = spawn('node', [BIN_PATH, ...args], { cwd });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += String(d); });
    child.stderr.on('data', (d) => { err += String(d); });
    child.on('close', (code) => resolve({ status: code, all: out + err }));
  });
}

function pointReviewer(dir: string, port: number): void {
  const cfg = path.join(dir, '.yggdrasil', 'yg-config.yaml');
  writeFileSync(
    cfg,
    readFileSync(cfg, 'utf-8').replace(/endpoint:\s*["']?[^"'\n]+["']?/, `endpoint: "http://127.0.0.1:${port}"`),
    'utf-8',
  );
}

const ORDERS_BASELINE = (dir: string) =>
  path.join(dir, '.yggdrasil', '.drift-state', 'services', 'orders.json');

describe.skipIf(!distExists)('baseline-integrity — E2E spawned binary (committed tamper)', () => {
  it('a committed verdict flip (approved->refused, hash untouched) makes `yg check` exit 1 with baseline-integrity', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'yg-bi-e2e-tamper-'));
    cpSync(FIXTURE, dir, { recursive: true });
    const mock = await startOllamaMock();
    try {
      pointReviewer(dir, mock.port);

      // Honest approve writes a real baseline (all verdicts approved).
      const ap = await runAsync(['approve', '--node', 'services/orders'], dir);
      expect(ap.status).toBe(0);
      expect(existsSync(ORDERS_BASELINE(dir))).toBe(true);

      // Hand-edit the committed baseline: flip a verdict approved->refused, leave
      // `hash` untouched (exactly what tampering the JSON in git would look like).
      const obj = JSON.parse(readFileSync(ORDERS_BASELINE(dir), 'utf-8'));
      obj.aspectVerdicts['has-doc-comment'] = { verdict: 'refused', reason: 'tampered', errorSource: 'codeViolation' };
      writeFileSync(ORDERS_BASELINE(dir), JSON.stringify(obj, null, 2) + '\n', 'utf-8');

      const check = await runAsync(['check'], dir);
      expect(check.status).toBe(1);
      expect(check.all).toContain('baseline-integrity');
      expect(check.all).toContain('services/orders');
      // The git-restore recovery hint for THIS node is rendered.
      expect(check.all).toContain('git checkout HEAD -- .yggdrasil/.drift-state/services/orders.json');
      // Not framed as a CLI bug — this is a recoverable state error.
      expect(check.all).not.toContain('This is a bug');
      expect(check.all).not.toContain('file an issue');
    } finally {
      await mock.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('restoring the honest baseline (overwrite with the pre-tamper bytes) drops the integrity error', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'yg-bi-e2e-restore-'));
    cpSync(FIXTURE, dir, { recursive: true });
    const mock = await startOllamaMock();
    try {
      pointReviewer(dir, mock.port);

      const ap = await runAsync(['approve', '--node', 'services/orders'], dir);
      expect(ap.status).toBe(0);
      const honestBytes = readFileSync(ORDERS_BASELINE(dir), 'utf-8');

      // Tamper -> baseline-integrity appears.
      const obj = JSON.parse(honestBytes);
      obj.aspectVerdicts['has-doc-comment'] = { verdict: 'refused', reason: 'tampered', errorSource: 'codeViolation' };
      writeFileSync(ORDERS_BASELINE(dir), JSON.stringify(obj, null, 2) + '\n', 'utf-8');
      const tampered = await runAsync(['check'], dir);
      expect(tampered.all).toContain('baseline-integrity');

      // Restore the exact honest bytes -> the integrity error for this node is gone.
      writeFileSync(ORDERS_BASELINE(dir), honestBytes, 'utf-8');
      const restored = await runAsync(['check'], dir);
      expect(restored.all).not.toContain('baseline-integrity');
    } finally {
      await mock.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
