/**
 * Integration: runCheck emits a blocking `relation-undeclared-dependency` error
 * for every node whose relation verdict re-validates to refused OR unverified,
 * and emits NO such issue for a node whose verdict re-validates to verified.
 *
 * runCheck wires the parse-free `verifyRelationConformance` with the REAL
 * extractor registry (TypeScript is live). To get a node that re-validates as
 * VERIFIED under runCheck, the lock is seeded by a relation pass run with the
 * SAME real extractor + resolver universe runCheck uses (`extractorForLanguage`
 * + `makeResolvePathToFile`), so the symbol-language universe and indexIdentity
 * match. The fixture's source files contain NO imports, so no cross-node edge is
 * detected, every node is approved, and the fingerprint computed at seed time
 * matches the one runCheck recomputes. From that green baseline:
 *   - deleting a node's relation verdict        → unverified → error (case b)
 *   - corrupting a node's stored fingerprint     → unverified → error (case a)
 *   - leaving a node's verdict intact            → verified  → no issue (case c)
 *
 * The refused-RENDERING path is covered by relation-verify.test.ts; here we prove
 * the runCheck WIRING emits the issue with the right code / severity / nodePath.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { loadGraph } from '../../src/core/graph-loader.js';
import { runCheck } from '../../src/core/check.js';
import { runRelationPass } from '../../src/relations/pass.js';
import { extractorForLanguage } from '../../src/relations/extractors/registry.js';
import { makeResolvePathToFile } from '../../src/relations/resolve-path.js';
import { writeLock } from '../../src/io/lock-store.js';
import { nodeUnit, LOCK_FORMAT_VERSION, type LockFile } from '../../src/model/lock.js';

const EXT = '.ts';

const CODE = 'relation-undeclared-dependency';

function writeNode(root: string, nodeRel: string, name: string, mapping: string): void {
  const dir = path.join(root, '.yggdrasil', 'model', nodeRel);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, 'yg-node.yaml'),
    `name: ${name}\ntype: service\nmapping:\n  - ${mapping}\n`,
    'utf-8',
  );
}

/**
 * Seed a lock through the parse-heavy pass run with the SAME real extractor +
 * resolver universe runCheck uses (TypeScript live), so the seeded verdicts
 * re-validate as VERIFIED under runCheck on an unchanged tree. The fixture's
 * source files import nothing, so no cross-node edge exists → every node is
 * approved and the fingerprints match.
 */
async function seedGreenLock(root: string): Promise<LockFile> {
  const graph = await loadGraph(root);
  const result = await runRelationPass(graph, root, {
    extractorFor: extractorForLanguage, // same real universe runCheck uses
    resolvePathToFile: makeResolvePathToFile(root),
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

function relIssuesFor(issues: { code: string; nodePath?: string; severity: string }[], nodeId: string) {
  return issues.filter((i) => i.code === CODE && i.nodePath === nodeId);
}

describe('runCheck — relation-undeclared-dependency wiring', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'rel-check-'));
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
    rmSync(root, { recursive: true, force: true });
  });

  it('(c) a verified relation verdict (unchanged tree) → NO relation issue', async () => {
    const lock = await seedGreenLock(root);
    await writeLock(path.join(root, '.yggdrasil'), lock);

    const graph = await loadGraph(root);
    const result = await runCheck(graph, null); // null git files → skip coverage

    // Both nodes were approved by the empty-universe pass and re-validate as
    // verified under runCheck → no relation-undeclared-dependency issue at all.
    expect(result.issues.filter((i) => i.code === CODE)).toHaveLength(0);
  });

  it('(b) a node with NO relation verdict (but mapped source) → unverified error', async () => {
    const lock = await seedGreenLock(root);
    delete lock.relation_verdicts[nodeUnit('b')]; // b now has no verdict
    await writeLock(path.join(root, '.yggdrasil'), lock);

    const graph = await loadGraph(root);
    const result = await runCheck(graph, null);

    const bIssues = relIssuesFor(result.issues, 'b');
    expect(bIssues).toHaveLength(1);
    expect(bIssues[0].severity).toBe('error');
    expect(bIssues[0].code).toBe(CODE);
    expect(bIssues[0].nodePath).toBe('b');

    // a's verdict is intact and re-validates verified → no relation issue for a.
    expect(relIssuesFor(result.issues, 'a')).toHaveLength(0);
  });

  it('(a) a node whose stored fingerprint no longer matches → unverified error', async () => {
    const lock = await seedGreenLock(root);
    // Corrupt b's fingerprint so the parse-free recompute can never match it →
    // the node falls back to unverified (the blocking emission path).
    lock.relation_verdicts[nodeUnit('b')].fingerprint = 'deadbeef-not-the-real-fingerprint';
    await writeLock(path.join(root, '.yggdrasil'), lock);

    const graph = await loadGraph(root);
    const result = await runCheck(graph, null);

    const bIssues = relIssuesFor(result.issues, 'b');
    expect(bIssues).toHaveLength(1);
    expect(bIssues[0].severity).toBe('error');
    expect(bIssues[0].nodePath).toBe('b');
  });
});
