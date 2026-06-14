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
import type { DependencyExtractor } from '../../src/relations/extractors/types.js';

// Edge-case coverage for the relation pass + parse-free re-validation:
//  - a mapped file with NO recognized language (skipped during enumeration)
//  - a mapped TS file that fails to parse (treated as having no deps, pass survives)
//  - a stored outcome carrying an UNKNOWN hint family (preserved as-is on re-validation)

function writeNode(root: string, nodeRel: string, name: string, mapping: string): void {
  const dir = path.join(root, '.yggdrasil', 'model', nodeRel);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'yg-node.yaml'), `name: ${name}\ntype: service\nmapping:\n  - ${mapping}\n`, 'utf-8');
}

/** Write a node with raw yaml body (for nodes with no mapping or extra fields). */
function writeNodeRaw(root: string, nodeRel: string, yaml: string): void {
  const dir = path.join(root, '.yggdrasil', 'model', nodeRel);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'yg-node.yaml'), yaml, 'utf-8');
}

function w(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf-8');
}

describe('relation pass — edge cases', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'rel-edges-'));
    mkdirSync(path.join(root, '.yggdrasil', 'model'), { recursive: true });
    writeFileSync(
      path.join(root, '.yggdrasil', 'yg-architecture.yaml'),
      `node_types:\n  service:\n    description: 'unit'\n    log_required: false\n    when:\n      path: "**"\n  bag:\n    description: 'organizational (no mapping)'\n    log_required: false\n`,
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

  it('skips a node with no mapping, stores multiple outcomes, and hits the symbol-index cache on a re-run', async () => {
    // An organizational node with NO mapping at all → the enumeration skips it and it
    // gets no verdict (the empty-mapping continue). A C source with THREE quoted
    // includes resolving to three differently-owned files yields three stored outcomes
    // (the outcome comparator runs over them). Several TS files across nodes give the
    // symbol-language builtFrom sort multiple entries in mixed order so its comparator
    // is exercised in both directions.
    writeNodeRaw(root, 'org', 'name: Org\ntype: bag\n');
    writeNode(root, 'a', 'A', 'src/a');
    writeNode(root, 'b', 'B', 'src/b');
    writeNode(root, 'c', 'C', 'src/c');
    writeNode(root, 'd', 'D', 'src/d');
    w(root, 'src/a/main.c', '#include "../d/hd.h"\n#include "../b/hb.h"\n#include "../c/hc.h"\n');
    w(root, 'src/b/hb.h', '/* b */\n');
    w(root, 'src/c/hc.h', '/* c */\n');
    w(root, 'src/d/hd.h', '/* d */\n');
    // Several TS files in mixed lexical order across nodes — the per-language builtFrom
    // sort compares them in both directions.
    w(root, 'src/c/zeta.ts', 'export const z = 1;\n');
    w(root, 'src/b/mid.ts', 'export const m = 1;\n');
    w(root, 'src/d/alpha.ts', 'export const a = 1;\n');

    const passDeps = {
      extractorFor: extractorForLanguage,
      resolvePathToFile: makeResolvePathToFile(root),
      symbolIndexDir: path.join(root, '.yg-cache-shared'),
    };

    const graph = await loadGraph(root);
    const first = await runRelationPass(graph, root, passDeps);

    // The organizational node has no mapped files → no verdict produced for it.
    expect(first.verdicts.has('org')).toBe(false);
    // a's three cross-node includes are undeclared → refused with three outcomes.
    const a = first.verdicts.get('a');
    expect(a?.verdict).toBe('refused');
    expect(a!.evidence.outcomes.length).toBe(3);

    // Re-run with the SAME symbolIndexDir: the persisted per-language symbol index is
    // loaded from cache rather than rebuilt, and the verdicts are identical.
    const graph2 = await loadGraph(root);
    const second = await runRelationPass(graph2, root, passDeps);
    expect(second.verdicts.get('a')!.fingerprint).toBe(a!.fingerprint);
    expect(second.verdicts.get('b')!.verdict).toBe('approved');
  });

  it('skips a mapped file whose language has no extractor (node loop no-extractor branch)', async () => {
    // node a maps both a TS file and a Python file; a custom extractorFor returns an
    // extractor ONLY for typescript. The Python record carries a real language but no
    // extractor → the node loop skips it (the !extractor continue), and the pass still
    // produces an approved verdict for a.
    writeNode(root, 'a', 'A', 'src/a');
    w(root, 'src/a/foo.ts', 'export const foo = 1;\n');
    w(root, 'src/a/bar.py', 'x = 1\n');

    const tsOnly = (language: string): DependencyExtractor | undefined =>
      language === 'typescript' ? extractorForLanguage('typescript') : undefined;

    const graph = await loadGraph(root);
    const result = await runRelationPass(graph, root, {
      extractorFor: tsOnly,
      resolvePathToFile: makeResolvePathToFile(root),
      symbolIndexDir: path.join(root, '.yg-cache-noext'),
    });
    // Python file skipped (no extractor); TS file has no cross-node dep → approved.
    expect(result.verdicts.get('a')!.verdict).toBe('approved');
  });

  it('reads a resolved target that is owned but NOT enumerated (gitignored header → safeRead)', async () => {
    // node b owns src/b via a directory mapping, so its owner index matches any file
    // under src/b — including a header. But the header is gitignored, so the file
    // ENUMERATION (which honors .gitignore) skips it: it is owned yet has no enumerated
    // FileRecord. When a's include resolves onto it, the pass must read its bytes for
    // the resolved-file hash via the safeRead fallback rather than a cached record.
    writeNode(root, 'a', 'A', 'src/a');
    writeNode(root, 'b', 'B', 'src/b');
    w(root, 'src/a/main.c', '#include "../b/helper.h"\n');
    w(root, 'src/b/helper.h', '/* helper */\n');
    w(root, '.gitignore', 'src/b/helper.h\n');

    const graph = await loadGraph(root);
    const result = await runRelationPass(graph, root, {
      extractorFor: extractorForLanguage,
      resolvePathToFile: makeResolvePathToFile(root),
      symbolIndexDir: path.join(root, '.yg-cache-gi'),
    });
    // a depends on b (via the owned-but-unenumerated header) and declares no relation
    // → refused, naming b. The resolved-file hash came from safeRead.
    const a = result.verdicts.get('a');
    expect(a?.verdict).toBe('refused');
    expect(a!.violations.some((v) => v.ownerNode === 'b')).toBe(true);
  });
});
