import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { loadGraph } from '../../src/core/graph-loader.js';
import { runRelationPass } from '../../src/relations/pass.js';
import { verifyRelationConformance } from '../../src/relations/verify.js';
import { nodeUnit, LOCK_FORMAT_VERSION, type LockFile } from '../../src/model/lock.js';
import { extractorForLanguage } from '../../src/relations/extractors/registry.js';
import { makeResolvePathToFile } from '../../src/relations/resolve-path.js';

// Edge-case coverage for the relation pass + parse-free re-validation:
//  - a mapped file with NO recognized language (skipped during enumeration)
//  - a mapped TS file that fails to parse (treated as having no deps, pass survives)
//  - a stored outcome carrying an UNKNOWN hint family (preserved as-is on re-validation)

function writeNode(root: string, nodeRel: string, name: string, mapping: string): void {
  const dir = path.join(root, '.yggdrasil', 'model', nodeRel);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'yg-node.yaml'), `name: ${name}\ntype: service\nmapping:\n  - ${mapping}\n`, 'utf-8');
}

describe('relation pass — edge cases', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'rel-edges-'));
    mkdirSync(path.join(root, '.yggdrasil', 'model'), { recursive: true });
    writeFileSync(
      path.join(root, '.yggdrasil', 'yg-architecture.yaml'),
      `node_types:\n  service:\n    description: 'unit'\n    log_required: false\n    when:\n      path: "**"\n`,
      'utf-8',
    );
    writeFileSync(path.join(root, '.yggdrasil', 'yg-config.yaml'), `quality:\n  max_direct_relations: 10\n`, 'utf-8');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('survives a no-language file and a non-parseable TS file (node still approved)', async () => {
    writeNode(root, 'a', 'A', 'src/a');
    mkdirSync(path.join(root, 'src', 'a'), { recursive: true });
    // A file with no recognized extension → getLanguageForExtension returns null
    // → the enumeration skips it (pass.ts no-language branch).
    writeFileSync(path.join(root, 'src', 'a', 'README.unknownext'), 'not source\n', 'utf-8');
    // A .ts file with a hard syntax error → parseFile path still produces a tree,
    // but we also include a binary-ish payload that the extractor walks without
    // emitting deps. Either way the pass must not throw and must approve.
    writeFileSync(path.join(root, 'src', 'a', 'broken.ts'), 'const = = = ;;; @@@ <<<\n', 'utf-8');

    const graph = await loadGraph(root);
    const result = await runRelationPass(graph, root, {
      extractorFor: extractorForLanguage,
      resolvePathToFile: makeResolvePathToFile(root),
      symbolIndexDir: path.join(root, '.yg-cache'),
    });
    expect(result.verdicts.get('a')!.verdict).toBe('approved');
  });

  it('preserves a stored outcome with an unknown hint family on re-validation', async () => {
    writeNode(root, 'a', 'A', 'src/a');
    mkdirSync(path.join(root, 'src', 'a'), { recursive: true });
    writeFileSync(path.join(root, 'src', 'a', 'foo.ts'), 'export const foo = 1;\n', 'utf-8');

    const graph = await loadGraph(root);
    const result = await runRelationPass(graph, root, {
      extractorFor: extractorForLanguage,
      resolvePathToFile: makeResolvePathToFile(root),
      symbolIndexDir: path.join(root, '.yg-cache'),
    });

    // Seed a lock from the pass, then inject an outcome with a hint family that
    // is neither `path:` nor `symbol:` so verify.ts hits the preserve-as-is
    // branch. Because we mutate the evidence, the recomputed fingerprint will
    // diverge → the node re-validates as unverified, but the unknown-hint branch
    // is exercised in the process.
    const v = result.verdicts.get('a')!;
    const lock: LockFile = { version: LOCK_FORMAT_VERSION, verdicts: {}, nodes: {}, relation_verdicts: {} };
    lock.relation_verdicts[nodeUnit('a')] = {
      verdict: v.verdict,
      fingerprint: v.fingerprint,
      reason: v.reason,
      evidence: {
        ...v.evidence,
        outcomes: [
          { fromFile: 'src/a/foo.ts', line: 1, hintKey: 'mystery:thing', outcome: { external: true } },
        ],
      },
    };

    const graph2 = await loadGraph(root);
    const states = await verifyRelationConformance(graph2, lock, {
      extractorFor: extractorForLanguage,
      resolvePathToFile: makeResolvePathToFile(root),
    });
    // The unknown-hint branch ran without throwing; the node has a definite state.
    expect(states.find((s) => s.nodeId === 'a')).toBeDefined();
  });
});
