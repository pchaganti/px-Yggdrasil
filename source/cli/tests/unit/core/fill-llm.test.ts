/**
 * Unit tests for the `yg check --approve` fill stage (core/fill.ts, spec §7).
 * LLM-focused tests: LLM fills, consensus, infra failures, FillGatingError (structural abort),
 * cached refusals, header/summary exact strings.
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
import { runFill, FillGatingError } from '../../../src/core/fill.js';
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
// 1. Pre-dispatch header + zero-calls summary — EXACT strings
// =============================================================================

describe('header + summary strings (exact)', () => {
  it('prints the exact pre-dispatch header', async () => {
    const { projectRoot } = await setupProject({
      aspects: [
        { id: 'det-a', kind: 'deterministic', status: 'enforced', rule: DET_PASS },
        { id: 'llm-a', kind: 'llm', status: 'enforced', rule: 'rule a' },
      ],
    });
    const graph = await loadGraph(projectRoot);
    mockCreateLlmProvider.mockReturnValue(makeMockProvider());
    const w = makeWriter();
    await runFill(graph, { gitTrackedFiles: null, write: w.write });
    expect(w.text()).toContain(
      'Filling 2 unverified pairs across 1 nodes — 1 deterministic (no cost), 1 reviewer calls (consensus included)',
    );
  });

  it('prints the exact zero-calls summary when nothing is unverified', async () => {
    const { projectRoot } = await setupProject({
      aspects: [{ id: 'det-a', kind: 'deterministic', status: 'enforced', rule: DET_PASS }],
    });
    let graph = await loadGraph(projectRoot);
    // First fill records the verdict.
    await runFill(graph, { gitTrackedFiles: null, write: () => {} });
    // Second fill: nothing unverified.
    graph = await loadGraph(projectRoot);
    const w = makeWriter();
    await runFill(graph, { gitTrackedFiles: null, write: w.write });
    expect(w.text()).toContain('0 reviewer calls made — all expected pairs hold valid verdicts');
  });
});

// =============================================================================
// 3. Cached refusal → second run = 0 reviewer calls; re-renders
// =============================================================================

describe('cached refusal', () => {
  it('a cached LLM refusal makes 0 reviewer calls on the second run', async () => {
    const { projectRoot } = await setupProject({
      aspects: [{ id: 'llm-a', kind: 'llm', status: 'enforced', rule: 'rule a' }],
    });
    let graph = await loadGraph(projectRoot);
    let calls = 0;
    mockCreateLlmProvider.mockReturnValue(makeMockProvider({
      async verifyAspect() { calls++; return { satisfied: false, reason: 'nope', errorSource: 'codeViolation' as const }; },
    }));
    await runFill(graph, { gitTrackedFiles: null, write: () => {} });
    expect(calls).toBe(1);
    const lock1 = readLock(graph.rootPath);
    expect(lock1.verdicts['llm-a']?.['node:svc']?.verdict).toBe('refused');

    // Second run: same inputs → cached, no reviewer call.
    graph = await loadGraph(projectRoot);
    calls = 0;
    mockCreateLlmProvider.mockReturnValue(makeMockProvider({
      async verifyAspect() { calls++; return { satisfied: true, reason: 'ok', errorSource: 'codeViolation' as const }; },
    }));
    const result = await runFill(graph, { gitTrackedFiles: null, write: () => {} });
    expect(calls).toBe(0);
    expect(result.reviewerCallsMade).toBe(0);
    // The cached refusal still renders (check report still errors).
    expect(result.checkResult.issues.some((i) => i.code === 'aspect-violation-enforced')).toBe(true);
  });
});

// =============================================================================
// 4. Infra no-write leaves the pair unverified + prior valid entries intact
// =============================================================================

describe('infra fail-closed', () => {
  it('provider unreachable → no write; a prior valid det entry stays intact', async () => {
    const { projectRoot } = await setupProject({
      aspects: [
        { id: 'det-a', kind: 'deterministic', status: 'enforced', rule: DET_PASS },
        { id: 'llm-a', kind: 'llm', status: 'enforced', rule: 'rule a' },
      ],
    });
    const graph = await loadGraph(projectRoot);
    mockCreateLlmProvider.mockReturnValue(makeMockProvider({ isAvailable: async () => false }));
    const w = makeWriter();
    const result = await runFill(graph, { gitTrackedFiles: null, write: w.write });

    const lock = readLock(graph.rootPath);
    // The free det pair was filled (it does not need the provider).
    expect(lock.verdicts['det-a']?.['node:svc']?.verdict).toBe('approved');
    // The LLM pair was NOT written (provider down).
    expect(lock.verdicts['llm-a']?.['node:svc']).toBeUndefined();
    expect(result.infraFailures).toBeGreaterThan(0);
    expect(w.text()).toContain('pairs failed on provider/config errors');
    // The unverified LLM pair stays red on the report.
    expect(result.checkResult.issues.some((i) => i.code === 'unverified')).toBe(true);
  });

  it('a missing reference is a LOUD infra failure (no write)', async () => {
    const { projectRoot } = await setupProject({
      aspects: [{ id: 'llm-ref', kind: 'llm', status: 'enforced', rule: 'rule', references: [{ path: 'refs/missing.md' }] }],
      // refs/missing.md is intentionally NOT created.
    });
    const graph = await loadGraph(projectRoot);
    let calls = 0;
    mockCreateLlmProvider.mockReturnValue(makeMockProvider({
      async verifyAspect() { calls++; return { satisfied: true, reason: 'ok', errorSource: 'codeViolation' as const }; },
    }));
    const result = await runFill(graph, { gitTrackedFiles: null, write: () => {} });

    // The reviewer must never be called — the reference is missing.
    expect(calls).toBe(0);
    expect(result.infraFailures).toBeGreaterThan(0);
    const lock = readLock(graph.rootPath);
    expect(lock.verdicts['llm-ref']?.['node:svc']).toBeUndefined();
  });
});

// =============================================================================
// 11. Side-fix B3: runtime-error run does NOT print the zero-calls summary line
// =============================================================================

describe('zero-calls summary gated on runtimeErrors === 0 (side-fix B3)', () => {
  it('a run with det runtime errors does NOT print the zero-calls summary', async () => {
    // A check.mjs that throws — a runtime error, not a violation verdict.
    const CRASHING_CHECK = 'export function check() { throw new Error("kaboom"); }\n';
    const { projectRoot } = await setupProject({
      aspects: [{ id: 'det-crash', kind: 'deterministic', status: 'enforced', rule: CRASHING_CHECK }],
    });
    const graph = await loadGraph(projectRoot);
    // No LLM provider needed — this run is all deterministic.
    mockCreateLlmProvider.mockReturnValue(makeMockProvider());
    const w = makeWriter();
    const result = await runFill(graph, { gitTrackedFiles: null, write: w.write });
    // The check crashed → runtime error (no write, no reviewer call).
    expect(result.runtimeErrors).toBeGreaterThan(0);
    expect(result.reviewerCallsMade).toBe(0);
    // The zero-calls summary MUST NOT appear when there was a runtime error.
    expect(w.text()).not.toContain('0 reviewer calls made — all expected pairs hold valid verdicts');
  });
});

// =============================================================================
// 12b. Consensus: 3 — refuse/approve/approve → majority approves; 3 calls made
// =============================================================================

describe('consensus=3 majority-approve', () => {
  it('refuse/approve/approve votes → entry written approved, reviewerCallsMade=3, header shows 3 calls', async () => {
    const configConsensus3 =
      'reviewer:\n  tiers:\n    standard:\n      provider: ollama\n      consensus: 3\n      config:\n        model: llama3\n        temperature: 0\n';
    const { projectRoot } = await setupProject({
      aspects: [{ id: 'llm-a', kind: 'llm', status: 'enforced', rule: 'rule a' }],
      configYaml: configConsensus3,
    });
    const graph = await loadGraph(projectRoot);

    // Per-call sequence: refused first, then approved twice → majority (2/3) approves.
    let callIndex = 0;
    const responses = [
      { satisfied: false, reason: 'nope', errorSource: 'codeViolation' as const },
      { satisfied: true, reason: 'ok', errorSource: 'codeViolation' as const },
      { satisfied: true, reason: 'ok', errorSource: 'codeViolation' as const },
    ];
    mockCreateLlmProvider.mockReturnValue(makeMockProvider({
      async verifyAspect() { return responses[callIndex++]!; },
    }));

    const w = makeWriter();
    const result = await runFill(graph, { gitTrackedFiles: null, write: w.write });

    // Header must show 3 reviewer calls (consensus included).
    expect(w.text()).toContain('3 reviewer calls (consensus included)');

    // The verdict entry must be approved (majority).
    const lock = readLock(graph.rootPath);
    expect(lock.verdicts['llm-a']?.['node:svc']?.verdict).toBe('approved');

    // reviewerCallsMade reflects 3 actual provider calls.
    expect(result.reviewerCallsMade).toBe(3);
  });
});

// =============================================================================
// 13. Structural abort — gating code aborts fill before any runner/provider call
// =============================================================================

describe('structural abort — FillGatingError', () => {
  it('a gating config error throws FillGatingError with zero runner and provider invocations', async () => {
    // Trigger aspect-tier-on-deterministic: a det aspect with reviewer.tier set.
    // This is a member of APPROVE_GATING_CODES so the fill stage aborts immediately
    // in step 1, before any pair is dispatched.
    const { projectRoot } = await setupProject({
      aspects: [{ id: 'det-a', kind: 'deterministic', status: 'enforced', rule: DET_PASS }],
    });
    // Overwrite the aspect YAML to add tier: — triggers aspect-tier-on-deterministic.
    await writeFile(
      path.join(projectRoot, '.yggdrasil', 'aspects', 'det-a', 'yg-aspect.yaml'),
      'name: det-a\ndescription: det-a rule\nreviewer:\n  type: deterministic\n  tier: standard\nstatus: enforced\n',
    );
    const graph = await loadGraph(projectRoot);

    let providerCalls = 0;
    mockCreateLlmProvider.mockReturnValue(makeMockProvider({
      async verifyAspect() {
        providerCalls++;
        return { satisfied: true, reason: 'ok', errorSource: 'codeViolation' as const };
      },
    }));
    // Track runner calls independently (default passthrough is suppressed so we
    // can count cleanly; this test aborts before any runner call anyway).
    let runnerCallCount = 0;
    const real = structureRunnerRealFn!;
    mockRunStructureAspect.mockImplementation(async (...args) => {
      runnerCallCount++;
      return real(...args);
    });

    // The fill must throw FillGatingError — zero fills dispatched.
    await expect(
      runFill(graph, { gitTrackedFiles: null, write: () => {} }),
    ).rejects.toBeInstanceOf(FillGatingError);

    expect(runnerCallCount).toBe(0);
    expect(providerCalls).toBe(0);
  });
});

// =============================================================================
// 14. Fail-closed edge branches — provider-error verdict, reviewer throw,
//     LLM-specific infra errors, isAvailable throw, no-reviewer tier failure,
//     mapping-less closure.
// =============================================================================

describe('fill — fail-closed edge branches', () => {
  it('a provider-sourced refusal (errorSource: provider) is infra → NO write', async () => {
    const { projectRoot } = await setupProject({
      aspects: [{ id: 'llm-a', kind: 'llm', status: 'enforced', rule: 'rule a' }],
    });
    const graph = await loadGraph(projectRoot);
    mockCreateLlmProvider.mockReturnValue(makeMockProvider({
      // satisfied=false BUT the failure is a provider error, not a code violation.
      async verifyAspect() { return { satisfied: false, reason: 'rate limited', errorSource: 'provider' as const }; },
    }));
    const w = makeWriter();
    const result = await runFill(graph, { gitTrackedFiles: null, write: w.write });

    // No verdict written — a provider error never becomes a `refused` verdict.
    expect(readLock(graph.rootPath).verdicts['llm-a']?.['node:svc']).toBeUndefined();
    expect(result.infraFailures).toBeGreaterThan(0);
    expect(w.text()).toContain('pairs failed on provider/config errors');
  });

  it('a reviewer THROW is infra → NO write', async () => {
    const { projectRoot } = await setupProject({
      aspects: [{ id: 'llm-a', kind: 'llm', status: 'enforced', rule: 'rule a' }],
    });
    const graph = await loadGraph(projectRoot);
    mockCreateLlmProvider.mockReturnValue(makeMockProvider({
      async verifyAspect() { throw new Error('socket hang up'); },
    }));
    const result = await runFill(graph, { gitTrackedFiles: null, write: () => {} });
    expect(readLock(graph.rootPath).verdicts['llm-a']?.['node:svc']).toBeUndefined();
    expect(result.infraFailures).toBeGreaterThan(0);
  });

  it('provider.isAvailable THROWING is treated as unreachable → infra, no write', async () => {
    const { projectRoot } = await setupProject({
      aspects: [{ id: 'llm-a', kind: 'llm', status: 'enforced', rule: 'rule a' }],
    });
    const graph = await loadGraph(projectRoot);
    mockCreateLlmProvider.mockReturnValue(makeMockProvider({
      async isAvailable() { throw new Error('dns failure'); },
    }));
    const w = makeWriter();
    const result = await runFill(graph, { gitTrackedFiles: null, write: w.write });
    expect(readLock(graph.rootPath).verdicts['llm-a']?.['node:svc']).toBeUndefined();
    expect(result.infraFailures).toBeGreaterThan(0);
    expect(w.text()).toContain('is unreachable');
  });

  it('an LLM aspect with NO reviewer configured aborts the fill (gating) — nothing written', async () => {
    // A config with NO reviewer block at all is a gating config error
    // (config-reviewer-missing ∈ APPROVE_GATING_CODES): the whole fill aborts in
    // step 1 with a FillGatingError BEFORE any pair is dispatched, and the gating
    // details are written to the sink first.
    const { projectRoot } = await setupProject({
      aspects: [{ id: 'llm-a', kind: 'llm', status: 'enforced', rule: 'rule a' }],
      configYaml: 'quality:\n  max_direct_relations: 10\n',
    });
    const graph = await loadGraph(projectRoot);
    const w = makeWriter();
    await expect(runFill(graph, { gitTrackedFiles: null, write: w.write })).rejects.toBeInstanceOf(FillGatingError);
    expect(w.text()).toContain('aborted — configuration errors block tier resolution');
    // No lock verdict was written.
    let lockHasEntry: boolean;
    try { lockHasEntry = readLock(graph.rootPath).verdicts['llm-a']?.['node:svc'] !== undefined; } catch { lockHasEntry = false; }
    expect(lockHasEntry).toBe(false);
  });

  it('a det check returning succeeded:false is a runtime error → no write, runtimeErrors counted', async () => {
    const { projectRoot } = await setupProject({
      aspects: [{ id: 'det-a', kind: 'deterministic', status: 'enforced', rule: DET_PASS }],
    });
    const graph = await loadGraph(projectRoot);
    mockRunStructureAspect.mockImplementation(async (): Promise<RunStructureAspectResult> => ({
      violations: [{ message: 'check crashed' }],
      touchedFiles: [],
      succeeded: false,
      observations: [],
      observationsTainted: false,
    }));
    const w = makeWriter();
    const result = await runFill(graph, { gitTrackedFiles: null, write: w.write });
    expect(readLock(graph.rootPath).verdicts['det-a']?.['node:svc']).toBeUndefined();
    expect(result.runtimeErrors).toBeGreaterThan(0);
    expect(w.text()).toContain('aspect-check-runtime-error');
  });

  it('a det check tainted on BOTH runs fails closed (runtime error, no write)', async () => {
    const { projectRoot } = await setupProject({
      aspects: [{ id: 'det-a', kind: 'deterministic', status: 'enforced', rule: DET_PASS }],
    });
    const graph = await loadGraph(projectRoot);
    // Always tainted → re-run once, still tainted → runtime error.
    mockRunStructureAspect.mockImplementation(async (): Promise<RunStructureAspectResult> => ({
      violations: [],
      touchedFiles: [],
      succeeded: true,
      observations: [],
      observationsTainted: true,
    }));
    const w = makeWriter();
    const result = await runFill(graph, { gitTrackedFiles: null, write: w.write });
    expect(readLock(graph.rootPath).verdicts['det-a']?.['node:svc']).toBeUndefined();
    expect(result.runtimeErrors).toBeGreaterThan(0);
    expect(w.text()).toContain('aspect-check-runtime-error');
  });

  it('a det refusal records a reason with the violation file:line rendered', async () => {
    const { projectRoot } = await setupProject({
      aspects: [{ id: 'det-a', kind: 'deterministic', status: 'enforced', rule: DET_FAIL }],
    });
    const graph = await loadGraph(projectRoot);
    await runFill(graph, { gitTrackedFiles: null, write: () => {} });
    const entry = readLock(graph.rootPath).verdicts['det-a']?.['node:svc'];
    expect(entry?.verdict).toBe('refused');
    // DET_FAIL reports { message: 'bad', file: 'src/svc.ts', line: 1 } → "src/svc.ts:1: bad".
    expect(entry?.reason).toContain('src/svc.ts:1: bad');
  });

  it('the infra summary names the provider and tier when an LLM pair fails on infra', async () => {
    const { projectRoot } = await setupProject({
      aspects: [{ id: 'llm-a', kind: 'llm', status: 'enforced', rule: 'rule a' }],
    });
    const graph = await loadGraph(projectRoot);
    mockCreateLlmProvider.mockReturnValue(makeMockProvider({ isAvailable: async () => false }));
    const w = makeWriter();
    await runFill(graph, { gitTrackedFiles: null, write: w.write });
    // The summary's parenthetical id carries the provider / tier.
    expect(w.text()).toContain('ollama');
    expect(w.text()).toContain('standard');
  });

  it('a mapping-less node records only the log baseline at closure (no source fingerprint)', async () => {
    // A node with an empty mapping has no source fingerprint; closure still records
    // its log baseline when a log.md exists.
    const { projectRoot } = await setupProject({
      aspects: [{ id: 'det-a', kind: 'deterministic', status: 'enforced', rule: DET_PASS }],
      mapping: [],
      logContent: '## [2026-05-11T10:00:00.000Z]\nfirst.\n',
    });
    const graph = await loadGraph(projectRoot);
    await runFill(graph, { gitTrackedFiles: null, write: () => {} });
    const nodeEntry = readLock(graph.rootPath).nodes['svc'];
    // No source fingerprint (mapping-less), but the log baseline is recorded.
    expect(nodeEntry?.source).toBeUndefined();
    expect(nodeEntry?.log?.last_entry_datetime).toBe('2026-05-11T10:00:00.000Z');
  });
});
