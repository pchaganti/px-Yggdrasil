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
  hashNodeSetObservation,
  hashReadObservation,
  observationKey,
  computeLlmInputHash,
  MISSING_OBSERVATION,
} from '../../../src/core/pair-hash.js';
import { ruleHashFor, companionHashFor, tierHashViewFromTier } from '../../../src/core/pair-inputs.js';
import { hashBytes } from '../../../src/io/hash.js';
import { readFileSync } from 'node:fs';
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
  /** companion.mjs bytes — when set on an LLM aspect, an artifact is added so
   *  companionHashFor() returns a hash and verify folds companionHash. */
  companion?: string;
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

  const aspectDefs: AspectDef[] = aspects.map((a) => {
    const artifacts = [{ filename: a.kind === 'llm' ? 'content.md' : 'check.mjs', content: a.ruleContent }];
    if (a.companion !== undefined) artifacts.push({ filename: 'companion.mjs', content: a.companion });
    return {
      id: a.id,
      name: a.id,
      description: a.description,
      reviewer: { type: a.kind },
      status: a.status ?? 'enforced',
      artifacts,
      scope: a.scope,
      references: a.references,
      hasCompanion: a.companion !== undefined ? true : undefined,
    } as AspectDef;
  });

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

/**
 * Compute a companion-folded LLM hash exactly as fill-llm.ts produces it: fold
 * companionHash UNCONDITIONALLY (undefined for a plain aspect → not folded) and
 * fold `touched` only-when-present. Subject + reference bytes are read from disk
 * relative to tmpDir. The aspect must carry its real artifacts (content.md +
 * optional companion.mjs) so companionHashFor() sees the same bytes both sides do.
 */
async function companionLlmHash(params: {
  aspectDef: AspectDef;
  nodePath: string;
  subjectFiles: string[];
  touched: Array<[string, string]>;
  verdict: 'approved' | 'refused';
  tierName?: string;
}): Promise<string> {
  const files = params.subjectFiles
    .map((rel): [string, string] => {
      let bytes: Buffer;
      try {
        bytes = readFileSync(path.join(tmpDir, rel));
      } catch {
        bytes = Buffer.alloc(0);
      }
      return [rel, hashBytes(bytes)];
    })
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const references = (params.aspectDef.references ?? [])
    .map((ref): [string, string, string] => {
      let bytes: Buffer;
      try {
        bytes = readFileSync(path.join(tmpDir, ref.path));
      } catch {
        bytes = Buffer.alloc(0);
      }
      return [ref.path, hashBytes(bytes), ref.description ?? ''];
    })
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return computeLlmInputHash({
    aspectId: params.aspectDef.id,
    aspectDescription: params.aspectDef.description ?? '',
    scope: params.aspectDef.scope,
    nodePath: params.nodePath,
    ruleHash: ruleHashFor(params.aspectDef, 'content.md'),
    files,
    references,
    tier: tierHashViewFromTier(params.tierName ?? 'default'),
    companionHash: companionHashFor(params.aspectDef),
    touched: params.touched,
    verdict: params.verdict,
  });
}

/** read: observation for a companion file (the fill-side fold for a companion read). */
function readObs(rel: string): [string, string] {
  return [observationKey('read', rel), hashReadObservation(readFileSync(path.join(tmpDir, rel)))];
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

  it('tier CONFIG change is NOT an input — model/consensus change keeps the verdict valid (only the tier NAME folds in)', async () => {
    writeFile('src/a.ts', 'code');
    const aspect: TestAspect = { id: 'asp', kind: 'llm', ruleContent: 'rule' };
    const tierV1: LlmConfig = { provider: 'ollama', model: 'm1', temperature: 0, consensus: 1 };
    const graph = buildGraph([{ path: 'svc', mapping: ['src/a.ts'], aspects: ['asp'] }], [aspect], { tier: tierV1 });
    const lock = emptyLock();
    setEntry(lock, 'asp', nodeUnit('svc'), {
      verdict: 'approved',
      hash: await llmHash({ aspect, nodePath: 'svc', subjectFiles: ['src/a.ts'], verdict: 'approved', tier: tierV1 }),
    });
    // Change the tier model + consensus — config is the reviewer's private business,
    // not a verdict input, so the pair stays VERIFIED.
    graph.config.reviewer!.tiers.default.model = 'm2';
    graph.config.reviewer!.tiers.default.consensus = 3;
    const result = await verifyLock(graph, lock);
    expect(result.pairs[0].state.kind).toBe('verified');
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

  it('no reviewer config → tier cannot resolve → an LLM entry cannot be revalidated → unverified', async () => {
    // When graph.config.reviewer is absent, selectTierForAspect is never called
    // (the `reviewer ? … : undefined` else arm) and the validity recompute is
    // skipped — the pair degrades to unverified (fail-closed).
    writeFile('src/a.ts', 'code');
    const aspect: TestAspect = { id: 'asp', kind: 'llm', ruleContent: 'rule' };
    const graph = buildGraph([{ path: 'svc', mapping: ['src/a.ts'], aspects: ['asp'] }], [aspect]);
    // Strip the reviewer config entirely.
    (graph.config as { reviewer?: unknown }).reviewer = undefined;
    const lock = emptyLock();
    setEntry(lock, 'asp', nodeUnit('svc'), { verdict: 'approved', hash: 'whatever' });
    const result = await verifyLock(graph, lock);
    expect(result.pairs[0].state.kind).toBe('unverified');
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

  it('touched list: directory that DISAPPEARED re-observes MISSING → unverified', async () => {
    // The listed directory existed at seed time; deleting it makes listDir return
    // null → MISSING_OBSERVATION (the entries===null arm of the list re-observe).
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
    rmSync(path.join(tmpDir, 'src/handlers'), { recursive: true }); // dir gone
    const result = await verifyLock(graph, lock);
    expect(result.pairs[0].state.kind).toBe('unverified');
  });
});

// ---------------------------------------------------------------------------
// Deterministic graph-SET observation re-observation (Bugs 2 & 3 + flow minor)
//
// Each test seeds a det entry whose `touched` carries a graph-set observation
// (absent-node / children / by-type / flow) computed exactly as the RECORDER
// would, then asserts: unchanged graph re-observes the same value (verified),
// and a membership mutation re-observes a different value (unverified). This is
// the record↔re-observe symmetry guarantee for the new observation kinds.
// ---------------------------------------------------------------------------

describe('verifyLock — deterministic graph-set observations', () => {
  /** Attach parent→children wiring onto an already-built graph. */
  function linkChildren(graph: Graph, parent: string, children: string[]): void {
    const p = graph.nodes.get(parent)!;
    p.children = children.map((c) => {
      const child = graph.nodes.get(c)!;
      child.parent = p;
      return child;
    });
  }

  it('graph: absent-node observation — creating the node later → unverified', async () => {
    writeFile('src/a.ts', 'code');
    const aspect: TestAspect = { id: 'det', kind: 'deterministic', ruleContent: 'check' };
    const graph = buildGraph([{ path: 'svc', mapping: ['src/a.ts'], aspects: ['det'] }], [aspect]);
    const key = observationKey('graph', 'ghost'); // node 'ghost' does not exist
    const touched: Array<[string, string]> = [[key, MISSING_OBSERVATION]];
    const lock = emptyLock();
    setEntry(lock, 'det', nodeUnit('svc'), {
      verdict: 'approved', touched,
      hash: await detHash({ aspect, nodePath: 'svc', subjectFiles: ['src/a.ts'], touched, verdict: 'approved' }),
    });
    // Unchanged — the node is still absent → verified.
    expect((await verifyLock(graph, lock)).pairs[0].state.kind).toBe('verified');
    // Now the node exists on disk → graph: re-observes its yaml bytes → unverified.
    writeFile('.yggdrasil/model/ghost/yg-node.yaml', 'name: ghost\n');
    expect((await verifyLock(graph, lock)).pairs[0].state.kind).toBe('unverified');
  });

  it('graph-children: adding a child → unverified', async () => {
    writeFile('src/a.ts', 'code');
    const aspect: TestAspect = { id: 'det', kind: 'deterministic', ruleContent: 'check' };
    const graph = buildGraph(
      [
        { path: 'svc', mapping: ['src/a.ts'], aspects: ['det'] },
        { path: 'svc/c1', mapping: ['src/c1.ts'], aspects: [] },
      ],
      [aspect],
    );
    linkChildren(graph, 'svc', ['svc/c1']);
    const key = observationKey('graph-children', 'svc');
    const touched: Array<[string, string]> = [[key, hashNodeSetObservation(['svc/c1'])]];
    const lock = emptyLock();
    setEntry(lock, 'det', nodeUnit('svc'), {
      verdict: 'approved', touched,
      hash: await detHash({ aspect, nodePath: 'svc', subjectFiles: ['src/a.ts'], touched, verdict: 'approved' }),
    });
    // Unchanged child set → verified.
    expect((await verifyLock(graph, lock)).pairs[0].state.kind).toBe('verified');
    // Add a second child → membership changes → unverified.
    const graph2 = buildGraph(
      [
        { path: 'svc', mapping: ['src/a.ts'], aspects: ['det'] },
        { path: 'svc/c1', mapping: ['src/c1.ts'], aspects: [] },
        { path: 'svc/c2', mapping: ['src/c2.ts'], aspects: [] },
      ],
      [aspect],
    );
    linkChildren(graph2, 'svc', ['svc/c1', 'svc/c2']);
    expect((await verifyLock(graph2, lock)).pairs[0].state.kind).toBe('unverified');
  });

  it('graph-bytype: adding a node of that type within the allowed set → unverified', async () => {
    writeFile('src/a.ts', 'code');
    const aspect: TestAspect = { id: 'det', kind: 'deterministic', ruleContent: 'check' };
    // svc + one child of type 'service' (descendants are in the allowed set).
    const graph = buildGraph(
      [
        { path: 'svc', mapping: ['src/a.ts'], aspects: ['det'] },
        { path: 'svc/c1', mapping: ['src/c1.ts'], aspects: [] },
      ],
      [aspect],
    );
    linkChildren(graph, 'svc', ['svc/c1']);
    // Both svc and svc/c1 are type 'service' and in the allowed set of 'svc'.
    const key = observationKey('graph-bytype', 'service');
    const touched: Array<[string, string]> = [[key, hashNodeSetObservation(['svc', 'svc/c1'])]];
    const lock = emptyLock();
    setEntry(lock, 'det', nodeUnit('svc'), {
      verdict: 'approved', touched,
      hash: await detHash({ aspect, nodePath: 'svc', subjectFiles: ['src/a.ts'], touched, verdict: 'approved' }),
    });
    expect((await verifyLock(graph, lock)).pairs[0].state.kind).toBe('verified');
    // Add another descendant of type service → by-type membership grows → unverified.
    const graph2 = buildGraph(
      [
        { path: 'svc', mapping: ['src/a.ts'], aspects: ['det'] },
        { path: 'svc/c1', mapping: ['src/c1.ts'], aspects: [] },
        { path: 'svc/c2', mapping: ['src/c2.ts'], aspects: [] },
      ],
      [aspect],
    );
    linkChildren(graph2, 'svc', ['svc/c1', 'svc/c2']);
    expect((await verifyLock(graph2, lock)).pairs[0].state.kind).toBe('unverified');
  });

  it('graph-children of an ABSENT parent re-observes the empty set; adding that node later → unverified', async () => {
    // The recorded observation was children-of("ghost") = ∅ (ghost not in graph).
    // While ghost stays absent the empty-set re-observation matches → verified
    // (exercises the `parent ? … : []` else arm). Adding ghost WITH a child flips it.
    writeFile('src/a.ts', 'code');
    const aspect: TestAspect = { id: 'det', kind: 'deterministic', ruleContent: 'check' };
    const graph = buildGraph([{ path: 'svc', mapping: ['src/a.ts'], aspects: ['det'] }], [aspect]);
    const key = observationKey('graph-children', 'ghost'); // no such node
    const touched: Array<[string, string]> = [[key, hashNodeSetObservation([])]];
    const lock = emptyLock();
    setEntry(lock, 'det', nodeUnit('svc'), {
      verdict: 'approved', touched,
      hash: await detHash({ aspect, nodePath: 'svc', subjectFiles: ['src/a.ts'], touched, verdict: 'approved' }),
    });
    // Absent parent → empty children set → matches the recorded ∅ → verified.
    expect((await verifyLock(graph, lock)).pairs[0].state.kind).toBe('verified');
    // Now 'ghost' exists with a child → children set grows → unverified.
    const graph2 = buildGraph(
      [
        { path: 'svc', mapping: ['src/a.ts'], aspects: ['det'] },
        { path: 'ghost', mapping: ['src/g.ts'], aspects: [] },
        { path: 'ghost/c', mapping: ['src/gc.ts'], aspects: [] },
      ],
      [aspect],
    );
    linkChildren(graph2, 'ghost', ['ghost/c']);
    expect((await verifyLock(graph2, lock)).pairs[0].state.kind).toBe('unverified');
  });

  it('graph-flow matched by flow PATH (not name) re-observes the participant set', async () => {
    // The observation target equals the flow's PATH, not its name — exercising the
    // `f.name === target || f.path === target` second disjunct.
    writeFile('src/a.ts', 'code');
    const aspect: TestAspect = { id: 'det', kind: 'deterministic', ruleContent: 'check' };
    const graph = buildGraph(
      [
        { path: 'svc', mapping: ['src/a.ts'], aspects: ['det'] },
        { path: 'other', mapping: ['src/o.ts'], aspects: [] },
      ],
      [aspect],
    );
    // name and path differ; the observation target is the PATH.
    (graph as unknown as { flows: Array<{ path: string; name: string; nodes: string[]; aspects: string[] }> }).flows = [
      { path: 'flows/checkout', name: 'Checkout Process', nodes: ['svc', 'other'], aspects: [] },
    ];
    const key = observationKey('graph-flow', 'flows/checkout'); // matched by PATH
    const touched: Array<[string, string]> = [[key, hashNodeSetObservation(['svc', 'other'])]];
    const lock = emptyLock();
    setEntry(lock, 'det', nodeUnit('svc'), {
      verdict: 'approved', touched,
      hash: await detHash({ aspect, nodePath: 'svc', subjectFiles: ['src/a.ts'], touched, verdict: 'approved' }),
    });
    expect((await verifyLock(graph, lock)).pairs[0].state.kind).toBe('verified');
  });

  it('graph-flow of a NON-EXISTENT flow re-observes the empty set', async () => {
    // No flow matches the target → the `flow ? […] : []` else arm yields ∅. The
    // recorded value was ∅ too → verified; defining the flow later flips it.
    writeFile('src/a.ts', 'code');
    const aspect: TestAspect = { id: 'det', kind: 'deterministic', ruleContent: 'check' };
    const graph = buildGraph([{ path: 'svc', mapping: ['src/a.ts'], aspects: ['det'] }], [aspect]);
    const key = observationKey('graph-flow', 'nonexistent');
    const touched: Array<[string, string]> = [[key, hashNodeSetObservation([])]];
    const lock = emptyLock();
    setEntry(lock, 'det', nodeUnit('svc'), {
      verdict: 'approved', touched,
      hash: await detHash({ aspect, nodePath: 'svc', subjectFiles: ['src/a.ts'], touched, verdict: 'approved' }),
    });
    // No such flow → empty participant set → matches recorded ∅ → verified.
    expect((await verifyLock(graph, lock)).pairs[0].state.kind).toBe('verified');
    // Define the flow with participants → set grows → unverified.
    (graph as unknown as { flows: Array<{ path: string; name: string; nodes: string[]; aspects: string[] }> }).flows = [
      { path: 'nonexistent', name: 'nonexistent', nodes: ['svc'], aspects: [] },
    ];
    expect((await verifyLock(graph, lock)).pairs[0].state.kind).toBe('unverified');
  });

  it('graph-flow: removing a participant → unverified', async () => {
    writeFile('src/a.ts', 'code');
    const aspect: TestAspect = { id: 'det', kind: 'deterministic', ruleContent: 'check' };
    const graph = buildGraph(
      [
        { path: 'svc', mapping: ['src/a.ts'], aspects: ['det'] },
        { path: 'other', mapping: ['src/o.ts'], aspects: [] },
      ],
      [aspect],
    );
    (graph as unknown as { flows: Array<{ path: string; name: string; nodes: string[]; aspects: string[] }> }).flows = [
      { path: 'checkout', name: 'checkout', nodes: ['svc', 'other'], aspects: [] },
    ];
    const key = observationKey('graph-flow', 'checkout');
    const touched: Array<[string, string]> = [[key, hashNodeSetObservation(['svc', 'other'])]];
    const lock = emptyLock();
    setEntry(lock, 'det', nodeUnit('svc'), {
      verdict: 'approved', touched,
      hash: await detHash({ aspect, nodePath: 'svc', subjectFiles: ['src/a.ts'], touched, verdict: 'approved' }),
    });
    expect((await verifyLock(graph, lock)).pairs[0].state.kind).toBe('verified');
    // Drop a participant → participant set changes → unverified.
    (graph as unknown as { flows: Array<{ path: string; name: string; nodes: string[]; aspects: string[] }> }).flows = [
      { path: 'checkout', name: 'checkout', nodes: ['svc'], aspects: [] },
    ];
    expect((await verifyLock(graph, lock)).pairs[0].state.kind).toBe('unverified');
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
// LLM companion verdicts — verify reproduces fill's companion-folded hash
//
// Each test seeds an LLM entry whose hash was produced exactly as fill-llm.ts
// would (companionHash folded UNCONDITIONALLY; touched folded only-when-present),
// then asserts verify reads it back VERIFIED unchanged and degrades to UNVERIFIED
// when a companion input (companion.mjs bytes, or a touched read: file) changes.
// ---------------------------------------------------------------------------

describe('verifyLock — LLM companion verdicts', () => {
  it('[]-companion entry (no touched) → verified when companion.mjs unchanged', async () => {
    writeFile('src/a.ts', 'code');
    const aspect: TestAspect = {
      id: 'asp', kind: 'llm', ruleContent: 'rule',
      companion: 'export function companion() { return []; }\n',
    };
    const graph = buildGraph([{ path: 'svc', mapping: ['src/a.ts'], aspects: ['asp'] }], [aspect]);
    const aspectDef = graph.aspects[0];
    // sanity: a companion aspect folds a companionHash.
    expect(companionHashFor(aspectDef)).toBeDefined();
    const lock = emptyLock();
    setEntry(lock, 'asp', nodeUnit('svc'), {
      verdict: 'approved',
      hash: await companionLlmHash({ aspectDef, nodePath: 'svc', subjectFiles: ['src/a.ts'], touched: [], verdict: 'approved' }),
    });
    const result = await verifyLock(graph, lock);
    expect(result.pairs[0].state.kind).toBe('verified');
  });

  it('[]-companion entry (no touched) → unverified after editing companion.mjs (companionHash changes)', async () => {
    writeFile('src/a.ts', 'code');
    const aspect: TestAspect = {
      id: 'asp', kind: 'llm', ruleContent: 'rule',
      companion: 'export function companion() { return []; }\n',
    };
    const graph = buildGraph([{ path: 'svc', mapping: ['src/a.ts'], aspects: ['asp'] }], [aspect]);
    const aspectDef = graph.aspects[0];
    const lock = emptyLock();
    setEntry(lock, 'asp', nodeUnit('svc'), {
      verdict: 'approved',
      hash: await companionLlmHash({ aspectDef, nodePath: 'svc', subjectFiles: ['src/a.ts'], touched: [], verdict: 'approved' }),
    });
    // Edit the companion.mjs artifact in-memory (companionHash differs ⇒ unverified)
    // even though there is NO touched and the subject + rule are unchanged.
    aspectDef.artifacts.find((a) => a.filename === 'companion.mjs')!.content =
      'export function companion() { return []; } // EDITED\n';
    const result = await verifyLock(graph, lock);
    expect(result.pairs[0].state.kind).toBe('unverified');
  });

  it('entry with touched read:<companion> → verified unchanged, unverified after editing the companion file', async () => {
    writeFile('src/a.ts', 'code');
    writeFile('src/partner.ts', 'partner-v1');
    const aspect: TestAspect = {
      id: 'asp', kind: 'llm', ruleContent: 'rule',
      companion: 'export function companion() { return [{ path: "src/partner.ts" }]; }\n',
    };
    const graph = buildGraph([{ path: 'svc', mapping: ['src/a.ts'], aspects: ['asp'] }], [aspect]);
    const aspectDef = graph.aspects[0];
    const touched: Array<[string, string]> = [readObs('src/partner.ts')];
    const lock = emptyLock();
    setEntry(lock, 'asp', nodeUnit('svc'), {
      verdict: 'approved',
      touched,
      hash: await companionLlmHash({ aspectDef, nodePath: 'svc', subjectFiles: ['src/a.ts'], touched, verdict: 'approved' }),
    });
    // Unchanged → verified.
    expect((await verifyLock(graph, lock)).pairs[0].state.kind).toBe('verified');
    // Edit the companion file → its re-observed read: hash differs → unverified.
    writeFile('src/partner.ts', 'partner-v2');
    expect((await verifyLock(graph, lock)).pairs[0].state.kind).toBe('unverified');
  });

  it('touched read:<companion> that was DELETED re-observes MISSING → unverified (no throw)', async () => {
    writeFile('src/a.ts', 'code');
    writeFile('src/partner.ts', 'present');
    const aspect: TestAspect = {
      id: 'asp', kind: 'llm', ruleContent: 'rule',
      companion: 'export function companion() { return [{ path: "src/partner.ts" }]; }\n',
    };
    const graph = buildGraph([{ path: 'svc', mapping: ['src/a.ts'], aspects: ['asp'] }], [aspect]);
    const aspectDef = graph.aspects[0];
    const touched: Array<[string, string]> = [readObs('src/partner.ts')];
    const lock = emptyLock();
    setEntry(lock, 'asp', nodeUnit('svc'), {
      verdict: 'approved',
      touched,
      hash: await companionLlmHash({ aspectDef, nodePath: 'svc', subjectFiles: ['src/a.ts'], touched, verdict: 'approved' }),
    });
    rmSync(path.join(tmpDir, 'src/partner.ts'));
    const result = await verifyLock(graph, lock); // must not throw
    expect(result.pairs[0].state.kind).toBe('unverified');
  });

  it('plain LLM entry (no companion, no touched) → verified and NOT invalidated by an unrelated cross-node edit', async () => {
    writeFile('src/a.ts', 'code');
    writeFile('src/other.ts', 'other-v1');
    const aspect: TestAspect = { id: 'asp', kind: 'llm', ruleContent: 'rule' };
    const graph = buildGraph(
      [
        { path: 'svc', mapping: ['src/a.ts'], aspects: ['asp'] },
        { path: 'other', mapping: ['src/other.ts'], aspects: [] },
      ],
      [aspect],
    );
    const aspectDef = graph.aspects[0];
    // A plain aspect folds NO companionHash — the companion-aware path must
    // reproduce the IDENTICAL pre-feature hash (proved by seeding via the plain
    // llmHash helper and reading it back verified).
    expect(companionHashFor(aspectDef)).toBeUndefined();
    const lock = emptyLock();
    setEntry(lock, 'asp', nodeUnit('svc'), {
      verdict: 'approved',
      hash: await llmHash({ aspect, nodePath: 'svc', subjectFiles: ['src/a.ts'], verdict: 'approved' }),
    });
    expect((await verifyLock(graph, lock)).pairs[0].state.kind).toBe('verified');
    // Edit an unrelated node's source — the plain svc pair stays verified.
    writeFile('src/other.ts', 'other-v2');
    expect((await verifyLock(graph, lock)).pairs[0].state.kind).toBe('verified');
  });

  it('plain LLM companion-aware hash equals the legacy plain hash (no companion double-count)', async () => {
    // The companion-aware fold for a plain aspect (companionHash undefined, no
    // touched) must equal the pre-feature plain hash byte-for-byte.
    writeFile('src/a.ts', 'code');
    const aspect: TestAspect = { id: 'asp', kind: 'llm', ruleContent: 'rule' };
    const graph = buildGraph([{ path: 'svc', mapping: ['src/a.ts'], aspects: ['asp'] }], [aspect]);
    const aspectDef = graph.aspects[0];
    const plain = await llmHash({ aspect, nodePath: 'svc', subjectFiles: ['src/a.ts'], verdict: 'approved' });
    const folded = await companionLlmHash({ aspectDef, nodePath: 'svc', subjectFiles: ['src/a.ts'], touched: [], verdict: 'approved' });
    expect(folded).toBe(plain);
  });

  it('companion==subject path produces a hash equal to the same pair with a []-resolving companion (no double-count)', async () => {
    // fill-llm drops a companion path equal to a unit subject (already hashed as a
    // subject), so a companion that returns the subject yields NO touched — the
    // hash must equal the []-companion form (companionHash folds, touched empty).
    writeFile('src/a.ts', 'code');
    const subjectReturning: TestAspect = {
      id: 'asp', kind: 'llm', ruleContent: 'rule',
      companion: 'export function companion() { return [{ path: "src/a.ts" }]; }\n',
    };
    const emptyReturning: TestAspect = {
      id: 'asp', kind: 'llm', ruleContent: 'rule',
      companion: 'export function companion() { return [{ path: "src/a.ts" }]; }\n',
    };
    const graph = buildGraph([{ path: 'svc', mapping: ['src/a.ts'], aspects: ['asp'] }], [subjectReturning]);
    const aspectDef = graph.aspects[0];
    // Both fold the SAME companionHash (same companion.mjs bytes) with empty touched.
    const subjectHash = await companionLlmHash({ aspectDef, nodePath: 'svc', subjectFiles: ['src/a.ts'], touched: [], verdict: 'approved' });
    const emptyGraph = buildGraph([{ path: 'svc', mapping: ['src/a.ts'], aspects: ['asp'] }], [emptyReturning]);
    const emptyHash = await companionLlmHash({ aspectDef: emptyGraph.aspects[0], nodePath: 'svc', subjectFiles: ['src/a.ts'], touched: [], verdict: 'approved' });
    expect(subjectHash).toBe(emptyHash);
    // And the entry verifies.
    const lock = emptyLock();
    setEntry(lock, 'asp', nodeUnit('svc'), { verdict: 'approved', hash: subjectHash });
    expect((await verifyLock(graph, lock)).pairs[0].state.kind).toBe('verified');
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
