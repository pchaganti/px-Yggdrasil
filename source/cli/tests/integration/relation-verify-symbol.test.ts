import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { loadGraph } from '../../src/core/graph-loader.js';
import { runRelationPass } from '../../src/relations/pass.js';
import { verifyRelationConformance } from '../../src/relations/verify.js';
import { nodeUnit, LOCK_FORMAT_VERSION, type LockFile } from '../../src/model/lock.js';
import type {
  DependencyExtractor,
  DetectedDep,
  DeclaredSymbol,
  ParsedFile,
} from '../../src/relations/extractors/types.js';

// Exercises the parse-free re-validation of a `symbol:`-keyed dependency in
// verify.ts. The production TypeScript extractor only emits `path:` hints, so a
// stub extractor drives the symbol path: a/foo.ts uses symbol `Bar`, which is
// declared uniquely in b/bar.ts → the pass resolves it via the SymbolTable and
// refuses a (undeclared cross-node dep). verify.ts then re-validates the stored
// symbol outcome against disk + owner index WITHOUT parsing.

const EXT = '.ts';

const symbolExtractor: DependencyExtractor = {
  languages: new Set(['typescript']),
  declarations(file: ParsedFile): DeclaredSymbol[] {
    // `Bar` is declared in any bar*.ts file. With a single such file the symbol
    // resolves uniquely; with two it becomes ambiguous (→ external outcome).
    if (/src\/[a-z]+\/bar\d*\.ts$/.test(file.path)) return [{ symbolKey: 'Bar', line: 1 }];
    return [];
  },
  uses(file: ParsedFile): DetectedDep[] {
    if (file.path.endsWith('src/a/foo.ts')) {
      return [{ targetHint: { kind: 'symbol', symbolKey: 'Bar' }, kind: 'call', line: 1 }];
    }
    return [];
  },
};

const extractorFor = (lang: string): DependencyExtractor | undefined =>
  lang === 'typescript' ? symbolExtractor : undefined;
// Symbol hints never route through the path resolver.
const resolvePathToFile = (): string | undefined => undefined;

function writeNode(root: string, nodeRel: string, name: string, mapping: string): void {
  const dir = path.join(root, '.yggdrasil', 'model', nodeRel);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'yg-node.yaml'), `name: ${name}\ntype: service\nmapping:\n  - ${mapping}\n`, 'utf-8');
}

async function seedLock(root: string): Promise<LockFile> {
  const graph = await loadGraph(root);
  const result = await runRelationPass(graph, root, {
    extractorFor,
    resolvePathToFile,
    symbolIndexDir: path.join(root, '.yg-cache-seed'),
  });
  const lock: LockFile = { version: LOCK_FORMAT_VERSION, verdicts: {}, nodes: {}, relation_verdicts: {} };
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

describe('verifyRelationConformance — symbol-hint re-validation (parse-free)', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'rel-verify-sym-'));
    mkdirSync(path.join(root, '.yggdrasil', 'model'), { recursive: true });
    writeFileSync(
      path.join(root, '.yggdrasil', 'yg-architecture.yaml'),
      `node_types:\n  service:\n    description: 'unit'\n    log_required: false\n    when:\n      path: "**"\n`,
      'utf-8',
    );
    writeFileSync(path.join(root, '.yggdrasil', 'yg-config.yaml'), `quality:\n  max_direct_relations: 10\n`, 'utf-8');
    writeNode(root, 'a', 'A', 'src/a');
    writeNode(root, 'b', 'B', 'src/b');
    mkdirSync(path.join(root, 'src', 'a'), { recursive: true });
    mkdirSync(path.join(root, 'src', 'b'), { recursive: true });
    writeFileSync(path.join(root, 'src', 'a', 'foo' + EXT), 'export const foo = 1;\n', 'utf-8');
    writeFileSync(path.join(root, 'src', 'b', 'bar' + EXT), 'export class Bar {}\n', 'utf-8');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('re-validates a resolved symbol outcome to refused on an unchanged tree', async () => {
    const lock = await seedLock(root);
    const graph = await loadGraph(root);
    const states = await verifyRelationConformance(graph, lock, { extractorFor, resolvePathToFile });
    const byNode = new Map(states.map((s) => [s.nodeId, s]));

    // a's symbol dep onto b is undeclared → refused, and the symbol outcome
    // re-validates (b/bar.ts exists, still owned by b) so the fingerprint holds.
    const a = byNode.get('a');
    expect(a?.kind).toBe('refused');
    if (a?.kind === 'refused') expect(a.reason).toContain('undeclared dependency on b');
    expect(byNode.get('b')?.kind).toBe('verified');
  });

  it('falls to unverified when the symbol target file is deleted (outcome becomes missing)', async () => {
    const lock = await seedLock(root);
    // Delete b's source so the stored symbol outcome's resolvedFile no longer
    // exists → verify.ts marks it `missing`, the fingerprint diverges, and a's
    // node falls back to unverified.
    rmSync(path.join(root, 'src', 'b', 'bar' + EXT), { force: true });
    const graph = await loadGraph(root);
    const states = await verifyRelationConformance(graph, lock, { extractorFor, resolvePathToFile });
    const byNode = new Map(states.map((s) => [s.nodeId, s]));
    expect(byNode.get('a')?.kind).toBe('unverified');
  });

  it('re-validates an AMBIGUOUS symbol (external outcome) by preserving the stored outcome', async () => {
    // Declare `Bar` in a SECOND file so the SymbolTable cannot resolve it
    // uniquely → the pass stores an `external` outcome for a's symbol use. On
    // re-validation verify.ts keeps that external outcome as-is (the prior-
    // external symbol branch), and an unchanged tree re-validates to verified.
    mkdirSync(path.join(root, 'src', 'c'), { recursive: true });
    writeFileSync(path.join(root, 'src', 'c', 'bar2' + EXT), 'export class Bar {}\n', 'utf-8');
    writeNode(root, 'c', 'C', 'src/c');

    const lock = await seedLock(root);
    // The ambiguous symbol resolves to nothing → a has no cross-node edge → approved.
    const graph = await loadGraph(root);
    const states = await verifyRelationConformance(graph, lock, { extractorFor, resolvePathToFile });
    const byNode = new Map(states.map((s) => [s.nodeId, s]));
    expect(byNode.get('a')?.kind).toBe('verified');
  });
});
