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
      return [{ targetHint: { kind: 'path', specifier: '../b/bar' }, kind: 'import', line: 1 }];
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

    const a = result.verdicts.get('a');
    const b = result.verdicts.get('b');

    expect(a).toBeDefined();
    expect(a!.verdict).toBe('refused');
    expect(a!.violations).toHaveLength(1);
    expect(a!.violations[0].ownerNode).toBe('b');
    expect(a!.violations[0].fromFile).toBe('src/a/foo' + EXT);
    expect(a!.reason).toContain('undeclared dependency on b');

    expect(b).toBeDefined();
    expect(b!.verdict).toBe('approved');
    expect(b!.violations).toHaveLength(0);

    // The refused node carries its fingerprint evidence — at least the one
    // detected cross-node dependency that drove the refusal.
    expect(a!.evidence.outcomes.length).toBeGreaterThanOrEqual(1);

    // Fingerprints are populated and distinct between the two nodes.
    expect(typeof a!.fingerprint).toBe('string');
    expect(a!.fingerprint.length).toBeGreaterThan(0);
    expect(a!.fingerprint).not.toBe(b!.fingerprint);
  });
});
