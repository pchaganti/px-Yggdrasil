import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'; // rmSync used in cleanup + the unmapped-target case
import { tmpdir } from 'node:os';

import { loadGraph } from '../../src/core/graph-loader.js';
import { runRelationPass } from '../../src/relations/pass.js';
import { verifyRelationConformance } from '../../src/relations/verify.js';
import { nodeUnit, LOCK_FORMAT_VERSION, type LockFile } from '../../src/model/lock.js';
import * as parser from '../../src/ast/parser.js';
import type {
  DependencyExtractor,
  DetectedDep,
  ParsedFile,
} from '../../src/relations/extractors/types.js';

const EXT = '.ts';

// Stub extractor: a/foo.ts imports ../b/bar (cross-node, undeclared → refused);
// no declarations anywhere.
const stubExtractor: DependencyExtractor = {
  languages: new Set(['typescript']),
  declarations() {
    return [];
  },
  uses(file: ParsedFile): DetectedDep[] {
    if (file.path.endsWith('src/a/foo.ts')) {
      return [{ targetHint: { kind: 'path', specifier: '../b/bar' }, kind: 'import', line: 1 }];
    }
    return [];
  },
};

const extractorFor = (language: string): DependencyExtractor | undefined =>
  language === 'typescript' ? stubExtractor : undefined;
const resolvePathToFile = (specifier: string): string | undefined =>
  specifier === '../b/bar' ? 'src/b/bar' + EXT : undefined;

function writeNode(root: string, nodeRel: string, name: string, mapping: string): void {
  const dir = path.join(root, '.yggdrasil', 'model', nodeRel);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, 'yg-node.yaml'),
    `name: ${name}\ntype: service\nmapping:\n  - ${mapping}\n`,
    'utf-8',
  );
}

/** Seed a LockFile by running the parse-heavy pass and transcribing its verdicts. */
async function seedLock(root: string): Promise<LockFile> {
  const graph = await loadGraph(root);
  const result = await runRelationPass(graph, root, {
    extractorFor,
    resolvePathToFile,
    symbolIndexDir: path.join(root, '.yg-cache-seed'),
  });
  const lock: LockFile = {
    version: LOCK_FORMAT_VERSION,
    verdicts: {},
    nodes: {},
    relation_verdicts: {},
  };
  for (const [nodeId, v] of result.verdicts) {
    lock.relation_verdicts[nodeUnit(nodeId)] = {
      verdict: v.verdict,
      fingerprint: v.fingerprint,
      reason: v.reason,
      evidence: v.evidence,
    };
  }
  return lock;
}

describe('verifyRelationConformance (integration, parse-free)', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'rel-verify-'));
    mkdirSync(path.join(root, '.yggdrasil', 'model'), { recursive: true });
    writeFileSync(
      path.join(root, '.yggdrasil', 'yg-architecture.yaml'),
      `node_types:\n  service:\n    description: 'unit'\n    log_required: false\n    when:\n      path: "**"\n`,
      'utf-8',
    );
    writeFileSync(
      path.join(root, '.yggdrasil', 'yg-config.yaml'),
      `quality:\n  max_direct_relations: 10\n`,
      'utf-8',
    );
    writeNode(root, 'a', 'A', 'src/a');
    writeNode(root, 'b', 'B', 'src/b');
    mkdirSync(path.join(root, 'src', 'a'), { recursive: true });
    mkdirSync(path.join(root, 'src', 'b'), { recursive: true });
    writeFileSync(path.join(root, 'src', 'a', 'foo' + EXT), 'export const foo = 1;\n', 'utf-8');
    writeFileSync(path.join(root, 'src', 'b', 'bar' + EXT), 'export const bar = 2;\n', 'utf-8');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  it('(a) unchanged tree → each seeded verdict re-validates to its sealed state', async () => {
    const lock = await seedLock(root);
    const graph = await loadGraph(root);

    const states = await verifyRelationConformance(graph, lock, { extractorFor, resolvePathToFile });
    const byNode = new Map(states.map((s) => [s.nodeId, s]));

    // a was refused (undeclared dep on b) → re-validates as refused with its reason.
    const a = byNode.get('a');
    expect(a?.kind).toBe('refused');
    if (a?.kind === 'refused') expect(a.reason).toContain('undeclared dependency on b');

    // b was approved → re-validates as verified.
    expect(byNode.get('b')?.kind).toBe('verified');
  });

  it('(b) a source byte change → that node becomes unverified', async () => {
    const lock = await seedLock(root);

    // Mutate b/bar.ts bytes on disk — b's source fingerprint drifts.
    writeFileSync(path.join(root, 'src', 'b', 'bar' + EXT), 'export const bar = 999;\n', 'utf-8');

    const graph = await loadGraph(root);
    const states = await verifyRelationConformance(graph, lock, { extractorFor, resolvePathToFile });
    const byNode = new Map(states.map((s) => [s.nodeId, s]));

    // b's own source changed → unverified.
    expect(byNode.get('b')?.kind).toBe('unverified');
    // a resolves a dep INTO b/bar.ts, so its resolvedFileHash (folded into the
    // fingerprint via indexIdentity + outcome hash) also drifts → unverified.
    expect(byNode.get('a')?.kind).toBe('unverified');
  });

  it('(c) a missing lock entry → that node is unverified', async () => {
    const lock = await seedLock(root);
    delete lock.relation_verdicts[nodeUnit('b')];

    const graph = await loadGraph(root);
    const states = await verifyRelationConformance(graph, lock, { extractorFor, resolvePathToFile });
    const byNode = new Map(states.map((s) => [s.nodeId, s]));

    expect(byNode.get('b')?.kind).toBe('unverified');
    // a's entry is intact and its inputs are unchanged → still refused.
    expect(byNode.get('a')?.kind).toBe('refused');
  });

  it('(d) verifyRelationConformance NEVER parses (zero parseFile calls)', async () => {
    const lock = await seedLock(root);
    const graph = await loadGraph(root);

    const spy = vi.spyOn(parser, 'parseFile');
    await verifyRelationConformance(graph, lock, { extractorFor, resolvePathToFile });
    expect(spy).toHaveBeenCalledTimes(0);
  });

  it('(e) the path hint re-resolves to an UNMAPPED file → external outcome, node falls to unverified', async () => {
    const lock = await seedLock(root);
    // Drop node b entirely so src/b/bar.ts is owned by NO node. The stored
    // `path:` hint still resolves to the file on disk, but ownerOf is now
    // undefined → verify.ts records an `external` outcome (the path-external
    // branch). a's stored outcome was owned, so the fingerprint diverges → a is
    // unverified rather than refused.
    rmSync(path.join(root, '.yggdrasil', 'model', 'b'), { recursive: true, force: true });
    const graph = await loadGraph(root);
    const states = await verifyRelationConformance(graph, lock, { extractorFor, resolvePathToFile });
    const byNode = new Map(states.map((s) => [s.nodeId, s]));
    expect(byNode.get('a')?.kind).toBe('unverified');
  });
});
