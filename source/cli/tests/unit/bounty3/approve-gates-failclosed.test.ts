// BOUNTY 3 — Adversarial tests for the approve gates: mandatory-log,
// fail-closed (#2), and advisory/enforced/draft exit semantics.
//
// These probe INVARIANTS that, if broken, would mean false-green / lost drift /
// wrong verdict — the high-value failure modes:
//
//   H2  — one log entry covers all retries until a SUCCESSFUL approve. A REFUSED
//         commit must NOT advance the log-freshness baseline (it marks the last
//         SUCCESSFUL approve), so the same entry still satisfies the gate on the
//         fix-and-retry. (approve-reviewer.ts finalizeAndReturn, lines ~437-445.)
//   #2  — fail-closed: an infra disposition (no reviewer configured for an LLM
//         aspect, zero readable source for an LLM aspect, tier-resolution
//         failure, provider unreachable) writes NOTHING. The PRIOR baseline —
//         hash, verdicts, AND log — must stay byte-identical.
//   gate independence — the mandatory-log gate keys ONLY off log_required + a
//         source change, never on aspect status; a cascade-only (upstream) drift
//         needs no fresh entry.
//   advisory/enforced/draft — enforced refusal exits 1 and records a refused
//         verdict (stays red); advisory refusal is approved-family (exit 0) yet
//         still records the per-aspect refused verdict in the baseline; draft is
//         skipped entirely.
//
// HERMETIC: createLlmProvider is mocked (no network, no real reviewer). The E2E
// case drives the real binary against a deterministic-only copy of the
// e2e-lifecycle fixture (no reviewer endpoint dialed). Every temp tree is a
// fresh mkdtemp, cleaned in finally/afterEach. No wall clock is read in any
// assertion.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  mkdtemp, mkdir, writeFile, rm,
} from 'node:fs/promises';
import {
  existsSync, mkdtempSync, rmSync, cpSync, readFileSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { loadGraph } from '../../../src/core/graph-loader.js';
import { approveNode } from '../../../src/core/approve.js';
import { runApproveWithReviewer } from '../../../src/core/approve-reviewer.js';
import { readNodeDriftState, writeNodeDriftState } from '../../../src/io/drift-state-store.js';
import { recordBaselineForAllMappedNodes } from '../helpers/seed-baseline.js';
import type { LlmProvider } from '../../../src/llm/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const V5_REVIEWER_CONFIG =
  'reviewer:\n  tiers:\n    standard:\n      provider: ollama\n      consensus: 1\n      config:\n        model: llama3\n';

const LLM_ASPECT_YAML = (status?: string) =>
  `name: Rule\ndescription: A rule\nreviewer:\n  type: llm\n${status ? `status: ${status}\n` : ''}`;

vi.mock('../../../src/llm/index.js', () => ({
  createLlmProvider: vi.fn(),
}));
import { createLlmProvider } from '../../../src/llm/index.js';
const mockCreateLlmProvider = vi.mocked(createLlmProvider);

function makeMockProvider(overrides: Partial<LlmProvider> = {}): LlmProvider {
  return {
    verifyAspect: async () => ({ satisfied: true, reason: 'ok', errorSource: 'codeViolation' as const }),
    isAvailable: async () => true,
    ...overrides,
  };
}

/**
 * Real prefix hash for a single-entry log, matching computeLogBaseline: the
 * boundary entry's offsetEnd is the end of the file, so the prefix is the whole
 * content. Required so the append-only integrity check (which runs FIRST in
 * approveNode) does not refuse with prefix_modified before the gate/reviewer.
 */
function sha(content: string): string {
  return createHash('sha256').update(Buffer.from(content, 'utf-8')).digest('hex');
}

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
beforeEach(() => {
  vi.resetAllMocks();
});

/**
 * Build a minimal project with one log_required service node mapping a single
 * source file, plus a configurable set of aspects. Mirrors the established
 * createTmpProject pattern from approve-llm.test.ts but lives in a fresh
 * mkdtemp tree (never touches the repo's own files).
 */
async function setupProject(opts: {
  nodeAspects: string[];
  aspects: Array<{ id: string; yaml: string; files?: Record<string, string> }>;
  configYaml?: string;
  sourceContent?: string;
  logContent?: string;
  logRequired?: boolean;
}): Promise<{ projectRoot: string; yggRoot: string; nodePath: string; sourceAbs: string; logAbs: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'yg-bounty3-'));
  dirs.push(root);
  const yggRoot = path.join(root, '.yggdrasil');
  const nodeDir = path.join(yggRoot, 'model', 'svc');
  await mkdir(nodeDir, { recursive: true });
  await mkdir(path.join(yggRoot, '.drift-state'), { recursive: true });
  await mkdir(path.join(yggRoot, 'schemas'), { recursive: true });
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(yggRoot, 'schemas', 'yg-node.yaml'), 'type: node\n');
  await writeFile(path.join(yggRoot, 'schemas', 'yg-aspect.yaml'), 'type: aspect\n');
  await writeFile(path.join(yggRoot, 'schemas', 'yg-flow.yaml'), 'type: flow\n');
  await writeFile(path.join(yggRoot, 'yg-config.yaml'), opts.configYaml ?? V5_REVIEWER_CONFIG);
  await writeFile(
    path.join(yggRoot, 'yg-architecture.yaml'),
    `node_types:\n  service:\n    description: s\n    log_required: ${opts.logRequired ?? true}\n`,
  );
  await writeFile(
    path.join(nodeDir, 'yg-node.yaml'),
    `name: svc\ntype: service\ndescription: x\nmapping:\n  - src/svc.ts\naspects:\n${opts.nodeAspects.map((a) => `  - ${a}`).join('\n')}\n`,
  );
  await writeFile(path.join(root, 'src', 'svc.ts'), opts.sourceContent ?? 'export const x = 1;\n');
  const logAbs = path.join(nodeDir, 'log.md');
  if (opts.logContent !== undefined) await writeFile(logAbs, opts.logContent);
  for (const asp of opts.aspects) {
    const aspDir = path.join(yggRoot, 'aspects', asp.id);
    await mkdir(aspDir, { recursive: true });
    await writeFile(path.join(aspDir, 'yg-aspect.yaml'), asp.yaml);
    for (const [name, content] of Object.entries(asp.files ?? {})) {
      await writeFile(path.join(aspDir, name), content);
    }
  }
  return { projectRoot: root, yggRoot, nodePath: 'svc', sourceAbs: path.join(root, 'src', 'svc.ts'), logAbs };
}

// ===========================================================================
// 1. H2 — one log entry covers all retries until a SUCCESSFUL approve
// ===========================================================================
//
// The deepest invariant in finalizeAndReturn: on a REFUSED commit the persisted
// log baseline must stay at the PRIOR (last-successful-approve) value, NOT the
// fresh entry written this cycle. Otherwise the next fix-and-retry would see the
// just-added entry as "already baselined" and the mandatory-log gate would
// re-fire, demanding a second entry per retry.

describe('H2 — refused commit does NOT advance the log-freshness baseline', () => {
  it('an enforced refusal preserves the PRIOR log baseline (one entry still covers the retry)', async () => {
    const PRIOR_LOG = '## [2026-05-11T10:00:00.000Z]\nfirst.\n';
    const { projectRoot, yggRoot, nodePath, sourceAbs, logAbs } = await setupProject({
      nodeAspects: ['enforced-rule'],
      aspects: [{ id: 'enforced-rule', yaml: LLM_ASPECT_YAML('enforced'), files: { 'content.md': 'Enforced rule.\n' } }],
      logContent: PRIOR_LOG,
    });

    // Establish a green baseline whose log boundary is the PRIOR entry.
    const g0 = await loadGraph(projectRoot);
    await recordBaselineForAllMappedNodes(g0);
    // Stamp the prior log baseline onto the stored state (recordBaseline omits log).
    const seeded = await readNodeDriftState(yggRoot, nodePath);
    await writeNodeDriftState(yggRoot, nodePath, {
      ...seeded!,
      log: { last_entry_datetime: '2026-05-11T10:00:00.000Z', prefix_hash: sha(PRIOR_LOG) },
    });
    const before = await readNodeDriftState(yggRoot, nodePath);

    // Edit source + add a FRESH log entry (one entry for the whole retry cycle).
    await writeFile(sourceAbs, 'export const x = 2;\n');
    await writeFile(logAbs, PRIOR_LOG + '## [2026-05-11T11:00:00.000Z]\nfix attempt.\n');

    const graph = await loadGraph(projectRoot);
    const coreResult = await approveNode(graph, nodePath);
    // The gate passes (fresh entry present), so the core does not refuse.
    expect(coreResult.action).not.toBe('refused');

    mockCreateLlmProvider.mockReturnValue(makeMockProvider({
      async verifyAspect() { return { satisfied: false, reason: 'violation', errorSource: 'codeViolation' as const }; },
    }));

    const result = await runApproveWithReviewer({
      graph, nodePath, result: coreResult, rootPath: graph.rootPath,
      secretsByProvider: new Map(), storedEntry: before ?? undefined,
    });

    // Enforced code violation → refused, exit-1 semantics.
    expect(result.action).toBe('refused');

    // INVARIANT: the persisted log baseline must STILL be the prior entry — the
    // refused commit must not have advanced it to 2026-05-11T11:00.
    const stored = await readNodeDriftState(yggRoot, nodePath);
    expect(stored?.log?.last_entry_datetime).toBe('2026-05-11T10:00:00.000Z');
    // The refused verdict is recorded (stays red), proving the commit DID run
    // (hash/verdicts advance) — only the log freshness baseline was held back.
    expect(stored?.aspectVerdicts?.['enforced-rule']?.verdict).toBe('refused');
  });

  it('a refusal with NO prior log baseline deletes log (does not invent a fresh boundary)', async () => {
    // First approve (no baseline yet) with a fresh entry but an enforced
    // violation. anyRefused → the H2 branch must DELETE the log on the pending
    // state (storedEntry.log is undefined), never persist the fresh entry as a
    // boundary that would falsely satisfy the gate on the next attempt.
    const { projectRoot, yggRoot, nodePath } = await setupProject({
      nodeAspects: ['enforced-rule'],
      aspects: [{ id: 'enforced-rule', yaml: LLM_ASPECT_YAML('enforced'), files: { 'content.md': 'Enforced rule.\n' } }],
      logContent: '## [2026-05-11T10:00:00.000Z]\nbootstrap.\n',
    });

    const graph = await loadGraph(projectRoot);
    const coreResult = await approveNode(graph, nodePath); // first approve → initial
    expect(coreResult.action).toBe('initial');

    mockCreateLlmProvider.mockReturnValue(makeMockProvider({
      async verifyAspect() { return { satisfied: false, reason: 'violation', errorSource: 'codeViolation' as const }; },
    }));

    const result = await runApproveWithReviewer({
      graph, nodePath, result: coreResult, rootPath: graph.rootPath,
      secretsByProvider: new Map(),
    });
    expect(result.action).toBe('refused');

    const stored = await readNodeDriftState(yggRoot, nodePath);
    // No prior log baseline existed → the refused commit must leave log absent,
    // so "fresh entry = any entry exists" still holds and one entry covers the
    // retry. (If it persisted 10:00 as a boundary, the retry would need a 2nd entry.)
    expect(stored?.log).toBeUndefined();
    expect(stored?.aspectVerdicts?.['enforced-rule']?.verdict).toBe('refused');
  });
});

// ===========================================================================
// 2. FAIL-CLOSED (#2) — infra disposition writes NOTHING (prior baseline intact)
// ===========================================================================
//
// The existing zero-source / no-reviewer tests assert only the HASH is
// unchanged. The invariant is stronger: the ENTIRE prior baseline — verdicts,
// log, files — must be byte-identical after an infra refusal. A drift would mean
// lost drift state or a creeping false-green.

describe('fail-closed (#2) — no reviewer configured leaves the WHOLE prior baseline intact', () => {
  it('does not mutate verdicts/log/hash/files when an LLM aspect cannot be verified', async () => {
    const { projectRoot, yggRoot, nodePath, sourceAbs } = await setupProject({
      nodeAspects: ['llm-rule'],
      aspects: [{ id: 'llm-rule', yaml: LLM_ASPECT_YAML(), files: { 'content.md': 'rule.\n' } }],
      configYaml: 'version: "5.0.0"\n', // NO reviewer section
      logContent: '## [2026-05-11T10:00:00.000Z]\nfirst.\n',
    });

    // Seed a full green baseline (with a log boundary + an approved verdict).
    const g0 = await loadGraph(projectRoot);
    await recordBaselineForAllMappedNodes(g0);
    const seeded = await readNodeDriftState(yggRoot, nodePath);
    await writeNodeDriftState(yggRoot, nodePath, {
      ...seeded!,
      aspectVerdicts: { 'llm-rule': { verdict: 'approved' } },
      log: { last_entry_datetime: '2026-05-11T10:00:00.000Z', prefix_hash: sha('## [2026-05-11T10:00:00.000Z]\nfirst.\n') },
    });
    const before = JSON.stringify(await readNodeDriftState(yggRoot, nodePath));

    // Edit source so the would-be approve has something to (not) verify, and add
    // a fresh log entry so the mandatory-log gate passes and the reviewer phase
    // (where the no-reviewer fail-closed lives) is actually reached.
    await writeFile(sourceAbs, 'export const x = 2;\n');
    await writeFile(
      path.join(yggRoot, 'model', 'svc', 'log.md'),
      '## [2026-05-11T10:00:00.000Z]\nfirst.\n## [2026-05-11T11:00:00.000Z]\nretry.\n',
    );

    const graph = await loadGraph(projectRoot);
    const coreResult = await approveNode(graph, nodePath);
    expect(coreResult.action).not.toBe('refused');

    const result = await runApproveWithReviewer({
      graph, nodePath, result: coreResult, rootPath: graph.rootPath,
      secretsByProvider: new Map(), storedEntry: await readNodeDriftState(yggRoot, nodePath) ?? undefined,
    });

    expect(result.action).toBe('refused');
    expect(result.llmSkipped).toBe('unavailable');
    // The provider must never have been constructed.
    expect(mockCreateLlmProvider).not.toHaveBeenCalled();

    // INVARIANT: the persisted baseline is byte-identical to before.
    const after = JSON.stringify(await readNodeDriftState(yggRoot, nodePath));
    expect(after).toBe(before);
  });
});

describe('fail-closed (#2) — provider unreachable does not commit', () => {
  it('refuses (infra) and leaves the prior baseline intact when isAvailable() is false', async () => {
    const { projectRoot, yggRoot, nodePath, sourceAbs } = await setupProject({
      nodeAspects: ['llm-rule'],
      aspects: [{ id: 'llm-rule', yaml: LLM_ASPECT_YAML('enforced'), files: { 'content.md': 'rule.\n' } }],
      logContent: '## [2026-05-11T10:00:00.000Z]\nfirst.\n',
    });
    const g0 = await loadGraph(projectRoot);
    await recordBaselineForAllMappedNodes(g0);
    const before = JSON.stringify(await readNodeDriftState(yggRoot, nodePath));

    await writeFile(sourceAbs, 'export const x = 2;\n');
    // Re-add a fresh entry so the log gate passes and the reviewer is reached.
    await writeFile(
      path.join(yggRoot, 'model', 'svc', 'log.md'),
      '## [2026-05-11T10:00:00.000Z]\nfirst.\n## [2026-05-11T11:00:00.000Z]\nretry.\n',
    );

    const graph = await loadGraph(projectRoot);
    const coreResult = await approveNode(graph, nodePath);
    expect(coreResult.action).not.toBe('refused');

    let verifyCalls = 0;
    mockCreateLlmProvider.mockReturnValue(makeMockProvider({
      isAvailable: async () => false,
      async verifyAspect() { verifyCalls++; return { satisfied: true, reason: 'ok', errorSource: 'codeViolation' as const }; },
    }));

    const result = await runApproveWithReviewer({
      graph, nodePath, result: coreResult, rootPath: graph.rootPath,
      secretsByProvider: new Map(), storedEntry: await readNodeDriftState(yggRoot, nodePath) ?? undefined,
    });

    expect(result.action).toBe('refused');
    expect(result.llmSkipped).toBe('unavailable');
    // The reviewer was never asked to verify (availability gate short-circuited).
    expect(verifyCalls).toBe(0);
    // Baseline untouched.
    expect(JSON.stringify(await readNodeDriftState(yggRoot, nodePath))).toBe(before);
  });
});

describe('fail-closed (#2) — tier resolution failure does not commit', () => {
  it('refuses (infra) when an LLM aspect names a tier that does not exist', async () => {
    const { projectRoot, yggRoot, nodePath, sourceAbs } = await setupProject({
      nodeAspects: ['llm-rule'],
      // The aspect demands tier "ghost", which is absent from yg-config.yaml.
      aspects: [{
        id: 'llm-rule',
        yaml: 'name: Rule\ndescription: A rule\nreviewer:\n  type: llm\n  tier: ghost\nstatus: enforced\n',
        files: { 'content.md': 'rule.\n' },
      }],
      logContent: '## [2026-05-11T10:00:00.000Z]\nfirst.\n',
    });
    const g0 = await loadGraph(projectRoot);
    await recordBaselineForAllMappedNodes(g0);
    const before = JSON.stringify(await readNodeDriftState(yggRoot, nodePath));

    await writeFile(sourceAbs, 'export const x = 2;\n');
    await writeFile(
      path.join(yggRoot, 'model', 'svc', 'log.md'),
      '## [2026-05-11T10:00:00.000Z]\nfirst.\n## [2026-05-11T11:00:00.000Z]\nretry.\n',
    );

    const graph = await loadGraph(projectRoot);
    const coreResult = await approveNode(graph, nodePath);
    expect(coreResult.action).not.toBe('refused');

    mockCreateLlmProvider.mockReturnValue(makeMockProvider());
    const result = await runApproveWithReviewer({
      graph, nodePath, result: coreResult, rootPath: graph.rootPath,
      secretsByProvider: new Map(), storedEntry: await readNodeDriftState(yggRoot, nodePath) ?? undefined,
    });

    expect(result.action).toBe('refused');
    // Tier-resolution is a config problem (infra) → provider never constructed,
    // baseline never advanced.
    expect(mockCreateLlmProvider).not.toHaveBeenCalled();
    expect(JSON.stringify(await readNodeDriftState(yggRoot, nodePath))).toBe(before);
  });
});

// ===========================================================================
// 3. ADVISORY vs ENFORCED — verdict + commit semantics
// ===========================================================================

describe('advisory vs enforced — commit + log-baseline behavior', () => {
  it('advisory-only code violation is approved-family (exit 0) yet still records the refused verdict', async () => {
    const { projectRoot, yggRoot, nodePath, sourceAbs } = await setupProject({
      nodeAspects: ['advisory-rule'],
      aspects: [{ id: 'advisory-rule', yaml: LLM_ASPECT_YAML('advisory'), files: { 'content.md': 'advisory rule.\n' } }],
      logContent: '## [2026-05-11T10:00:00.000Z]\nfirst.\n',
    });
    const g0 = await loadGraph(projectRoot);
    await recordBaselineForAllMappedNodes(g0);
    await writeNodeDriftState(yggRoot, nodePath, {
      ...(await readNodeDriftState(yggRoot, nodePath))!,
      log: { last_entry_datetime: '2026-05-11T10:00:00.000Z', prefix_hash: sha('## [2026-05-11T10:00:00.000Z]\nfirst.\n') },
    });

    await writeFile(sourceAbs, 'export const x = 2;\n');
    await writeFile(
      path.join(yggRoot, 'model', 'svc', 'log.md'),
      '## [2026-05-11T10:00:00.000Z]\nfirst.\n## [2026-05-11T11:00:00.000Z]\nsecond.\n',
    );

    const graph = await loadGraph(projectRoot);
    const coreResult = await approveNode(graph, nodePath);
    expect(coreResult.action).not.toBe('refused');

    mockCreateLlmProvider.mockReturnValue(makeMockProvider({
      async verifyAspect() { return { satisfied: false, reason: 'advisory issue', errorSource: 'codeViolation' as const }; },
    }));

    const result = await runApproveWithReviewer({
      graph, nodePath, result: coreResult, rootPath: graph.rootPath,
      secretsByProvider: new Map(), storedEntry: await readNodeDriftState(yggRoot, nodePath) ?? undefined,
    });

    // Advisory does NOT block — the action is approved-family (CLI exits 0).
    expect(result.action).not.toBe('refused');
    expect(result.advisoryViolations?.map((v) => v.aspectId)).toEqual(['advisory-rule']);

    // The baseline is recorded (verdict persisted as refused so check renders a warning).
    const stored = await readNodeDriftState(yggRoot, nodePath);
    expect(stored?.aspectVerdicts?.['advisory-rule']?.verdict).toBe('refused');

    // An advisory code violation produces a `refused` verdict, so the H2
    // anyRefused branch fires and the log baseline is HELD at the prior entry
    // (10:00) — the advisory cycle is treated as "not a successful approve" for
    // log-freshness purposes. Pin the observed behavior.
    expect(stored?.log?.last_entry_datetime).toBe('2026-05-11T10:00:00.000Z');
  });

  it('a clean approve (no violations) ADVANCES the log baseline to the fresh entry', async () => {
    // Control case for the H2 branch: with NO refused verdict, the fresh log
    // entry becomes the new boundary (last successful approve).
    const { projectRoot, yggRoot, nodePath, sourceAbs } = await setupProject({
      nodeAspects: ['enforced-rule'],
      aspects: [{ id: 'enforced-rule', yaml: LLM_ASPECT_YAML('enforced'), files: { 'content.md': 'rule.\n' } }],
      logContent: '## [2026-05-11T10:00:00.000Z]\nfirst.\n',
    });
    const g0 = await loadGraph(projectRoot);
    await recordBaselineForAllMappedNodes(g0);
    await writeNodeDriftState(yggRoot, nodePath, {
      ...(await readNodeDriftState(yggRoot, nodePath))!,
      log: { last_entry_datetime: '2026-05-11T10:00:00.000Z', prefix_hash: sha('## [2026-05-11T10:00:00.000Z]\nfirst.\n') },
    });

    await writeFile(sourceAbs, 'export const x = 2;\n');
    await writeFile(
      path.join(yggRoot, 'model', 'svc', 'log.md'),
      '## [2026-05-11T10:00:00.000Z]\nfirst.\n## [2026-05-11T11:00:00.000Z]\nsecond.\n',
    );

    const graph = await loadGraph(projectRoot);
    const coreResult = await approveNode(graph, nodePath);
    expect(coreResult.action).toBe('approved');

    mockCreateLlmProvider.mockReturnValue(makeMockProvider());
    const result = await runApproveWithReviewer({
      graph, nodePath, result: coreResult, rootPath: graph.rootPath,
      secretsByProvider: new Map(), storedEntry: await readNodeDriftState(yggRoot, nodePath) ?? undefined,
    });

    expect(result.action).toBe('approved');
    const stored = await readNodeDriftState(yggRoot, nodePath);
    expect(stored?.aspectVerdicts?.['enforced-rule']?.verdict).toBe('approved');
    // Successful approve → boundary advances to the fresh entry.
    expect(stored?.log?.last_entry_datetime).toBe('2026-05-11T11:00:00.000Z');
  });
});

// ===========================================================================
// 4. MANDATORY-LOG GATE — independence from aspect status + cascade-only exemption
//    (core-layer / approveNode — complements the E2E gate-semantics suite)
// ===========================================================================

describe('mandatory-log gate — core layer (approveNode)', () => {
  it('cascade-only re-approve (upstream drift, no source change) needs NO fresh log entry', async () => {
    const PRIOR_LOG = '## [2026-05-11T10:00:00.000Z]\nfirst.\n';
    const { projectRoot, yggRoot, nodePath } = await setupProject({
      nodeAspects: ['det-rule'],
      aspects: [{
        id: 'det-rule',
        yaml: 'name: Det\ndescription: d\nreviewer:\n  type: deterministic\nstatus: enforced\n',
        files: { 'check.mjs': 'export function check() { return []; }\n' },
      }],
      logContent: PRIOR_LOG,
    });

    // Green baseline, then change the aspect's check.mjs (upstream cascade only).
    const g0 = await loadGraph(projectRoot);
    await recordBaselineForAllMappedNodes(g0);
    const seeded = await readNodeDriftState(yggRoot, nodePath);
    await writeNodeDriftState(yggRoot, nodePath, {
      ...seeded!,
      log: { last_entry_datetime: '2026-05-11T10:00:00.000Z', prefix_hash: sha(PRIOR_LOG) },
    });

    // Edit the aspect implementation — upstream, not source. No new log entry.
    await writeFile(
      path.join(yggRoot, 'aspects', 'det-rule', 'check.mjs'),
      'export function check() { /* changed */ return []; }\n',
    );

    const graph = await loadGraph(projectRoot);
    const result = await approveNode(graph, nodePath);

    // The gate keys off a SOURCE change; an upstream-only change must NOT trip it.
    expect(result.action).not.toBe('refused');
    expect(result.refuseReasonData).toBeUndefined();
    expect(result.changedSource).toBeUndefined();
  });

  it('source change on a log_required type with NO fresh entry refuses (gate independent of status: all-draft)', async () => {
    const PRIOR_LOG = '## [2026-05-11T10:00:00.000Z]\nfirst.\n';
    const { projectRoot, yggRoot, nodePath, sourceAbs } = await setupProject({
      nodeAspects: ['draft-rule'],
      aspects: [{
        id: 'draft-rule',
        yaml: LLM_ASPECT_YAML('draft'),
        files: { 'content.md': 'wip.\n' },
      }],
      logContent: PRIOR_LOG,
    });
    const g0 = await loadGraph(projectRoot);
    await recordBaselineForAllMappedNodes(g0);
    const seeded = await readNodeDriftState(yggRoot, nodePath);
    await writeNodeDriftState(yggRoot, nodePath, {
      ...seeded!,
      log: { last_entry_datetime: '2026-05-11T10:00:00.000Z', prefix_hash: sha(PRIOR_LOG) },
    });

    // Source changes; no new log entry; every effective aspect is draft.
    await writeFile(sourceAbs, 'export const x = 2;\n');

    const graph = await loadGraph(projectRoot);
    const result = await approveNode(graph, nodePath);

    // Draft skips the REVIEWER, never the log gate.
    expect(result.action).toBe('refused');
    expect(result.refuseReasonData?.what ?? '').toMatch(/no log entry|mandatory/i);
  });

  it('log_required:false type skips the gate entirely on a source change', async () => {
    const { projectRoot, nodePath, sourceAbs } = await setupProject({
      nodeAspects: ['draft-rule'],
      aspects: [{ id: 'draft-rule', yaml: LLM_ASPECT_YAML('draft'), files: { 'content.md': 'wip.\n' } }],
      logRequired: false,
      // No log.md at all.
    });
    const g0 = await loadGraph(projectRoot);
    await recordBaselineForAllMappedNodes(g0);

    await writeFile(sourceAbs, 'export const x = 2;\n');
    const graph = await loadGraph(projectRoot);
    const result = await approveNode(graph, nodePath);

    expect(result.action).not.toBe('refused');
    expect(result.refuseReasonData).toBeUndefined();
  });
});

// ===========================================================================
// 5. E2E — spawn the real binary; advisory exits 0, enforced exits 1, both
//    leave the deterministic baseline state correct. Hermetic: deterministic
//    aspects only, no reviewer endpoint dialed.
// ===========================================================================

const CLI_ROOT = path.join(__dirname, '..', '..', '..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'e2e-lifecycle');
const distExists = existsSync(BIN_PATH);

function run(args: string[], cwd: string): { status: number | null; all: string } {
  const r = spawnSync('node', [BIN_PATH, ...args], { cwd, encoding: 'utf-8' });
  return { status: r.status, all: (r.stdout ?? '') + (r.stderr ?? '') };
}

/** Copy the fixture and strip the LLM aspect so approve is hermetic (no reviewer). */
function deterministicFixture(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-bounty3-e2e-${label}-`));
  cpSync(FIXTURE, dir, { recursive: true });
  const archPath = path.join(dir, '.yggdrasil', 'yg-architecture.yaml');
  const arch = readFileSync(archPath, 'utf-8')
    .split('\n')
    .filter((line) => line.trim() !== '- has-doc-comment')
    .join('\n');
  writeFileSync(archPath, arch, 'utf-8');
  rmSync(path.join(dir, '.yggdrasil', 'aspects', 'has-doc-comment'), { recursive: true, force: true });
  return dir;
}

const ordersFile = (dir: string) => path.join(dir, 'src', 'services', 'orders.ts');

describe.skipIf(!distExists)('E2E — advisory passes (exit 0), enforced blocks (exit 1)', () => {
  it('enforced deterministic violation refuses (exit 1) and stays red on check', () => {
    const dir = deterministicFixture('enforced-block');
    try {
      // Clean baseline first.
      expect(run(['approve', '--node', 'services/orders'], dir).status).toBe(0);
      // Introduce a TODO comment → trips the enforced `no-todo-comments` aspect.
      writeFileSync(ordersFile(dir), readFileSync(ordersFile(dir), 'utf-8') + '\n// TODO: fix me later\n', 'utf-8');
      const approve = run(['approve', '--node', 'services/orders'], dir);
      // Enforced code violation → exit 1.
      expect(approve.status).toBe(1);
      expect(approve.all).toMatch(/violation|not satisfied|no-todo/i);
      // yg check stays red.
      expect(run(['check'], dir).status).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('advisory-only deterministic violation approves (exit 0)', () => {
    const dir = deterministicFixture('advisory-pass');
    try {
      // Demote the only enforced aspect to advisory; requires-named-export is
      // already advisory; wip-rule is draft → no enforced aspect remains.
      const p = path.join(dir, '.yggdrasil', 'aspects', 'no-todo-comments', 'yg-aspect.yaml');
      writeFileSync(
        p,
        readFileSync(p, 'utf-8').replace(/status:\s*\S+/, 'status: advisory'),
        'utf-8',
      );
      // Clean baseline.
      expect(run(['approve', '--node', 'services/orders'], dir).status).toBe(0);
      // Violate the now-advisory no-todo rule.
      writeFileSync(ordersFile(dir), readFileSync(ordersFile(dir), 'utf-8') + '\n// TODO: advisory only\n', 'utf-8');
      const approve = run(['approve', '--node', 'services/orders'], dir);
      // Advisory violations warn but do NOT block → exit 0.
      expect(approve.status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// Keep an explicit reference to imported-but-conditionally-used helpers so the
// linter does not flag them if a branch is skipped on a host without dist.
void mkdtemp;
