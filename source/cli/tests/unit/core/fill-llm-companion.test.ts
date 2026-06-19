/**
 * Companion-resolution tests for the `yg check --approve` fill stage (core/fill.ts).
 * Split from fill-llm.test.ts to keep each file under the reviewer's 50 000-char
 * prompt limit (the `test-deterministic` aspect is per:file).
 *
 * Covers Task 5 companion resolution in the LLM fill path:
 *   taint guard, normalize/dedupe/sort, subject-dedupe, fail-closed infra branches,
 *   []-companion, companionHash/touched folding, and the companion happy-path.
 *
 * HERMETIC: createLlmProvider is mocked — no network, no real reviewer. Each
 * project is a fresh mkdtemp tree; the lock is written to / read from disk by the
 * fill stage.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { tmpdir } from 'node:os';
import {
  mkdtemp, mkdir, writeFile, rm, readFile,
} from 'node:fs/promises';

import { loadGraph } from '../../../src/core/graph-loader.js';
import { runFill } from '../../../src/core/fill.js';
import { buildIssueMessage } from '../../../src/formatters/message-builder.js';
import type { IssueMessage } from '../../../src/model/validation.js';
import { readLock } from '../../../src/io/lock-store.js';
import type { LlmProvider } from '../../../src/llm/types.js';
import type { RunCompanionHookResult } from '../../../src/structure/hook-loader.js';
import { computeLlmInputHash } from '../../../src/core/pair-hash.js';
import { observationKey, hashReadObservation } from '../../../src/core/pair-hash.js';
import { companionHashFor, ruleHashFor, tierHashViewFromTier } from '../../../src/core/pair-inputs.js';
import { hashBytes } from '../../../src/io/hash.js';

// ── Mock the LLM provider factory (no real reviewer) ──────────────────────────
vi.mock('../../../src/llm/index.js', () => ({
  createLlmProvider: vi.fn(),
}));
import { createLlmProvider } from '../../../src/llm/index.js';
const mockCreateLlmProvider = vi.mocked(createLlmProvider);

// ── Mock the structure runner (pass-through by default) ────────────────────────
// eslint-disable-next-line no-var
var structureRunnerRealFn: (typeof import('../../../src/structure/runner.js'))['runStructureAspect'] | undefined;
vi.mock('../../../src/structure/runner.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/structure/runner.js')>();
  structureRunnerRealFn = actual.runStructureAspect;
  return {
    ...actual,
    runStructureAspect: vi.fn(actual.runStructureAspect),
  };
});
import { runStructureAspect } from '../../../src/structure/runner.js';
const mockRunStructureAspect = vi.mocked(runStructureAspect);

// ── Mock the companion hook runner separately from the reviewer provider ───────
// eslint-disable-next-line no-var
var companionRealFn: (typeof import('../../../src/structure/hook-loader.js'))['runCompanionHook'] | undefined;
vi.mock('../../../src/structure/hook-loader.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/structure/hook-loader.js')>();
  companionRealFn = actual.runCompanionHook;
  return {
    ...actual,
    runCompanionHook: vi.fn(actual.runCompanionHook),
  };
});
import { runCompanionHook } from '../../../src/structure/hook-loader.js';
const mockRunCompanionHook = vi.mocked(runCompanionHook);

// ── Mock tier resolution (pass-through by default) ────────────────────────────
// eslint-disable-next-line no-var
var tierSelectRealFn: (typeof import('../../../src/core/tier-selection.js'))['selectTierForAspect'] | undefined;
vi.mock('../../../src/core/tier-selection.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/core/tier-selection.js')>();
  tierSelectRealFn = actual.selectTierForAspect;
  return {
    ...actual,
    selectTierForAspect: vi.fn(actual.selectTierForAspect),
  };
});
import { selectTierForAspect } from '../../../src/core/tier-selection.js';
const mockSelectTierForAspect = vi.mocked(selectTierForAspect);

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
  if (structureRunnerRealFn) {
    const real = structureRunnerRealFn;
    mockRunStructureAspect.mockImplementation(
      (...args: Parameters<typeof runStructureAspect>) => real(...args),
    );
  }
  if (tierSelectRealFn) {
    const real = tierSelectRealFn;
    mockSelectTierForAspect.mockImplementation(
      (...args: Parameters<typeof selectTierForAspect>) => real(...args),
    );
  }
  if (companionRealFn) {
    const real = companionRealFn;
    mockRunCompanionHook.mockImplementation(
      (...args: Parameters<typeof runCompanionHook>) => real(...args),
    );
  }
});

// ── Project builder ───────────────────────────────────────────────────────────

interface AspectSpec {
  id: string;
  kind: 'llm' | 'deterministic';
  status?: 'draft' | 'advisory' | 'enforced';
  rule: string;
  scopePer?: 'node' | 'file';
  references?: Array<{ path: string; description?: string }>;
  companion?: string;
}

interface ProjectSpec {
  aspects: AspectSpec[];
  files?: Record<string, string>;
  mapping?: string[];
  configYaml?: string;
  logContent?: string;
  logRequired?: boolean;
  extraFiles?: Record<string, string>;
}

async function setupProject(spec: ProjectSpec): Promise<{ projectRoot: string; yggRoot: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'yg-fill-'));
  dirs.push(root);
  const yggRoot = path.join(root, '.yggdrasil');
  const nodeDir = path.join(yggRoot, 'model', 'svc');
  await mkdir(nodeDir, { recursive: true });
  await mkdir(path.join(root, 'src'), { recursive: true });
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
    if (asp.companion !== undefined) await writeFile(path.join(aspDir, 'companion.mjs'), asp.companion);
  }
  return { projectRoot: root, yggRoot };
}

/** Capture fill output as a string so exact strings can be asserted. */
function makeWriter(): { write: (s: string) => void; emitIssue: (m: IssueMessage) => void; text: () => string } {
  let buf = '';
  const write = (s: string) => { buf += s; };
  return { write, emitIssue: (m) => { write(buildIssueMessage(m) + '\n'); }, text: () => buf };
}

// =============================================================================
// Task 5: companion resolution in the LLM fill path
//
// fill-llm.ts resolves an aspect's companion.mjs BEFORE the reviewer runs (so a
// torn observation set never costs a reviewer call), normalizes + dedupes +
// subject-drops the returned paths, validates each against allowed-reads, reads
// its bytes into the prompt, folds the companion-read observations into `touched`,
// and folds companionHash UNCONDITIONALLY. Every companion failure path is
// fail-closed: NOTHING written, callsMade: 0.
//
// The companion hook runner is mocked as its OWN spy (mockRunCompanionHook), so
// the hook-run count and the reviewer-call count are asserted independently.
// =============================================================================

describe('Task 5 — companion resolution in the LLM fill path', () => {
  it('happy path: resolved companion appears in touched and the hash folds touched + companionHash', async () => {
    // companion.mjs returns one path (src/partner.ts), a RELATION-REACHABLE file
    // owned by a node svc declares a `uses` relation to — so it is in svc's
    // allowed-reads but is NOT a subject of svc's aspect. (A mapped own-file would
    // be a subject for a per:node LLM aspect and get subject-dropped instead.)
    const COMPANION_CONTENT = 'export const partner = 7;\n';
    const root = await mkdtemp(path.join(tmpdir(), 'yg-fill-'));
    dirs.push(root);
    const yggRoot = path.join(root, '.yggdrasil');
    await mkdir(yggRoot, { recursive: true });
    await mkdir(path.join(root, 'src'), { recursive: true });
    await writeFile(path.join(yggRoot, 'yg-config.yaml'), V5_REVIEWER_CONFIG);
    await writeFile(
      path.join(yggRoot, 'yg-architecture.yaml'),
      'node_types:\n  service:\n    description: s\n    log_required: false\n    relations:\n      uses: [service]\n',
    );
    await mkdir(path.join(yggRoot, 'model', 'svc'), { recursive: true });
    await writeFile(path.join(root, 'src', 'svc.ts'), 'export const x = 1;\n');
    await writeFile(
      path.join(yggRoot, 'model', 'svc', 'yg-node.yaml'),
      'name: svc\ntype: service\ndescription: x\nmapping:\n  - src/svc.ts\nrelations:\n  - type: uses\n    target: partner\naspects:\n  - llm-c\n',
    );
    await mkdir(path.join(yggRoot, 'model', 'partner'), { recursive: true });
    await writeFile(path.join(root, 'src', 'partner.ts'), COMPANION_CONTENT);
    await writeFile(
      path.join(yggRoot, 'model', 'partner', 'yg-node.yaml'),
      'name: partner\ntype: service\ndescription: p\nmapping:\n  - src/partner.ts\n',
    );
    const aspDir = path.join(yggRoot, 'aspects', 'llm-c');
    await mkdir(aspDir, { recursive: true });
    await writeFile(path.join(aspDir, 'yg-aspect.yaml'), 'name: llm-c\ndescription: llm-c rule\nreviewer:\n  type: llm\nstatus: enforced\n');
    await writeFile(path.join(aspDir, 'content.md'), 'rule c\n');
    await writeFile(path.join(aspDir, 'companion.mjs'), 'export function companion() { return [{ path: "src/partner.ts" }]; }\n');

    const graph = await loadGraph(root);

    let reviewerCalls = 0;
    let promptSeen = '';
    mockCreateLlmProvider.mockReturnValue(makeMockProvider({
      async verifyAspect(prompt: string) {
        reviewerCalls++;
        promptSeen = prompt;
        return { satisfied: true, reason: 'ok', errorSource: 'codeViolation' as const };
      },
    }));

    const result = await runFill(graph, { gitTrackedFiles: null, write: () => {} });

    // Reviewer ran exactly once (consensus 1); the hook ran exactly once (no taint).
    expect(reviewerCalls).toBe(1);
    expect(mockRunCompanionHook).toHaveBeenCalledTimes(1);
    expect(result.reviewerCallsMade).toBe(1);

    // The companion content reached the reviewer prompt.
    expect(promptSeen).toContain('<companions>');
    expect(promptSeen).toContain(COMPANION_CONTENT.trim());

    const entry = readLock(graph.rootPath).verdicts['llm-c']?.['node:svc'];
    expect(entry?.verdict).toBe('approved');
    // touched carries the companion-read observation.
    expect(entry?.touched?.map(([k]) => k)).toContain('read:src/partner.ts');

    // The stored hash equals computeLlmInputHash with companionHash AND touched
    // folded — proving the producer threaded both into the hash.
    const aspect = graph.aspects.find((a) => a.id === 'llm-c')!;
    const svcBytes = await readFile(path.join(root, 'src', 'svc.ts'));
    const compBytes = await readFile(path.join(root, 'src', 'partner.ts'));
    const expectedHash = computeLlmInputHash({
      aspectId: 'llm-c',
      aspectDescription: aspect.description ?? '',
      scope: aspect.scope,
      nodePath: 'svc',
      ruleHash: ruleHashFor(aspect, 'content.md'),
      files: [['src/svc.ts', hashBytes(svcBytes)]],
      references: [],
      tier: tierHashViewFromTier('standard'),
      companionHash: companionHashFor(aspect),
      touched: [[observationKey('read', 'src/partner.ts'), hashReadObservation(compBytes)]],
      verdict: 'approved',
    });
    expect(entry?.hash).toBe(expectedHash);
    // companionHash actually exists (sanity: the aspect ships a companion).
    expect(companionHashFor(aspect)).toBeDefined();
  });

  it('[] companion → no touched, but companionHash still folds', async () => {
    const { projectRoot } = await setupProject({
      aspects: [{
        id: 'llm-empty',
        kind: 'llm',
        status: 'enforced',
        rule: 'rule',
        companion: 'export function companion() { return []; }\n',
      }],
    });
    const graph = await loadGraph(projectRoot);
    mockCreateLlmProvider.mockReturnValue(makeMockProvider());
    await runFill(graph, { gitTrackedFiles: null, write: () => {} });

    const entry = readLock(graph.rootPath).verdicts['llm-empty']?.['node:svc'];
    expect(entry?.verdict).toBe('approved');
    // A []-resolving companion records NO touched.
    expect(entry?.touched).toBeUndefined();

    // But companionHash STILL folds (presence is by artifact existence).
    const aspect = graph.aspects.find((a) => a.id === 'llm-empty')!;
    const svcBytes = await readFile(path.join(projectRoot, 'src', 'svc.ts'));
    const withCompanion = computeLlmInputHash({
      aspectId: 'llm-empty',
      aspectDescription: aspect.description ?? '',
      scope: aspect.scope,
      nodePath: 'svc',
      ruleHash: ruleHashFor(aspect, 'content.md'),
      files: [['src/svc.ts', hashBytes(svcBytes)]],
      references: [],
      tier: tierHashViewFromTier('standard'),
      companionHash: companionHashFor(aspect),
      verdict: 'approved',
    });
    const withoutCompanion = computeLlmInputHash({
      aspectId: 'llm-empty',
      aspectDescription: aspect.description ?? '',
      scope: aspect.scope,
      nodePath: 'svc',
      ruleHash: ruleHashFor(aspect, 'content.md'),
      files: [['src/svc.ts', hashBytes(svcBytes)]],
      references: [],
      tier: tierHashViewFromTier('standard'),
      verdict: 'approved',
    });
    // The stored hash matches the companion-folded form, NOT the plain form.
    expect(entry?.hash).toBe(withCompanion);
    expect(entry?.hash).not.toBe(withoutCompanion);
  });

  it('tainted on BOTH runs → 2 hook runs, 0 reviewer calls, infra (callsMade:0), no write', async () => {
    const { projectRoot } = await setupProject({
      aspects: [{
        id: 'llm-taint',
        kind: 'llm',
        status: 'enforced',
        rule: 'rule',
        companion: 'export function companion() { return []; }\n',
      }],
    });
    const graph = await loadGraph(projectRoot);

    // The companion hook ALWAYS returns a tainted observation set.
    const tainted: RunCompanionHookResult = {
      kind: 'ok',
      descriptors: [],
      touchedFiles: [],
      observations: [],
      observationsTainted: true,
    };
    mockRunCompanionHook.mockResolvedValue(tainted);

    let reviewerCalls = 0;
    mockCreateLlmProvider.mockReturnValue(makeMockProvider({
      async verifyAspect() { reviewerCalls++; return { satisfied: true, reason: 'ok', errorSource: 'codeViolation' as const }; },
    }));

    const result = await runFill(graph, { gitTrackedFiles: null, write: () => {} });

    // The hook ran exactly twice (initial + re-run-once); the reviewer never ran.
    expect(mockRunCompanionHook).toHaveBeenCalledTimes(2);
    expect(reviewerCalls).toBe(0);
    expect(result.reviewerCallsMade).toBe(0);
    // Infra disposition — counted, nothing written.
    expect(result.infraFailures).toBeGreaterThan(0);
    expect(readLock(graph.rootPath).verdicts['llm-taint']?.['node:svc']).toBeUndefined();
    expect(result.checkResult.issues.some((i) => i.code === 'unverified')).toBe(true);
  });

  it('tainted once then settles → verdict IS written (one re-run)', async () => {
    const { projectRoot } = await setupProject({
      aspects: [{
        id: 'llm-settle',
        kind: 'llm',
        status: 'enforced',
        rule: 'rule',
        companion: 'export function companion() { return []; }\n',
      }],
    });
    const graph = await loadGraph(projectRoot);

    const taintedOnce: RunCompanionHookResult = { kind: 'ok', descriptors: [], touchedFiles: [], observations: [], observationsTainted: true };
    const settled: RunCompanionHookResult = { kind: 'ok', descriptors: [], touchedFiles: [], observations: [], observationsTainted: false };
    mockRunCompanionHook
      .mockResolvedValueOnce(taintedOnce)
      .mockResolvedValueOnce(settled);

    let reviewerCalls = 0;
    mockCreateLlmProvider.mockReturnValue(makeMockProvider({
      async verifyAspect() { reviewerCalls++; return { satisfied: true, reason: 'ok', errorSource: 'codeViolation' as const }; },
    }));

    const result = await runFill(graph, { gitTrackedFiles: null, write: () => {} });

    expect(mockRunCompanionHook).toHaveBeenCalledTimes(2);
    expect(reviewerCalls).toBe(1);
    expect(result.reviewerCallsMade).toBe(1);
    expect(readLock(graph.rootPath).verdicts['llm-settle']?.['node:svc']?.verdict).toBe('approved');
  });

  it('hook throws (infra) → 0 reviewer calls, infra (callsMade:0), no write, message reaches the sink', async () => {
    const { projectRoot } = await setupProject({
      aspects: [{
        id: 'llm-throw',
        kind: 'llm',
        status: 'enforced',
        rule: 'rule',
        companion: 'export function companion() { throw new Error("boom"); }\n',
      }],
    });
    const graph = await loadGraph(projectRoot);

    let reviewerCalls = 0;
    mockCreateLlmProvider.mockReturnValue(makeMockProvider({
      async verifyAspect() { reviewerCalls++; return { satisfied: true, reason: 'ok', errorSource: 'codeViolation' as const }; },
    }));

    const w = makeWriter();
    const result = await runFill(graph, { gitTrackedFiles: null, write: w.write, emitIssue: w.emitIssue });

    expect(reviewerCalls).toBe(0);
    expect(result.reviewerCallsMade).toBe(0);
    expect(result.infraFailures).toBeGreaterThan(0);
    expect(readLock(graph.rootPath).verdicts['llm-throw']?.['node:svc']).toBeUndefined();
    // The companion message (carrying the hook throw) reaches the diagnostics sink.
    expect(w.text()).toMatch(/companion/i);
  });

  it('companion path missing on disk → infra (callsMade:0), no write', async () => {
    const { projectRoot } = await setupProject({
      aspects: [{
        id: 'llm-missing',
        kind: 'llm',
        status: 'enforced',
        rule: 'rule',
        // Returns an allowed-reads path (own mapping) that does NOT exist on disk.
        companion: 'export function companion() { return [{ path: "src/ghost.ts" }]; }\n',
      }],
      mapping: ['src/svc.ts', 'src/ghost.ts'],
      // src/ghost.ts is intentionally NOT created (mapping references a missing file).
    });
    const graph = await loadGraph(projectRoot);

    let reviewerCalls = 0;
    mockCreateLlmProvider.mockReturnValue(makeMockProvider({
      async verifyAspect() { reviewerCalls++; return { satisfied: true, reason: 'ok', errorSource: 'codeViolation' as const }; },
    }));

    const result = await runFill(graph, { gitTrackedFiles: null, write: () => {} });

    expect(reviewerCalls).toBe(0);
    expect(result.reviewerCallsMade).toBe(0);
    expect(result.infraFailures).toBeGreaterThan(0);
    expect(readLock(graph.rootPath).verdicts['llm-missing']?.['node:svc']).toBeUndefined();
  });

  it('companion path outside allowed-reads → infra (callsMade:0), NEXT names node as relation source', async () => {
    // The companion returns a path owned by an UNRELATED node (no relation declared
    // from svc to it) — outside svc's allowed-reads. fill-llm must fail closed and
    // the NEXT must frame svc as the relation SOURCE and the owner as the TARGET.
    const root = await mkdtemp(path.join(tmpdir(), 'yg-fill-'));
    dirs.push(root);
    const yggRoot = path.join(root, '.yggdrasil');
    await mkdir(yggRoot, { recursive: true });
    await mkdir(path.join(root, 'src'), { recursive: true });
    await writeFile(path.join(yggRoot, 'yg-config.yaml'), V5_REVIEWER_CONFIG);
    await writeFile(
      path.join(yggRoot, 'yg-architecture.yaml'),
      'node_types:\n  service:\n    description: s\n    log_required: false\n',
    );
    // svc node — carries the companion aspect, maps only src/svc.ts.
    await mkdir(path.join(yggRoot, 'model', 'svc'), { recursive: true });
    await writeFile(path.join(root, 'src', 'svc.ts'), 'export const x = 1;\n');
    await writeFile(
      path.join(yggRoot, 'model', 'svc', 'yg-node.yaml'),
      'name: svc\ntype: service\ndescription: x\nmapping:\n  - src/svc.ts\naspects:\n  - llm-out\n',
    );
    // other node — owns src/other.ts; svc declares NO relation to it.
    await mkdir(path.join(yggRoot, 'model', 'other'), { recursive: true });
    await writeFile(path.join(root, 'src', 'other.ts'), 'export const o = 9;\n');
    await writeFile(
      path.join(yggRoot, 'model', 'other', 'yg-node.yaml'),
      'name: other\ntype: service\ndescription: y\nmapping:\n  - src/other.ts\n',
    );
    // Aspect llm-out — companion returns src/other.ts (outside svc allowed-reads).
    const aspDir = path.join(yggRoot, 'aspects', 'llm-out');
    await mkdir(aspDir, { recursive: true });
    await writeFile(path.join(aspDir, 'yg-aspect.yaml'), 'name: llm-out\ndescription: out rule\nreviewer:\n  type: llm\nstatus: enforced\n');
    await writeFile(path.join(aspDir, 'content.md'), 'rule\n');
    await writeFile(path.join(aspDir, 'companion.mjs'), 'export function companion() { return [{ path: "src/other.ts" }]; }\n');

    const graph = await loadGraph(root);
    let reviewerCalls = 0;
    mockCreateLlmProvider.mockReturnValue(makeMockProvider({
      async verifyAspect() { reviewerCalls++; return { satisfied: true, reason: 'ok', errorSource: 'codeViolation' as const }; },
    }));

    const w = makeWriter();
    const result = await runFill(graph, { gitTrackedFiles: null, write: w.write, emitIssue: w.emitIssue });

    expect(reviewerCalls).toBe(0);
    expect(result.reviewerCallsMade).toBe(0);
    expect(result.infraFailures).toBeGreaterThan(0);
    expect(readLock(graph.rootPath).verdicts['llm-out']?.['node:svc']).toBeUndefined();
    // The NEXT frames svc as the relation SOURCE and other (the owner) as TARGET —
    // and NEVER interpolates the .md/unit as the relation site.
    expect(w.text()).toContain('declare a relation from svc to other');
    expect(w.text()).toContain('.yggdrasil/model/svc/yg-node.yaml');
  });

  it('bad shape (non-array return) → infra (callsMade:0), no write', async () => {
    const { projectRoot } = await setupProject({
      aspects: [{
        id: 'llm-badshape',
        kind: 'llm',
        status: 'enforced',
        rule: 'rule',
        companion: 'export function companion() { return "oops"; }\n',
      }],
    });
    const graph = await loadGraph(projectRoot);
    let reviewerCalls = 0;
    mockCreateLlmProvider.mockReturnValue(makeMockProvider({
      async verifyAspect() { reviewerCalls++; return { satisfied: true, reason: 'ok', errorSource: 'codeViolation' as const }; },
    }));
    const result = await runFill(graph, { gitTrackedFiles: null, write: () => {} });
    expect(reviewerCalls).toBe(0);
    expect(result.reviewerCallsMade).toBe(0);
    expect(result.infraFailures).toBeGreaterThan(0);
    expect(readLock(graph.rootPath).verdicts['llm-badshape']?.['node:svc']).toBeUndefined();
  });

  it('a companion path equal to a subject is dropped (no inject, no touched)', async () => {
    // per:node aspect; companion returns the subject file itself. It must be
    // dropped (already a subject) — NOT injected as a companion, NOT recorded.
    const { projectRoot } = await setupProject({
      aspects: [{
        id: 'llm-self',
        kind: 'llm',
        status: 'enforced',
        rule: 'rule',
        companion: 'export function companion() { return [{ path: "src/svc.ts" }]; }\n',
      }],
    });
    const graph = await loadGraph(projectRoot);
    let promptSeen = '';
    mockCreateLlmProvider.mockReturnValue(makeMockProvider({
      async verifyAspect(prompt: string) { promptSeen = prompt; return { satisfied: true, reason: 'ok', errorSource: 'codeViolation' as const }; },
    }));
    await runFill(graph, { gitTrackedFiles: null, write: () => {} });

    const entry = readLock(graph.rootPath).verdicts['llm-self']?.['node:svc'];
    expect(entry?.verdict).toBe('approved');
    // The subject was dropped → no companion block, no touched entry for it.
    expect(promptSeen).not.toContain('<companions>');
    expect(entry?.touched).toBeUndefined();
    // The hash still folds companionHash (the aspect ships a companion).
    const aspect = graph.aspects.find((a) => a.id === 'llm-self')!;
    const svcBytes = await readFile(path.join(projectRoot, 'src', 'svc.ts'));
    const expectedHash = computeLlmInputHash({
      aspectId: 'llm-self',
      aspectDescription: aspect.description ?? '',
      scope: aspect.scope,
      nodePath: 'svc',
      ruleHash: ruleHashFor(aspect, 'content.md'),
      files: [['src/svc.ts', hashBytes(svcBytes)]],
      references: [],
      tier: tierHashViewFromTier('standard'),
      companionHash: companionHashFor(aspect),
      verdict: 'approved',
    });
    expect(entry?.hash).toBe(expectedHash);
  });

  it('plain LLM aspect (no companion) — hook is never run and the hash is companion-free', async () => {
    const { projectRoot } = await setupProject({
      aspects: [{ id: 'llm-plain', kind: 'llm', status: 'enforced', rule: 'rule a' }],
    });
    const graph = await loadGraph(projectRoot);
    mockCreateLlmProvider.mockReturnValue(makeMockProvider());
    await runFill(graph, { gitTrackedFiles: null, write: () => {} });

    // The companion hook was NEVER invoked for a plain aspect (byte-identical path).
    expect(mockRunCompanionHook).not.toHaveBeenCalled();

    const entry = readLock(graph.rootPath).verdicts['llm-plain']?.['node:svc'];
    expect(entry?.verdict).toBe('approved');
    expect(entry?.touched).toBeUndefined();
    // The stored hash is the plain (companion-free) form.
    const aspect = graph.aspects.find((a) => a.id === 'llm-plain')!;
    const svcBytes = await readFile(path.join(projectRoot, 'src', 'svc.ts'));
    const plainHash = computeLlmInputHash({
      aspectId: 'llm-plain',
      aspectDescription: aspect.description ?? '',
      scope: aspect.scope,
      nodePath: 'svc',
      ruleHash: ruleHashFor(aspect, 'content.md'),
      files: [['src/svc.ts', hashBytes(svcBytes)]],
      references: [],
      tier: tierHashViewFromTier('standard'),
      verdict: 'approved',
    });
    expect(entry?.hash).toBe(plainHash);
    expect(companionHashFor(aspect)).toBeUndefined();
  });
});
