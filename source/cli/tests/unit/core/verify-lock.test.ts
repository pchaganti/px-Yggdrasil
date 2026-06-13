/**
 * Tests for core/verify-lock.ts — the lock-verification engine (spec §6, §3.1, §4).
 *
 * Every test builds a real on-disk graph in a tmpdir: verifyLock reads subject
 * file bytes, reference bytes, aspect artifact content, and re-observes
 * deterministic touched keys against current disk state. Lock entries are seeded
 * with hashes computed from the SAME frozen-contract helpers verifyLock uses, so
 * a valid entry verifies and any input change degrades it to unverified.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { Graph, GraphNode, AspectDef, ScopeDef, LlmConfig } from '../../../src/model/graph.js';
import type { LockFile, VerdictEntry } from '../../../src/model/lock.js';
import { nodeUnit, fileUnit, LOCK_FORMAT_VERSION } from '../../../src/model/lock.js';
import { verifyLock } from '../../../src/core/verify-lock.js';
import {
  hashExistsObservation,
  observationKey,
} from '../../../src/core/pair-hash.js';
import {
  computeSeedLlmHash,
  computeSeedDetHash,
  reObserveForSeed as reObserveForSeedShared,
} from '../helpers/seed-lock.js';

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'yg-verify-lock-'));
});
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function writeFile(relPath: string, content: string): void {
  const abs = path.join(tmpDir, relPath);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf-8');
}

const DEFAULT_TIER: LlmConfig = {
  provider: 'ollama',
  model: 'test',
  temperature: 0,
  consensus: 1,
};

interface TestAspect {
  id: string;
  kind: 'llm' | 'deterministic';
  status?: 'draft' | 'advisory' | 'enforced';
  description?: string;
  ruleContent: string;          // content.md or check.mjs bytes
  scope?: ScopeDef;
  references?: Array<{ path: string; description?: string }>;
}

interface TestNode {
  path: string;
  mapping: string[];
  aspects: string[];
  description?: string;
}

function buildGraph(
  nodes: TestNode[],
  aspects: TestAspect[],
  opts?: { tier?: LlmConfig },
): Graph {
  const rootPath = path.join(tmpDir, '.yggdrasil');
  mkdirSync(rootPath, { recursive: true });

  const aspectDefs: AspectDef[] = aspects.map((a) => ({
    id: a.id,
    name: a.id,
    description: a.description,
    reviewer: { type: a.kind },
    status: a.status ?? 'enforced',
    artifacts: [{ filename: a.kind === 'llm' ? 'content.md' : 'check.mjs', content: a.ruleContent }],
    scope: a.scope,
    references: a.references,
  } as AspectDef));

  const nodeByPath = new Map<string, GraphNode>();
  for (const n of nodes) {
    nodeByPath.set(n.path, {
      path: n.path,
      meta: { name: n.path, type: 'service', aspects: n.aspects, mapping: n.mapping, description: n.description },
      children: [],
      parent: null,
    } as GraphNode);
  }

  return {
    config: {
      version: '5.0.0',
      reviewer: { tiers: { default: opts?.tier ?? DEFAULT_TIER }, default: 'default' },
    },
    architecture: { node_types: { service: { description: 'test' } } },
    nodes: nodeByPath,
    aspects: aspectDefs,
    flows: [],
    schemas: [],
    rootPath,
  } as unknown as Graph;
}

function emptyLock(): LockFile {
  return { version: LOCK_FORMAT_VERSION, verdicts: {}, nodes: {} };
}

/**
 * Compute the valid LLM hash for a pair given current disk state.
 * Delegates to the shared seed-lock fold so the frozen contract lives in ONE
 * place (subjects/references are read from disk relative to tmpDir).
 */
function llmHash(params: {
  aspect: TestAspect;
  nodePath: string;
  nodeDescription?: string;
  subjectFiles: string[];
  verdict: 'approved' | 'refused';
  tier?: LlmConfig;
}): Promise<string> {
  return computeSeedLlmHash(tmpDir, {
    aspectId: params.aspect.id,
    aspectDescription: params.aspect.description,
    scope: params.aspect.scope,
    nodePath: params.nodePath,
    ruleContent: params.aspect.ruleContent,
    subjectFiles: params.subjectFiles,
    references: params.aspect.references,
    tier: params.tier ?? DEFAULT_TIER,
    verdict: params.verdict,
  });
}

/** Compute the valid deterministic hash for a pair given current disk state. */
function detHash(params: {
  aspect: TestAspect;
  nodePath: string;
  subjectFiles: string[];
  touched: Array<[string, string]>;
  verdict: 'approved' | 'refused';
}): Promise<string> {
  return computeSeedDetHash(tmpDir, {
    aspectId: params.aspect.id,
    scope: params.aspect.scope,
    nodePath: params.nodePath,
    ruleContent: params.aspect.ruleContent,
    subjectFiles: params.subjectFiles,
    touched: params.touched,
    verdict: params.verdict,
  });
}

function setEntry(lock: LockFile, aspectId: string, unitKey: string, entry: VerdictEntry): void {
  (lock.verdicts[aspectId] ??= {})[unitKey] = entry;
}

// ---------------------------------------------------------------------------
// LLM pair validity
// ---------------------------------------------------------------------------

describe('verifyLock — LLM pair validity', () => {
  it('missing entry → unverified', async () => {
    writeFile('src/a.ts', 'code');
    const aspect: TestAspect = { id: 'asp', kind: 'llm', ruleContent: 'rule' };
    const graph = buildGraph([{ path: 'svc', mapping: ['src/a.ts'], aspects: ['asp'] }], [aspect]);
    const result = await verifyLock(graph, emptyLock());
    expect(result.pairs).toHaveLength(1);
    expect(result.pairs[0].state.kind).toBe('unverified');
  });

  it('valid approved entry → verified', async () => {
    writeFile('src/a.ts', 'code');
    const aspect: TestAspect = { id: 'asp', kind: 'llm', ruleContent: 'rule' };
    const graph = buildGraph([{ path: 'svc', mapping: ['src/a.ts'], aspects: ['asp'] }], [aspect]);
    const lock = emptyLock();
    setEntry(lock, 'asp', nodeUnit('svc'), {
      verdict: 'approved',
      hash: await llmHash({ aspect, nodePath: 'svc', subjectFiles: ['src/a.ts'], verdict: 'approved' }),
    });
    const result = await verifyLock(graph, lock);
    expect(result.pairs[0].state.kind).toBe('verified');
  });

  it('valid refused entry → refused with stored reason', async () => {
    writeFile('src/a.ts', 'code');
    const aspect: TestAspect = { id: 'asp', kind: 'llm', ruleContent: 'rule' };
    const graph = buildGraph([{ path: 'svc', mapping: ['src/a.ts'], aspects: ['asp'] }], [aspect]);
    const lock = emptyLock();
    setEntry(lock, 'asp', nodeUnit('svc'), {
      verdict: 'refused',
      reason: 'violated rule at src/a.ts:3',
      hash: await llmHash({ aspect, nodePath: 'svc', subjectFiles: ['src/a.ts'], verdict: 'refused' }),
    });
    const result = await verifyLock(graph, lock);
    expect(result.pairs[0].state).toEqual({ kind: 'refused', reason: 'violated rule at src/a.ts:3' });
  });

  it('subject-file edit → unverified', async () => {
    writeFile('src/a.ts', 'code');
    const aspect: TestAspect = { id: 'asp', kind: 'llm', ruleContent: 'rule' };
    const graph = buildGraph([{ path: 'svc', mapping: ['src/a.ts'], aspects: ['asp'] }], [aspect]);
    const lock = emptyLock();
    setEntry(lock, 'asp', nodeUnit('svc'), {
      verdict: 'approved',
      hash: await llmHash({ aspect, nodePath: 'svc', subjectFiles: ['src/a.ts'], verdict: 'approved' }),
    });
    writeFile('src/a.ts', 'code CHANGED'); // edit after seeding
    const result = await verifyLock(graph, lock);
    expect(result.pairs[0].state.kind).toBe('unverified');
  });

  it('aspect content.md edit → unverified', async () => {
    writeFile('src/a.ts', 'code');
    const aspect: TestAspect = { id: 'asp', kind: 'llm', ruleContent: 'rule' };
    const graph = buildGraph([{ path: 'svc', mapping: ['src/a.ts'], aspects: ['asp'] }], [aspect]);
    const lock = emptyLock();
    // Seed against the ORIGINAL rule content, then mutate the artifact in-memory
    // (simulating a content.md edit between approve and check).
    setEntry(lock, 'asp', nodeUnit('svc'), {
      verdict: 'approved',
      hash: await llmHash({ aspect, nodePath: 'svc', subjectFiles: ['src/a.ts'], verdict: 'approved' }),
    });
    graph.aspects[0].artifacts[0].content = 'rule EDITED';
    const result = await verifyLock(graph, lock);
    expect(result.pairs[0].state.kind).toBe('unverified');
  });

  it('reference content edit → unverified', async () => {
    writeFile('src/a.ts', 'code');
    writeFile('docs/ref.md', 'ref-v1');
    const aspect: TestAspect = {
      id: 'asp', kind: 'llm', ruleContent: 'rule',
      references: [{ path: 'docs/ref.md', description: 'catalogue' }],
    };
    const graph = buildGraph([{ path: 'svc', mapping: ['src/a.ts'], aspects: ['asp'] }], [aspect]);
    const lock = emptyLock();
    setEntry(lock, 'asp', nodeUnit('svc'), {
      verdict: 'approved',
      hash: await llmHash({ aspect, nodePath: 'svc', subjectFiles: ['src/a.ts'], verdict: 'approved' }),
    });
    writeFile('docs/ref.md', 'ref-v2'); // edit reference content
    const result = await verifyLock(graph, lock);
    expect(result.pairs[0].state.kind).toBe('unverified');
  });

  it('tier config change → unverified', async () => {
    writeFile('src/a.ts', 'code');
    const aspect: TestAspect = { id: 'asp', kind: 'llm', ruleContent: 'rule' };
    const tierV1: LlmConfig = { provider: 'ollama', model: 'm1', temperature: 0, consensus: 1 };
    const graph = buildGraph([{ path: 'svc', mapping: ['src/a.ts'], aspects: ['asp'] }], [aspect], { tier: tierV1 });
    const lock = emptyLock();
    setEntry(lock, 'asp', nodeUnit('svc'), {
      verdict: 'approved',
      hash: await llmHash({ aspect, nodePath: 'svc', subjectFiles: ['src/a.ts'], verdict: 'approved', tier: tierV1 }),
    });
    // Change the tier model — folds into the hash → unverified.
    graph.config.reviewer!.tiers.default.model = 'm2';
    const result = await verifyLock(graph, lock);
    expect(result.pairs[0].state.kind).toBe('unverified');
  });

  it('verdict-token tamper (entry says approved but hash computed for refused) → unverified', async () => {
    writeFile('src/a.ts', 'code');
    const aspect: TestAspect = { id: 'asp', kind: 'llm', ruleContent: 'rule' };
    const graph = buildGraph([{ path: 'svc', mapping: ['src/a.ts'], aspects: ['asp'] }], [aspect]);
    const lock = emptyLock();
    setEntry(lock, 'asp', nodeUnit('svc'), {
      verdict: 'approved', // tampered token
      hash: await llmHash({ aspect, nodePath: 'svc', subjectFiles: ['src/a.ts'], verdict: 'refused' }), // hash for refused
    });
    const result = await verifyLock(graph, lock);
    expect(result.pairs[0].state.kind).toBe('unverified');
  });

  it('node description is NOT an input — changing it keeps the verdict valid', async () => {
    writeFile('src/a.ts', 'code');
    const aspect: TestAspect = { id: 'asp', kind: 'llm', ruleContent: 'rule' };
    const graph = buildGraph(
      [{ path: 'svc', mapping: ['src/a.ts'], aspects: ['asp'], description: 'original' }],
      [aspect],
    );
    const lock = emptyLock();
    setEntry(lock, 'asp', nodeUnit('svc'), {
      verdict: 'approved',
      hash: await llmHash({ aspect, nodePath: 'svc', subjectFiles: ['src/a.ts'], verdict: 'approved' }),
    });
    graph.nodes.get('svc')!.meta.description = 'changed prompt garnish';
    const result = await verifyLock(graph, lock);
    expect(result.pairs[0].state.kind).toBe('verified');
  });
});

// ---------------------------------------------------------------------------
// Deterministic pair validity + observation re-observation
// ---------------------------------------------------------------------------

describe('verifyLock — deterministic pair validity', () => {
  // Seed touched observations through the shared re-observer (reads current disk
  // relative to tmpDir), so the seed stays byte-compatible with verifyLock.
  async function detGraph(
    touchedKeys: string[] = [],
  ): Promise<{ graph: Graph; aspect: TestAspect; touched: Array<[string, string]> }> {
    const aspect: TestAspect = { id: 'det', kind: 'deterministic', ruleContent: 'check' };
    const graph = buildGraph([{ path: 'svc', mapping: ['src/a.ts'], aspects: ['det'] }], [aspect]);
    const touched: Array<[string, string]> = [];
    for (const k of touchedKeys) touched.push([k, await reObserveForSeedShared(tmpDir, k)]);
    return { graph, aspect, touched };
  }

  it('valid approved det entry → verified', async () => {
    writeFile('src/a.ts', 'code');
    const aspect: TestAspect = { id: 'det', kind: 'deterministic', ruleContent: 'check' };
    const graph = buildGraph([{ path: 'svc', mapping: ['src/a.ts'], aspects: ['det'] }], [aspect]);
    const lock = emptyLock();
    setEntry(lock, 'det', nodeUnit('svc'), {
      verdict: 'approved',
      hash: await detHash({ aspect, nodePath: 'svc', subjectFiles: ['src/a.ts'], touched: [], verdict: 'approved' }),
    });
    const result = await verifyLock(graph, lock);
    expect(result.pairs[0].state.kind).toBe('verified');
  });

  it('valid refused det entry renders stored reason', async () => {
    writeFile('src/a.ts', 'code');
    const aspect: TestAspect = { id: 'det', kind: 'deterministic', ruleContent: 'check' };
    const graph = buildGraph([{ path: 'svc', mapping: ['src/a.ts'], aspects: ['det'] }], [aspect]);
    const lock = emptyLock();
    setEntry(lock, 'det', nodeUnit('svc'), {
      verdict: 'refused',
      reason: 'src/a.ts:1: forbidden import',
      hash: await detHash({ aspect, nodePath: 'svc', subjectFiles: ['src/a.ts'], touched: [], verdict: 'refused' }),
    });
    const result = await verifyLock(graph, lock);
    expect(result.pairs[0].state).toEqual({ kind: 'refused', reason: 'src/a.ts:1: forbidden import' });
  });

  it('touched read: file edit → unverified', async () => {
    writeFile('src/a.ts', 'code');
    writeFile('src/shared.ts', 'shared-v1');
    const key = observationKey('read', 'src/shared.ts');
    const { graph, aspect, touched } = await detGraph([key]);
    const lock = emptyLock();
    setEntry(lock, 'det', nodeUnit('svc'), {
      verdict: 'approved',
      touched,
      hash: await detHash({ aspect, nodePath: 'svc', subjectFiles: ['src/a.ts'], touched, verdict: 'approved' }),
    });
    writeFile('src/shared.ts', 'shared-v2'); // edit the touched file
    const result = await verifyLock(graph, lock);
    expect(result.pairs[0].state.kind).toBe('unverified');
  });

  it('touched list: dir gains a file → unverified', async () => {
    writeFile('src/a.ts', 'code');
    writeFile('src/handlers/one.ts', 'one');
    const key = observationKey('list', 'src/handlers');
    const { graph, aspect, touched } = await detGraph([key]);
    const lock = emptyLock();
    setEntry(lock, 'det', nodeUnit('svc'), {
      verdict: 'approved',
      touched,
      hash: await detHash({ aspect, nodePath: 'svc', subjectFiles: ['src/a.ts'], touched, verdict: 'approved' }),
    });
    writeFile('src/handlers/two.ts', 'two'); // dir listing changes
    const result = await verifyLock(graph, lock);
    expect(result.pairs[0].state.kind).toBe('unverified');
  });

  it('touched exists:false path now exists → unverified', async () => {
    writeFile('src/a.ts', 'code');
    const key = observationKey('exists', 'src/maybe.ts'); // absent at seed time
    const { graph, aspect, touched } = await detGraph([key]);
    expect(touched[0][1]).toBe(hashExistsObservation(false)); // seeded as false
    const lock = emptyLock();
    setEntry(lock, 'det', nodeUnit('svc'), {
      verdict: 'approved',
      touched,
      hash: await detHash({ aspect, nodePath: 'svc', subjectFiles: ['src/a.ts'], touched, verdict: 'approved' }),
    });
    writeFile('src/maybe.ts', 'now here'); // the negative probe is now positive
    const result = await verifyLock(graph, lock);
    expect(result.pairs[0].state.kind).toBe('unverified');
  });

  it('touched graph: node yaml edit → unverified', async () => {
    writeFile('src/a.ts', 'code');
    writeFile('.yggdrasil/model/other/yg-node.yaml', 'name: other\n');
    const key = observationKey('graph', 'other');
    const { graph, aspect, touched } = await detGraph([key]);
    const lock = emptyLock();
    setEntry(lock, 'det', nodeUnit('svc'), {
      verdict: 'approved',
      touched,
      hash: await detHash({ aspect, nodePath: 'svc', subjectFiles: ['src/a.ts'], touched, verdict: 'approved' }),
    });
    writeFile('.yggdrasil/model/other/yg-node.yaml', 'name: other\ntype: changed\n');
    const result = await verifyLock(graph, lock);
    expect(result.pairs[0].state.kind).toBe('unverified');
  });

  it('re-observation of a DELETED touched read file → unverified (no throw)', async () => {
    writeFile('src/a.ts', 'code');
    writeFile('src/gone.ts', 'present');
    const key = observationKey('read', 'src/gone.ts');
    const { graph, aspect, touched } = await detGraph([key]);
    const lock = emptyLock();
    setEntry(lock, 'det', nodeUnit('svc'), {
      verdict: 'approved',
      touched,
      hash: await detHash({ aspect, nodePath: 'svc', subjectFiles: ['src/a.ts'], touched, verdict: 'approved' }),
    });
    rmSync(path.join(tmpDir, 'src/gone.ts')); // delete the touched file
    const result = await verifyLock(graph, lock); // must not throw
    expect(result.pairs[0].state.kind).toBe('unverified');
  });

  it('unchanged touched observations keep the verdict verified', async () => {
    writeFile('src/a.ts', 'code');
    writeFile('src/shared.ts', 'shared');
    const key = observationKey('read', 'src/shared.ts');
    const { graph, aspect, touched } = await detGraph([key]);
    const lock = emptyLock();
    setEntry(lock, 'det', nodeUnit('svc'), {
      verdict: 'approved',
      touched,
      hash: await detHash({ aspect, nodePath: 'svc', subjectFiles: ['src/a.ts'], touched, verdict: 'approved' }),
    });
    const result = await verifyLock(graph, lock); // nothing changed
    expect(result.pairs[0].state.kind).toBe('verified');
  });
});

// ---------------------------------------------------------------------------
// Per-file independence + draft exclusion
// ---------------------------------------------------------------------------

describe('verifyLock — per-file independence and draft', () => {
  it('per-file pair validity is independent (editing file A does not invalidate file B)', async () => {
    writeFile('src/a.ts', 'a-code');
    writeFile('src/b.ts', 'b-code');
    const aspect: TestAspect = { id: 'asp', kind: 'llm', ruleContent: 'rule', scope: { per: 'file' } };
    const graph = buildGraph([{ path: 'svc', mapping: ['src/a.ts', 'src/b.ts'], aspects: ['asp'] }], [aspect]);
    const lock = emptyLock();
    setEntry(lock, 'asp', fileUnit('src/a.ts'), {
      verdict: 'approved',
      hash: await llmHash({ aspect, nodePath: 'svc', subjectFiles: ['src/a.ts'], verdict: 'approved' }),
    });
    setEntry(lock, 'asp', fileUnit('src/b.ts'), {
      verdict: 'approved',
      hash: await llmHash({ aspect, nodePath: 'svc', subjectFiles: ['src/b.ts'], verdict: 'approved' }),
    });
    writeFile('src/a.ts', 'a-code CHANGED'); // only A changes
    const result = await verifyLock(graph, lock);
    const byUnit = new Map(result.pairs.map((p) => [p.pair.unitKey, p.state.kind]));
    expect(byUnit.get(fileUnit('src/a.ts'))).toBe('unverified');
    expect(byUnit.get(fileUnit('src/b.ts'))).toBe('verified');
  });

  it('draft aspect → no expected pair', async () => {
    writeFile('src/a.ts', 'code');
    const aspect: TestAspect = { id: 'asp', kind: 'llm', ruleContent: 'rule', status: 'draft' };
    const graph = buildGraph([{ path: 'svc', mapping: ['src/a.ts'], aspects: ['asp'] }], [aspect]);
    const result = await verifyLock(graph, emptyLock());
    expect(result.pairs).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Prompt-size gate (§4)
// ---------------------------------------------------------------------------

describe('verifyLock — prompt-size gate', () => {
  const SMALL_LIMIT = 50; // any real prompt scaffold exceeds this

  function gatedGraph(opts: { status?: 'enforced' | 'advisory' } = {}): { graph: Graph; aspect: TestAspect } {
    writeFile('src/a.ts', 'some source content that pads the prompt out');
    const aspect: TestAspect = {
      id: 'asp', kind: 'llm', ruleContent: 'a rule with enough text to overflow the tiny limit',
      status: opts.status,
    };
    const tier: LlmConfig = { provider: 'ollama', model: 'test', temperature: 0, consensus: 1, max_prompt_chars: SMALL_LIMIT };
    const graph = buildGraph([{ path: 'svc', mapping: ['src/a.ts'], aspects: ['asp'] }], [aspect], { tier });
    return { graph, aspect };
  }

  it('oversized + no entry → prompt-too-large state (no unverified duplicate)', async () => {
    const { graph } = gatedGraph();
    const result = await verifyLock(graph, emptyLock());
    expect(result.pairs[0].state.kind).toBe('prompt-too-large');
    if (result.pairs[0].state.kind === 'prompt-too-large') {
      expect(result.pairs[0].state.limit).toBe(SMALL_LIMIT);
      expect(result.pairs[0].state.chars).toBeGreaterThan(SMALL_LIMIT);
      expect(result.pairs[0].state.tierName).toBe('default');
    }
    expect(result.pairs[0].oversized).toBeUndefined();
  });

  it('oversized + valid entry → verdict state preserved + oversized gate surfaced', async () => {
    const { graph, aspect } = gatedGraph();
    const tier = graph.config.reviewer!.tiers.default;
    const lock = emptyLock();
    setEntry(lock, 'asp', nodeUnit('svc'), {
      verdict: 'approved',
      hash: await llmHash({ aspect, nodePath: 'svc', subjectFiles: ['src/a.ts'], verdict: 'approved', tier }),
    });
    const result = await verifyLock(graph, lock);
    expect(result.pairs[0].state.kind).toBe('verified'); // verdict preserved
    expect(result.pairs[0].oversized).toBeDefined();
    expect(result.pairs[0].oversized!.limit).toBe(SMALL_LIMIT);
  });

  it('a tier without max_prompt_chars never trips the gate', async () => {
    writeFile('src/a.ts', 'code');
    const aspect: TestAspect = { id: 'asp', kind: 'llm', ruleContent: 'rule' };
    const graph = buildGraph([{ path: 'svc', mapping: ['src/a.ts'], aspects: ['asp'] }], [aspect]);
    const result = await verifyLock(graph, emptyLock());
    expect(result.pairs[0].state.kind).toBe('unverified'); // not prompt-too-large
  });
});

// ---------------------------------------------------------------------------
// Unreadable subjects pass-through
// ---------------------------------------------------------------------------

describe('verifyLock — unreadable pass-through', () => {
  it('forwards PairComputation.unreadable', async () => {
    // No unreadable in the common case; assert the field is present and is an array.
    writeFile('src/a.ts', 'code');
    const aspect: TestAspect = { id: 'asp', kind: 'llm', ruleContent: 'rule' };
    const graph = buildGraph([{ path: 'svc', mapping: ['src/a.ts'], aspects: ['asp'] }], [aspect]);
    const result = await verifyLock(graph, emptyLock());
    expect(Array.isArray(result.unreadable)).toBe(true);
  });
});
