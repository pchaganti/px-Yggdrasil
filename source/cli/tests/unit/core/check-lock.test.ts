/**
 * runCheck-level tests for the verdict-lock live path (spec §6).
 *
 * These wire a fixture graph + on-disk lock through the NEW pipeline and assert
 * the emitted issue CODES and SEVERITIES. They live beside the legacy check
 * tests without modifying them (the old drift tests fail once B4 deletes their
 * subjects — left for B8).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { Graph, GraphNode, AspectDef, LlmConfig, AspectStatus } from '../../../src/model/graph.js';
import type { LockFile } from '../../../src/model/lock.js';
import { nodeUnit, LOCK_FORMAT_VERSION } from '../../../src/model/lock.js';
import { runCheck } from '../../../src/core/check.js';
import { writeLock } from '../../../src/io/lock-store.js';
import { writeSeededLock } from '../helpers/seed-lock.js';

let tmpDir: string;
beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'yg-check-lock-'));
});
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

const TIER: LlmConfig = { provider: 'ollama', model: 'test', temperature: 0, consensus: 1 };

function writeFile(relPath: string, content: string): void {
  const abs = path.join(tmpDir, relPath);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf-8');
}

function buildGraph(
  aspectStatus: AspectStatus,
  ruleContent = 'rule',
  tier: LlmConfig = TIER,
): Graph {
  const rootPath = path.join(tmpDir, '.yggdrasil');
  mkdirSync(rootPath, { recursive: true });
  const aspect: AspectDef = {
    id: 'asp', name: 'asp', reviewer: { type: 'llm' }, status: aspectStatus,
    artifacts: [{ filename: 'content.md', content: ruleContent }],
  } as AspectDef;
  const node: GraphNode = {
    path: 'svc',
    meta: { name: 'svc', type: 'service', aspects: ['asp'], mapping: ['src/a.ts'] },
    children: [], parent: null,
  } as GraphNode;
  return {
    config: { version: '5.0.0', reviewer: { tiers: { default: tier }, default: 'default' } },
    architecture: { node_types: { service: { description: 'test' } } },
    nodes: new Map([['svc', node]]),
    aspects: [aspect],
    flows: [], schemas: [], rootPath,
  } as unknown as Graph;
}

/**
 * Write the subject file, seed a valid verdict entry for asp/node:svc through the
 * shared seed-lock helper (real frozen-contract fold), then run the check.
 * `verdict: null` writes an EMPTY lock (the unverified / prompt-too-large cases).
 */
async function seedAndCheck(
  graph: Graph,
  verdict: { verdict: 'approved' | 'refused'; reason?: string } | null,
) {
  writeFile('src/a.ts', 'code');
  if (verdict === null) {
    const lock: LockFile = { version: LOCK_FORMAT_VERSION, verdicts: {}, nodes: {} };
    const deterministicAspectIds = new Set(
      graph.aspects.filter((a) => a.reviewer.type === 'deterministic').map((a) => a.id),
    );
    await writeLock(graph.rootPath, lock, { scope: 'all', deterministicAspectIds });
  } else {
    await writeSeededLock(graph, {
      verdicts: [{ aspectId: 'asp', unitKey: nodeUnit('svc'), verdict: verdict.verdict, reason: verdict.reason }],
    });
  }
  return runCheck(graph, null); // null git files → skip coverage
}

describe('runCheck — verdict-lock issue emission', () => {
  it('missing entry on enforced aspect → unverified error', async () => {
    const graph = buildGraph('enforced');
    const result = await seedAndCheck(graph, null);
    const issue = result.issues.find((i) => i.code === 'unverified');
    expect(issue).toBeDefined();
    expect(issue!.severity).toBe('error');
    expect(result.suggestedNext).toBe('yg check --approve');
  });

  it('missing entry on advisory aspect → unverified WARNING (never blocks)', async () => {
    const graph = buildGraph('advisory');
    const result = await seedAndCheck(graph, null);
    const issue = result.issues.find((i) => i.code === 'unverified');
    expect(issue).toBeDefined();
    expect(issue!.severity).toBe('warning');
    // The advisory unverified must NOT be promoted to an error (only an enforced
    // unverified blocks). Other structural validator codes from this minimal
    // fixture are out of scope here — we assert the lock pair's severity only.
    const lockErrors = result.issues.filter(
      (i) => i.severity === 'error' && (i.code === 'unverified' || i.code === 'aspect-violation-enforced'),
    );
    expect(lockErrors).toHaveLength(0);
  });

  it('valid approved entry → no issue', async () => {
    const graph = buildGraph('enforced');
    const result = await seedAndCheck(graph, { verdict: 'approved' });
    expect(result.issues.some((i) => i.code === 'unverified' || i.code === 'aspect-violation-enforced')).toBe(false);
  });

  it('valid refused entry on enforced aspect → aspect-violation-enforced error with cached marker', async () => {
    const graph = buildGraph('enforced');
    const result = await seedAndCheck(graph, { verdict: 'refused', reason: 'broke the rule' });
    const issue = result.issues.find((i) => i.code === 'aspect-violation-enforced');
    expect(issue).toBeDefined();
    expect(issue!.severity).toBe('error');
    expect(issue!.messageData.what).toContain('cached verdict — the reviewer did NOT re-run');
  });

  it('valid refused entry on advisory aspect → aspect-violation-advisory warning', async () => {
    const graph = buildGraph('advisory');
    const result = await seedAndCheck(graph, { verdict: 'refused', reason: 'broke the rule' });
    const issue = result.issues.find((i) => i.code === 'aspect-violation-advisory');
    expect(issue).toBeDefined();
    expect(issue!.severity).toBe('warning');
    expect(result.advisoryWarnings).toBe(1);
    // An advisory refusal never produces a lock error (it is a warning).
    const lockErrors = result.issues.filter(
      (i) => i.severity === 'error' && (i.code === 'aspect-violation-enforced' || i.code === 'unverified'),
    );
    expect(lockErrors).toHaveLength(0);
  });

  it('prompt-too-large → error, takes precedence over unverified (no duplicate)', async () => {
    const tier: LlmConfig = { ...TIER, max_prompt_chars: 30 };
    const graph = buildGraph('enforced', 'a long rule that overflows the tiny char limit', tier);
    const result = await seedAndCheck(graph, null); // no entry
    expect(result.issues.filter((i) => i.code === 'prompt-too-large')).toHaveLength(1);
    expect(result.issues.some((i) => i.code === 'unverified')).toBe(false);
    expect(result.issues.find((i) => i.code === 'prompt-too-large')!.severity).toBe('error');
  });

  it('garbled lock → single lock-invalid error, fail closed (no pair issues)', async () => {
    writeFile('src/a.ts', 'code');
    const graph = buildGraph('enforced');
    mkdirSync(graph.rootPath, { recursive: true });
    // Write the garbled content to a committed file readLock actually reads (the
    // nondeterministic LLM-verdict file); the legacy single yg-lock.json is no
    // longer read by the runtime under the 5.1.0 triad.
    writeFileSync(path.join(graph.rootPath, 'yg-lock.nondeterministic.json'), '{ not valid json', 'utf-8');
    const result = await runCheck(graph, null);
    expect(result.issues.filter((i) => i.code === 'lock-invalid')).toHaveLength(1);
    expect(result.issues.some((i) => i.code === 'unverified')).toBe(false);
    expect(result.suggestedNext).toContain('git checkout');
  });
});

// ── Deterministic refusal rendering + log integrity / format branches ─────────

/** A graph with a single deterministic aspect on node `svc`. */
function buildDetGraph(status: AspectStatus, checkContent = 'export function check(){return [];}\n'): Graph {
  const rootPath = path.join(tmpDir, '.yggdrasil');
  mkdirSync(rootPath, { recursive: true });
  const aspect = {
    id: 'det', name: 'det', reviewer: { type: 'deterministic' }, status,
    artifacts: [{ filename: 'check.mjs', content: checkContent }],
  } as unknown as AspectDef;
  const node = {
    path: 'svc',
    meta: { name: 'svc', type: 'service', aspects: ['det'], mapping: ['src/a.ts'] },
    children: [], parent: null,
  } as GraphNode;
  return {
    config: { version: '5.0.0', reviewer: { tiers: { default: TIER }, default: 'default' } },
    architecture: { node_types: { service: { description: 'test', log_required: true } } },
    nodes: new Map([['svc', node]]),
    aspects: [aspect],
    flows: [], schemas: [], rootPath,
  } as unknown as Graph;
}

describe('runCheck — deterministic refusal + log integrity/format', () => {
  it('a valid REFUSED deterministic entry renders aspect-violation-enforced with the det message', async () => {
    writeFile('src/a.ts', 'code');
    const graph = buildDetGraph('enforced');
    await writeSeededLock(graph, {
      verdicts: [{ aspectId: 'det', unitKey: nodeUnit('svc'), verdict: 'refused', reason: 'src/a.ts:1: bad thing' }],
    });
    const result = await runCheck(graph, null);
    const issue = result.issues.find((i) => i.code === 'aspect-violation-enforced');
    expect(issue).toBeDefined();
    // The deterministic message (not the LLM cached-verdict marker) renders.
    expect(issue!.messageData.what).toContain('by a deterministic check');
    expect(issue!.messageData.what).toContain('src/a.ts:1: bad thing');
  });

  it('a tampered log (prefix_modified) → log-integrity error', async () => {
    writeFile('src/a.ts', 'code');
    // A well-formed log whose baseline we seed, then mutate the historical content.
    writeFile('.yggdrasil/model/svc/log.md', '## [2026-05-11T10:00:00.000Z]\noriginal reason.\n');
    const graph = buildDetGraph('enforced');
    await writeSeededLock(graph, {
      verdicts: [{ aspectId: 'det', unitKey: nodeUnit('svc'), verdict: 'approved' }],
      nodes: { svc: { log: true, source: true } },
    });
    // Now rewrite the historical (pre-baseline) entry → prefix hash no longer matches.
    writeFile('.yggdrasil/model/svc/log.md', '## [2026-05-11T10:00:00.000Z]\nTAMPERED reason.\n');
    const result = await runCheck(graph, null);
    const issue = result.issues.find((i) => i.code === 'log-integrity');
    expect(issue).toBeDefined();
    expect(issue!.severity).toBe('error');
  });

  it('a malformed log (bad format) → log-format error', async () => {
    writeFile('src/a.ts', 'code');
    // No baseline in the lock → integrity check is skipped, but the format
    // validator still runs and flags the malformed entry header.
    writeFile('.yggdrasil/model/svc/log.md', 'this is not a valid log entry header\n');
    const graph = buildDetGraph('enforced');
    await writeSeededLock(graph, {
      verdicts: [{ aspectId: 'det', unitKey: nodeUnit('svc'), verdict: 'approved' }],
    });
    const result = await runCheck(graph, null);
    expect(result.issues.some((i) => i.code === 'log-format')).toBe(true);
  });
});
