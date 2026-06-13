/**
 * Integration test for TASK 0.11 — the relation-conformance pass wired into the
 * `yg check --approve` fill stage (core/fill.ts).
 *
 * This exercises the WIRING, not the refusal logic (the stub-extractor refused
 * case is covered by tests/integration/relation-pass.test.ts). In Phase 0 the
 * extractor registry is EMPTY, so the pass detects NO dependencies and EVERY
 * mapped node gets an `approved` verdict. We assert:
 *
 *   1. After runFill, lock.relation_verdicts['node:a'] and ['node:b'] both exist
 *      with verdict 'approved' — proving runFill runs the pass before the pool
 *      and persists its verdicts.
 *   2. GC prunes a relation verdict for a node path that is not in the graph.
 *
 * The graph has ZERO LLM aspects, so runFill completes deterministically with no
 * reviewer calls (a reviewer section is still required — it gates --approve —
 * but is never invoked).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { loadGraph } from '../../src/core/graph-loader.js';
import { runFill } from '../../src/core/fill.js';
import { readLock, writeLock } from '../../src/io/lock-store.js';

function writeNode(root: string, nodeRel: string, name: string, mapping: string): void {
  const dir = path.join(root, '.yggdrasil', 'model', nodeRel);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, 'yg-node.yaml'),
    `name: ${name}\ntype: service\nmapping:\n  - ${mapping}\n`,
    'utf-8',
  );
}

describe('relation pass wired into runFill (integration)', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'rel-fill-'));

    // Architecture: a single mapping-capable type 'service'.
    mkdirSync(path.join(root, '.yggdrasil', 'model'), { recursive: true });
    mkdirSync(path.join(root, '.yggdrasil', 'schemas'), { recursive: true });
    writeFileSync(path.join(root, '.yggdrasil', 'schemas', 'yg-node.yaml'), 'type: node\n');
    writeFileSync(path.join(root, '.yggdrasil', 'schemas', 'yg-aspect.yaml'), 'type: aspect\n');
    writeFileSync(path.join(root, '.yggdrasil', 'schemas', 'yg-flow.yaml'), 'type: flow\n');
    writeFileSync(
      path.join(root, '.yggdrasil', 'yg-architecture.yaml'),
      `node_types:\n  service:\n    description: 'unit'\n    log_required: false\n    when:\n      path: "**"\n`,
      'utf-8',
    );
    // A reviewer section is mandatory (config-reviewer-missing gates --approve),
    // even though there are zero LLM aspects so it is never invoked.
    writeFileSync(
      path.join(root, '.yggdrasil', 'yg-config.yaml'),
      'reviewer:\n  tiers:\n    standard:\n      provider: ollama\n      consensus: 1\n      config:\n        model: llama3\n        temperature: 0\n',
      'utf-8',
    );

    // Two nodes, NO relation a → b. Node a imports node b's file but declares no
    // relation; in Phase 0 (empty registry) the pass detects nothing → both approved.
    writeNode(root, 'a', 'A', 'src/a');
    writeNode(root, 'b', 'B', 'src/b');

    mkdirSync(path.join(root, 'src', 'a'), { recursive: true });
    mkdirSync(path.join(root, 'src', 'b'), { recursive: true });
    writeFileSync(
      path.join(root, 'src', 'a', 'foo.ts'),
      "import { bar } from '../b/bar';\nexport const foo = bar;\n",
      'utf-8',
    );
    writeFileSync(path.join(root, 'src', 'b', 'bar.ts'), 'export const bar = 2;\n', 'utf-8');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('runFill runs the relation pass and persists an approved verdict per mapped node', async () => {
    const graph = await loadGraph(root);
    await runFill(graph, { gitTrackedFiles: null, write: () => {} });

    const lock = readLock(graph.rootPath);
    expect(lock.relation_verdicts['node:a']).toBeDefined();
    expect(lock.relation_verdicts['node:a']?.verdict).toBe('approved');
    expect(lock.relation_verdicts['node:b']).toBeDefined();
    expect(lock.relation_verdicts['node:b']?.verdict).toBe('approved');
    // Each verdict carries a fingerprint + evidence (parse-free re-validation input).
    expect(typeof lock.relation_verdicts['node:a']?.fingerprint).toBe('string');
    expect(lock.relation_verdicts['node:a']?.fingerprint.length).toBeGreaterThan(0);
    expect(lock.relation_verdicts['node:a']?.evidence).toBeDefined();
  });

  it('GC prunes a relation verdict whose node path is not in the graph', async () => {
    // First run populates relation_verdicts for the real nodes.
    let graph = await loadGraph(root);
    await runFill(graph, { gitTrackedFiles: null, write: () => {} });

    // Inject a relation verdict for a node that does not exist, then re-fill.
    const lock = readLock(graph.rootPath);
    lock.relation_verdicts['node:ghost'] = {
      verdict: 'approved',
      fingerprint: 'deadbeef',
      evidence: {
        sources: [],
        relations: 'x',
        outcomes: [],
        grammarVersions: [],
        indexIdentity: 'y',
      },
    };
    await writeLock(graph.rootPath, lock);

    graph = await loadGraph(root);
    await runFill(graph, { gitTrackedFiles: null, write: () => {} });

    const after = readLock(graph.rootPath);
    expect(after.relation_verdicts['node:ghost']).toBeUndefined();
    // The real nodes' verdicts survive.
    expect(after.relation_verdicts['node:a']).toBeDefined();
    expect(after.relation_verdicts['node:b']).toBeDefined();
  });
});
