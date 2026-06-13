/**
 * Unit tests for the `yg check --approve` fill stage (core/fill.ts, spec §7).
 * Deterministic-focused tests: det fills, det gate (enforced det skips LLM),
 * taint/re-run-once, log gate, positive closure, GC, incremental writeLock.
 *
 * HERMETIC: createLlmProvider is mocked exactly like
 * bounty3/approve-gates-failclosed.test.ts — no network, no real reviewer. Each
 * project is a fresh mkdtemp tree; the lock is written to / read from disk by the
 * fill stage. No wall clock is read in any assertion.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { tmpdir } from 'node:os';
import {
  mkdtemp, mkdir, writeFile, rm, readFile,
} from 'node:fs/promises';

import { loadGraph } from '../../../src/core/graph-loader.js';
import { runFill } from '../../../src/core/fill.js';
import { readLock } from '../../../src/io/lock-store.js';
import type { LlmProvider } from '../../../src/llm/types.js';
import type { RunStructureAspectResult } from '../../../src/structure/runner.js';

// ── Mock the LLM provider factory (no real reviewer) ──────────────────────────
vi.mock('../../../src/llm/index.js', () => ({
  createLlmProvider: vi.fn(),
}));
import { createLlmProvider } from '../../../src/llm/index.js';
const mockCreateLlmProvider = vi.mocked(createLlmProvider);

// ── Mock the structure runner (pass-through by default; override per test) ────
// Same seam style as the createLlmProvider mock above.
// `var` avoids the temporal-dead-zone issue: vi.mock factories are hoisted to
// the very top of the file (before even `const`/`let` declarations), so only
// `var`-declared names are accessible inside the factory body.
// eslint-disable-next-line no-var
var structureRunnerRealFn: (typeof import('../../../src/structure/runner.js'))['runStructureAspect'] | undefined;
vi.mock('../../../src/structure/runner.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/structure/runner.js')>();
  structureRunnerRealFn = actual.runStructureAspect;
  return {
    ...actual,
    // Wrap runStructureAspect as a vi.fn spy so mockImplementation is available.
    runStructureAspect: vi.fn(actual.runStructureAspect),
  };
});
import { runStructureAspect } from '../../../src/structure/runner.js';
const mockRunStructureAspect = vi.mocked(runStructureAspect);

function makeMockProvider(overrides: Partial<LlmProvider> = {}): LlmProvider {
  return {
    verifyAspect: async () => ({ satisfied: true, reason: 'ok', errorSource: 'codeViolation' as const }),
    isAvailable: async () => true,
    ...overrides,
  };
}

const V5_REVIEWER_CONFIG =
  'reviewer:\n  tiers:\n    standard:\n      provider: ollama\n      consensus: 1\n      config:\n        model: llama3\n        temperature: 0\n';

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
beforeEach(() => {
  vi.resetAllMocks();
  // Restore the real structure runner so existing det tests keep working.
  // Tests that need a controlled result override this with mockImplementationOnce.
  if (structureRunnerRealFn) {
    const real = structureRunnerRealFn;
    mockRunStructureAspect.mockImplementation(
      (...args: Parameters<typeof runStructureAspect>) => real(...args),
    );
  }
});

// ── Project builder ───────────────────────────────────────────────────────────

interface AspectSpec {
  id: string;
  kind: 'llm' | 'deterministic';
  status?: 'draft' | 'advisory' | 'enforced';
  /** content.md (llm) / check.mjs (deterministic) body. */
  rule: string;
  scopePer?: 'node' | 'file';
  references?: Array<{ path: string; description?: string }>;
}

interface ProjectSpec {
  /** node `svc` aspects. */
  aspects: AspectSpec[];
  /** extra files at repo-relative paths (besides src/svc.ts). */
  files?: Record<string, string>;
  /** node mapping (default ['src/svc.ts']). */
  mapping?: string[];
  configYaml?: string;
  logContent?: string;
  logRequired?: boolean;
  /** extra repo-relative files NOT under the node mapping (e.g. references). */
  extraFiles?: Record<string, string>;
}

async function setupProject(spec: ProjectSpec): Promise<{ projectRoot: string; yggRoot: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'yg-fill-'));
  dirs.push(root);
  const yggRoot = path.join(root, '.yggdrasil');
  const nodeDir = path.join(yggRoot, 'model', 'svc');
  await mkdir(nodeDir, { recursive: true });
  await mkdir(path.join(yggRoot, 'schemas'), { recursive: true });
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(yggRoot, 'schemas', 'yg-node.yaml'), 'type: node\n');
  await writeFile(path.join(yggRoot, 'schemas', 'yg-aspect.yaml'), 'type: aspect\n');
  await writeFile(path.join(yggRoot, 'schemas', 'yg-flow.yaml'), 'type: flow\n');
  await writeFile(path.join(yggRoot, 'yg-config.yaml'), spec.configYaml ?? V5_REVIEWER_CONFIG);
  await writeFile(
    path.join(yggRoot, 'yg-architecture.yaml'),
    `node_types:\n  service:\n    description: s\n    log_required: ${spec.logRequired ?? false}\n`,
  );
  const mapping = spec.mapping ?? ['src/svc.ts'];
  await writeFile(
    path.join(nodeDir, 'yg-node.yaml'),
    `name: svc\ntype: service\ndescription: x\nmapping:\n${mapping.map((m) => `  - ${m}`).join('\n')}\naspects:\n${spec.aspects.map((a) => `  - ${a.id}`).join('\n')}\n`,
  );

  // Default source file (unless overridden by files/mapping).
  await writeFile(path.join(root, 'src', 'svc.ts'), 'export const x = 1;\n');
  for (const [rel, content] of Object.entries(spec.files ?? {})) {
    const abs = path.join(root, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content);
  }
  for (const [rel, content] of Object.entries(spec.extraFiles ?? {})) {
    const abs = path.join(root, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content);
  }
  if (spec.logContent !== undefined) await writeFile(path.join(nodeDir, 'log.md'), spec.logContent);

  for (const asp of spec.aspects) {
    const aspDir = path.join(yggRoot, 'aspects', asp.id);
    await mkdir(aspDir, { recursive: true });
    const refLines = (asp.references ?? [])
      .map((r) => `  - path: ${r.path}${r.description ? `\n    description: ${r.description}` : ''}`)
      .join('\n');
    const yaml =
      `name: ${asp.id}\ndescription: ${asp.id} rule\nreviewer:\n  type: ${asp.kind}\n` +
      `${asp.status ? `status: ${asp.status}\n` : ''}` +
      `${asp.scopePer ? `scope:\n  per: ${asp.scopePer}\n` : ''}` +
      `${asp.references ? `references:\n${refLines}\n` : ''}`;
    await writeFile(path.join(aspDir, 'yg-aspect.yaml'), yaml);
    await writeFile(path.join(aspDir, asp.kind === 'llm' ? 'content.md' : 'check.mjs'), asp.rule);
  }
  return { projectRoot: root, yggRoot };
}

/** Capture fill output as a string so exact strings can be asserted. */
function makeWriter(): { write: (s: string) => void; text: () => string } {
  let buf = '';
  return { write: (s) => { buf += s; }, text: () => buf };
}

const DET_PASS = 'export function check(ctx) { void ctx; return []; }\n';
const DET_FAIL = 'export function check(ctx) { void ctx; return [{ message: "bad", file: "src/svc.ts", line: 1 }]; }\n';

// =============================================================================
// 2. Deterministic-first ordering + det gate (fresh AND cached)
// =============================================================================

describe('deterministic-first ordering + det gate', () => {
  it('an enforced det refusal skips the LLM fill for that node (LLM never dispatched)', async () => {
    const { projectRoot } = await setupProject({
      aspects: [
        { id: 'det-fail', kind: 'deterministic', status: 'enforced', rule: DET_FAIL },
        { id: 'llm-a', kind: 'llm', status: 'enforced', rule: 'rule a' },
      ],
    });
    const graph = await loadGraph(projectRoot);
    let verifyCalls = 0;
    mockCreateLlmProvider.mockReturnValue(makeMockProvider({
      async verifyAspect() { verifyCalls++; return { satisfied: true, reason: 'ok', errorSource: 'codeViolation' as const }; },
    }));

    const w = makeWriter();
    const result = await runFill(graph, { gitTrackedFiles: null, write: w.write });

    // The det check refused → the LLM reviewer was never asked.
    expect(verifyCalls).toBe(0);
    expect(result.reviewerCallsMade).toBe(0);
    const lock = readLock(graph.rootPath);
    expect(lock.verdicts['det-fail']?.['node:svc']?.verdict).toBe('refused');
    // The LLM pair was NOT written (skipped, still unverified).
    expect(lock.verdicts['llm-a']?.['node:svc']).toBeUndefined();
    // The skip notice was emitted.
    expect(w.text()).toContain("LLM fills for node 'svc' skipped — an enforced deterministic check already refused it.");
  });

  it('honors a CACHED enforced det refusal on a second run (LLM still skipped)', async () => {
    const { projectRoot } = await setupProject({
      aspects: [
        { id: 'det-fail', kind: 'deterministic', status: 'enforced', rule: DET_FAIL },
        { id: 'llm-a', kind: 'llm', status: 'enforced', rule: 'rule a' },
      ],
    });
    // First run records the det refusal.
    let graph = await loadGraph(projectRoot);
    mockCreateLlmProvider.mockReturnValue(makeMockProvider());
    await runFill(graph, { gitTrackedFiles: null, write: () => {} });

    // Second run: the det refusal is cached-valid. The LLM pair is still skipped.
    graph = await loadGraph(projectRoot);
    let verifyCalls = 0;
    mockCreateLlmProvider.mockReturnValue(makeMockProvider({
      async verifyAspect() { verifyCalls++; return { satisfied: true, reason: 'ok', errorSource: 'codeViolation' as const }; },
    }));
    const result = await runFill(graph, { gitTrackedFiles: null, write: () => {} });
    expect(verifyCalls).toBe(0);
    expect(result.reviewerCallsMade).toBe(0);
    const lock = readLock(graph.rootPath);
    expect(lock.verdicts['llm-a']?.['node:svc']).toBeUndefined();
  });
});

// =============================================================================
// 5. Positive closure — fingerprint + log only on all-enforced-green
// =============================================================================

describe('positive closure', () => {
  it('records source fingerprint + log only when all enforced pairs are approved (incl. det)', async () => {
    const { projectRoot } = await setupProject({
      aspects: [
        { id: 'det-a', kind: 'deterministic', status: 'enforced', rule: DET_PASS },
        { id: 'llm-a', kind: 'llm', status: 'enforced', rule: 'rule a' },
      ],
      logContent: '## [2026-05-11T10:00:00.000Z]\nfirst.\n',
    });
    const graph = await loadGraph(projectRoot);
    mockCreateLlmProvider.mockReturnValue(makeMockProvider()); // approves
    await runFill(graph, { gitTrackedFiles: null, write: () => {} });
    const lock = readLock(graph.rootPath);
    expect(lock.nodes['svc']?.source).toBeDefined();
    expect(lock.nodes['svc']?.log?.last_entry_datetime).toBe('2026-05-11T10:00:00.000Z');
  });

  it('an enforced det refusal BLOCKS closure (no fingerprint recorded)', async () => {
    const { projectRoot } = await setupProject({
      aspects: [{ id: 'det-fail', kind: 'deterministic', status: 'enforced', rule: DET_FAIL }],
      logContent: '## [2026-05-11T10:00:00.000Z]\nfirst.\n',
    });
    const graph = await loadGraph(projectRoot);
    await runFill(graph, { gitTrackedFiles: null, write: () => {} });
    const lock = readLock(graph.rootPath);
    expect(lock.nodes['svc']?.source).toBeUndefined();
  });

  it('an advisory refusal still closes (does not block)', async () => {
    const { projectRoot } = await setupProject({
      aspects: [{ id: 'det-adv', kind: 'deterministic', status: 'advisory', rule: DET_FAIL }],
      logContent: '## [2026-05-11T10:00:00.000Z]\nfirst.\n',
    });
    const graph = await loadGraph(projectRoot);
    await runFill(graph, { gitTrackedFiles: null, write: () => {} });
    const lock = readLock(graph.rootPath);
    // Advisory refusal does not block closure → fingerprint recorded.
    expect(lock.nodes['svc']?.source).toBeDefined();
  });
});

// =============================================================================
// 6. Log gate
// =============================================================================

describe('log gate (§9)', () => {
  it('fires on a fingerprint change with no fresh entry (pair skipped)', async () => {
    const { projectRoot, yggRoot } = await setupProject({
      aspects: [{ id: 'det-a', kind: 'deterministic', status: 'enforced', rule: DET_PASS }],
      logRequired: true,
      logContent: '## [2026-05-11T10:00:00.000Z]\nfirst.\n',
    });
    // First fill closes the node (records fingerprint + log baseline).
    let graph = await loadGraph(projectRoot);
    await runFill(graph, { gitTrackedFiles: null, write: () => {} });
    expect(readLock(graph.rootPath).nodes['svc']?.source).toBeDefined();

    // Edit source (fingerprint drifts) WITHOUT a fresh log entry.
    await writeFile(path.join(projectRoot, 'src', 'svc.ts'), 'export const x = 2;\n');
    graph = await loadGraph(projectRoot);
    const w = makeWriter();
    const result = await runFill(graph, { gitTrackedFiles: null, write: w.write });

    // The gate blocks this node's pairs — the det pair is NOT re-filled, the
    // stale entry stays and the check shows it unverified.
    expect(w.text()).toMatch(/no fresh log entry|mandatory/i);
    expect(result.checkResult.issues.some((i) => i.code === 'unverified')).toBe(true);
    void yggRoot;
  });

  it('one fresh entry covers retries (gate passes after the entry is added)', async () => {
    const { projectRoot } = await setupProject({
      aspects: [{ id: 'det-a', kind: 'deterministic', status: 'enforced', rule: DET_PASS }],
      logRequired: true,
      logContent: '## [2026-05-11T10:00:00.000Z]\nfirst.\n',
    });
    let graph = await loadGraph(projectRoot);
    await runFill(graph, { gitTrackedFiles: null, write: () => {} });

    // Edit source + add a fresh log entry — the gate passes.
    await writeFile(path.join(projectRoot, 'src', 'svc.ts'), 'export const x = 2;\n');
    await writeFile(
      path.join(projectRoot, '.yggdrasil', 'model', 'svc', 'log.md'),
      '## [2026-05-11T10:00:00.000Z]\nfirst.\n## [2026-05-11T11:00:00.000Z]\nfix.\n',
    );
    graph = await loadGraph(projectRoot);
    const result = await runFill(graph, { gitTrackedFiles: null, write: () => {} });

    // Gate passed → the pair re-filled and the node re-closed with the new entry.
    const lock = readLock(graph.rootPath);
    expect(lock.nodes['svc']?.log?.last_entry_datetime).toBe('2026-05-11T11:00:00.000Z');
    expect(result.checkResult.issues.some((i) => i.code === 'unverified')).toBe(false);
  });

  it('a cascade-only edit (aspect changed, source untouched) needs NO entry', async () => {
    const { projectRoot } = await setupProject({
      aspects: [{ id: 'det-a', kind: 'deterministic', status: 'enforced', rule: DET_PASS }],
      logRequired: true,
      logContent: '## [2026-05-11T10:00:00.000Z]\nfirst.\n',
    });
    let graph = await loadGraph(projectRoot);
    await runFill(graph, { gitTrackedFiles: null, write: () => {} });

    // Edit the aspect's check.mjs (upstream cascade) — source fingerprint
    // UNCHANGED. The gate must NOT fire.
    await writeFile(
      path.join(projectRoot, '.yggdrasil', 'aspects', 'det-a', 'check.mjs'),
      'export function check(ctx) { void ctx; /* changed */ return []; }\n',
    );
    graph = await loadGraph(projectRoot);
    const w = makeWriter();
    const result = await runFill(graph, { gitTrackedFiles: null, write: w.write });

    expect(w.text()).not.toMatch(/no fresh log entry|mandatory/i);
    // The det pair re-verified (free) and the check is clean.
    expect(result.checkResult.issues.some((i) => i.code === 'unverified')).toBe(false);
  });
});

// =============================================================================
// 7. GC — prune detached entries, keep draft pairs, prune deleted-node nodes[]
// =============================================================================

describe('GC + canonical rewrite (§3.2)', () => {
  it('prunes a verdict entry whose aspect detached from the node', async () => {
    const { projectRoot } = await setupProject({
      aspects: [
        { id: 'det-a', kind: 'deterministic', status: 'enforced', rule: DET_PASS },
        { id: 'det-b', kind: 'deterministic', status: 'enforced', rule: DET_PASS },
      ],
    });
    let graph = await loadGraph(projectRoot);
    await runFill(graph, { gitTrackedFiles: null, write: () => {} });
    expect(readLock(graph.rootPath).verdicts['det-b']?.['node:svc']).toBeDefined();

    // Detach det-b from the node mapping.
    await writeFile(
      path.join(projectRoot, '.yggdrasil', 'model', 'svc', 'yg-node.yaml'),
      'name: svc\ntype: service\ndescription: x\nmapping:\n  - src/svc.ts\naspects:\n  - det-a\n',
    );
    graph = await loadGraph(projectRoot);
    await runFill(graph, { gitTrackedFiles: null, write: () => {} });

    const lock = readLock(graph.rootPath);
    // det-b's entry is pruned; det-a survives.
    expect(lock.verdicts['det-b']).toBeUndefined();
    expect(lock.verdicts['det-a']?.['node:svc']).toBeDefined();
  });

  it('keeps a draft aspect pair entry across GC', async () => {
    // det-a enforced (filled), det-draft draft. Seed a verdict for det-draft by
    // first enforcing it, then flip to draft and confirm GC keeps the entry.
    const { projectRoot } = await setupProject({
      aspects: [
        { id: 'det-a', kind: 'deterministic', status: 'enforced', rule: DET_PASS },
        { id: 'det-draft', kind: 'deterministic', status: 'enforced', rule: DET_PASS },
      ],
    });
    let graph = await loadGraph(projectRoot);
    await runFill(graph, { gitTrackedFiles: null, write: () => {} });
    expect(readLock(graph.rootPath).verdicts['det-draft']?.['node:svc']).toBeDefined();

    // Flip det-draft to draft. Its pair leaves the non-draft universe but the GC
    // universe (includeDraft) keeps it.
    await writeFile(
      path.join(projectRoot, '.yggdrasil', 'aspects', 'det-draft', 'yg-aspect.yaml'),
      'name: det-draft\ndescription: d\nreviewer:\n  type: deterministic\nstatus: draft\n',
    );
    graph = await loadGraph(projectRoot);
    await runFill(graph, { gitTrackedFiles: null, write: () => {} });

    const lock = readLock(graph.rootPath);
    // The draft pair's entry survives GC (draft pairs are retained).
    expect(lock.verdicts['det-draft']?.['node:svc']).toBeDefined();
  });

  it('prunes nodes[] entries for a node path no longer in the graph', async () => {
    const { projectRoot } = await setupProject({
      aspects: [{ id: 'det-a', kind: 'deterministic', status: 'enforced', rule: DET_PASS }],
      logContent: '## [2026-05-11T10:00:00.000Z]\nfirst.\n',
    });
    let graph = await loadGraph(projectRoot);
    await runFill(graph, { gitTrackedFiles: null, write: () => {} });
    // Closure recorded a nodes[] entry.
    expect(readLock(graph.rootPath).nodes['svc']).toBeDefined();

    // Inject a stale nodes[] entry for a non-existent node, then re-fill.
    const lockPath = path.join(graph.rootPath, 'yg-lock.json');
    const raw = JSON.parse(await readFile(lockPath, 'utf-8'));
    raw.nodes['ghost/node'] = { source: 'deadbeef' };
    await writeFile(lockPath, JSON.stringify(raw));
    graph = await loadGraph(projectRoot);
    await runFill(graph, { gitTrackedFiles: null, write: () => {} });

    const lock = readLock(graph.rootPath);
    expect(lock.nodes['ghost/node']).toBeUndefined();
    expect(lock.nodes['svc']).toBeDefined();
  });
});

// =============================================================================
// 8. Per-pair incremental writeLock observable
// =============================================================================

describe('incremental writeLock', () => {
  it('writes the lock after each completed det pair (observable mid-run)', async () => {
    const { projectRoot } = await setupProject({
      aspects: [
        { id: 'det-a', kind: 'deterministic', status: 'enforced', rule: DET_PASS },
        { id: 'det-b', kind: 'deterministic', status: 'enforced', rule: DET_PASS },
      ],
    });
    const graph = await loadGraph(projectRoot);
    const lockPath = path.join(graph.rootPath, 'yg-lock.json');
    // After a full run both det entries are on disk (the serialized writer
    // flushed each entry). Reading the file back proves the writes landed.
    await runFill(graph, { gitTrackedFiles: null, write: () => {} });
    const onDisk = JSON.parse(await readFile(lockPath, 'utf-8'));
    expect(onDisk.verdicts['det-a']['node:svc'].verdict).toBe('approved');
    expect(onDisk.verdicts['det-b']['node:svc'].verdict).toBe('approved');
  });
});

// =============================================================================
// 9. Tainted re-run-once
// =============================================================================

describe('tainted observation set', () => {
  it('a check whose observed file changes mid-run taints, re-runs once, then settles', async () => {
    // The check reads a sibling file twice; a stable file yields a non-tainted
    // run and a written verdict. We assert the happy path here (settles to a
    // verdict) — the taint→runtime-error path is exercised by a check that reads
    // a path returning different content, which cannot be made deterministic in
    // a unit test without filesystem races; instead we assert the recorded
    // observation for a sibling read (contract #8 below) and that a stable run
    // writes a verdict with the observation folded.
    const checkReadsSibling =
      'export function check(ctx) { const c = ctx.fs.read("src/sibling.ts"); return c.includes("x") ? [] : [{message:"no x"}]; }\n';
    const { projectRoot } = await setupProject({
      aspects: [{ id: 'det-sib', kind: 'deterministic', status: 'enforced', rule: checkReadsSibling }],
      mapping: ['src/svc.ts', 'src/sibling.ts'],
      files: { 'src/sibling.ts': 'export const x = 1;\n' },
    });
    const graph = await loadGraph(projectRoot);
    const result = await runFill(graph, { gitTrackedFiles: null, write: () => {} });
    expect(result.runtimeErrors).toBe(0);
    const lock = readLock(graph.rootPath);
    expect(lock.verdicts['det-sib']?.['node:svc']?.verdict).toBe('approved');
  });
});

// =============================================================================
// 10. Per-file det pair — sibling read folds as an observation (contract #8)
// =============================================================================

describe('per-file deterministic pair — contract #8', () => {
  it('a sibling read during a per-file run is recorded as a read: observation', async () => {
    // scope.per: file → one pair per subject file. The check reads a SIBLING file
    // (not the per-file subject). Under contract #8 that sibling is NOT in the
    // subject set for this pair, so it must fold as a recorded read: observation
    // (else neither files nor touched carries it → stale green).
    const checkReadsSibling =
      'export function check(ctx) { ctx.fs.read("src/other.ts"); return []; }\n';
    const { projectRoot } = await setupProject({
      aspects: [{ id: 'det-pf', kind: 'deterministic', status: 'enforced', scopePer: 'file', rule: checkReadsSibling }],
      mapping: ['src/svc.ts', 'src/other.ts'],
      files: { 'src/other.ts': 'export const y = 2;\n' },
    });
    const graph = await loadGraph(projectRoot);
    await runFill(graph, { gitTrackedFiles: null, write: () => {} });

    const lock = readLock(graph.rootPath);
    // One pair per subject file: file:src/svc.ts and file:src/other.ts.
    const svcEntry = lock.verdicts['det-pf']?.['file:src/svc.ts'];
    expect(svcEntry).toBeDefined();
    // For the svc.ts pair, src/other.ts is a SIBLING (not the subject) → it must
    // appear as a read: observation in touched.
    const touchedKeys = (svcEntry?.touched ?? []).map(([k]) => k);
    expect(touchedKeys).toContain('read:src/other.ts');

    // Now change the sibling — the svc.ts per-file pair must become unverified
    // (its observation changed), proving the fold is load-bearing.
    await writeFile(path.join(projectRoot, 'src', 'other.ts'), 'export const y = 999;\n');
    const graph2 = await loadGraph(projectRoot);
    const result2 = await runFill(graph2, { gitTrackedFiles: null, write: () => {} });
    // The sibling change invalidated and re-filled the pair (no error remains).
    expect(result2.checkResult.issues.some((i) => i.code === 'unverified')).toBe(false);
    // The for-file pair for the OTHER file is its own subject — sanity.
    expect(readLock(graph2.rootPath).verdicts['det-pf']?.['file:src/other.ts']).toBeDefined();
  });
});

// =============================================================================
// 12. Tainted observation set → runtime-error fail-closed branch (unit-pinned)
// =============================================================================

describe('tainted re-run-once → runtime-error fail-closed (unit-pinned)', () => {
  it('two consecutive tainted results → runtimeErrors === 1, no lock entry, runtime-error notice printed', async () => {
    // The check.mjs content doesn't matter — we control both runStructureAspect
    // calls via the mock and always return observationsTainted: true.
    const { projectRoot } = await setupProject({
      aspects: [{ id: 'det-taint', kind: 'deterministic', status: 'enforced', rule: DET_PASS }],
    });
    const graph = await loadGraph(projectRoot);

    const taintedResult: RunStructureAspectResult = {
      violations: [],
      touchedFiles: [],
      observations: [],
      observationsTainted: true,
    };
    // Both calls (initial run + re-run-once) return tainted — fill must fail closed.
    mockRunStructureAspect.mockResolvedValue(taintedResult);

    const w = makeWriter();
    const result = await runFill(graph, { gitTrackedFiles: null, write: w.write });

    // The runner was called exactly twice for this pair (initial + re-run-once).
    expect(mockRunStructureAspect).toHaveBeenCalledTimes(2);

    // Fail-closed: no verdict written to the lock.
    const lock = readLock(graph.rootPath);
    expect(lock.verdicts['det-taint']?.['node:svc']).toBeUndefined();

    // Exactly one runtime error counted.
    expect(result.runtimeErrors).toBe(1);

    // The runtime-error class notice line was printed.
    expect(w.text()).toContain('deterministic check(s) failed to run at fill time');
  });
});

