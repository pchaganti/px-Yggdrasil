import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { loadGraph } from '../../src/core/graph-loader.js';
import { runRelationPass } from '../../src/relations/pass.js';
import type {
  DependencyExtractor,
  DetectedDep,
  ParsedFile,
} from '../../src/relations/extractors/types.js';

// Extension that getLanguageForExtension maps to a real language so language
// detection is non-null and an extractor key ('typescript') exists.
const EXT = '.ts';

// Stub extractor: emits exactly one cross-node import use from a/foo.ts → ../b/bar,
// nothing for any other file, and no declarations anywhere.
const stubExtractor: DependencyExtractor = {
  languages: new Set(['typescript']),
  declarations() {
    return [];
  },
  uses(file: ParsedFile): DetectedDep[] {
    if (file.path.endsWith('src/a/foo.ts')) {
      return [{ candidates: [{ kind: 'path', specifier: '../b/bar' }], kind: 'import', line: 1 }];
    }
    return [];
  },
};

function writeNode(root: string, nodeRel: string, name: string, mapping: string): void {
  const dir = path.join(root, '.yggdrasil', 'model', nodeRel);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, 'yg-node.yaml'),
    `name: ${name}\ntype: service\nmapping:\n  - ${mapping}\n`,
    'utf-8',
  );
}

describe('runRelationPass (integration)', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'rel-pass-'));

    // Architecture: a single mapping-capable type 'service'.
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

    // Two nodes, NO relation a → b.
    writeNode(root, 'a', 'A', 'src/a');
    writeNode(root, 'b', 'B', 'src/b');

    // Real source files.
    mkdirSync(path.join(root, 'src', 'a'), { recursive: true });
    mkdirSync(path.join(root, 'src', 'b'), { recursive: true });
    writeFileSync(path.join(root, 'src', 'a', 'foo' + EXT), 'export const foo = 1;\n', 'utf-8');
    writeFileSync(path.join(root, 'src', 'b', 'bar' + EXT), 'export const bar = 2;\n', 'utf-8');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('refuses node a for an undeclared dependency on b; approves b', async () => {
    const graph = await loadGraph(root);

    const result = await runRelationPass(graph, root, {
      extractorFor: (language) => (language === 'typescript' ? stubExtractor : undefined),
      resolvePathToFile: (specifier) =>
        specifier === '../b/bar' ? 'src/b/bar' + EXT : undefined,
      symbolIndexDir: path.join(root, '.yg-cache'),
    });

    const a = result.violationsByNode.get('a');
    const b = result.violationsByNode.get('b');

    expect(a).toBeDefined();
    expect(a!.verdict).toBe('refused');
    expect(a!.violations).toHaveLength(1);
    expect(a!.violations[0].ownerNode).toBe('b');
    expect(a!.violations[0].fromFile).toBe('src/a/foo' + EXT);
    expect(a!.reason).toContain('undeclared dependency on b');

    expect(b).toBeDefined();
    expect(b!.verdict).toBe('approved');
    expect(b!.violations).toHaveLength(0);
  });

  it('sanctions a dependency on a NESTED node when a relation to its ancestor is declared', async () => {
    // Add a nested child node b/sub mapping src/b/sub, and point a's import at a
    // file owned by b/sub. Declaring a --uses--> b (the ANCESTOR of b/sub) must
    // sanction the edge: the verifier walks parentChain(b/sub) = [b] and finds b
    // among a's declared targets → no violation. This exercises the parentChain
    // ancestor-sanction branch.
    mkdirSync(path.join(root, '.yggdrasil', 'model', 'b', 'sub'), { recursive: true });
    writeFileSync(
      path.join(root, '.yggdrasil', 'model', 'b', 'sub', 'yg-node.yaml'),
      `name: BSub\ntype: service\nmapping:\n  - src/b/sub\n`,
      'utf-8',
    );
    // a declares a relation to the ancestor b.
    writeFileSync(
      path.join(root, '.yggdrasil', 'model', 'a', 'yg-node.yaml'),
      `name: A\ntype: service\nrelations:\n  - target: b\n    type: uses\nmapping:\n  - src/a\n`,
      'utf-8',
    );
    mkdirSync(path.join(root, 'src', 'b', 'sub'), { recursive: true });
    writeFileSync(path.join(root, 'src', 'b', 'sub', 'deep' + EXT), 'export const deep = 3;\n', 'utf-8');

    const graph = await loadGraph(root);
    const result = await runRelationPass(graph, root, {
      extractorFor: (language) => (language === 'typescript' ? nestedStub : undefined),
      resolvePathToFile: (specifier) =>
        specifier === '../b/sub/deep' ? 'src/b/sub/deep' + EXT : undefined,
      symbolIndexDir: path.join(root, '.yg-cache-nested'),
    });

    // a depends on b/sub but declares a relation to the ancestor b → sanctioned.
    expect(result.violationsByNode.get('a')!.verdict).toBe('approved');
    expect(result.violationsByNode.get('a')!.violations).toHaveLength(0);
  });
});

// Stub emitting one import from a/foo.ts → ../b/sub/deep (a nested node's file).
const nestedStub: DependencyExtractor = {
  languages: new Set(['typescript']),
  declarations() {
    return [];
  },
  uses(file: ParsedFile): DetectedDep[] {
    if (file.path.endsWith('src/a/foo.ts')) {
      return [{ candidates: [{ kind: 'path', specifier: '../b/sub/deep' }], kind: 'import', line: 1 }];
    }
    return [];
  },
};
