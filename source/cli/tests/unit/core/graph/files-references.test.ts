import { describe, it, expect } from 'vitest';
import type { Graph, GraphNode, AspectDef } from '../../../../src/model/graph.js';
import { collectTrackedFiles } from '../../../../src/core/graph/files.js';

function makeMinimalGraph(opts: {
  nodePath: string;
  nodeAspects?: string[];
  mapping?: string[];
  aspects: AspectDef[];
}): { graph: Graph; node: GraphNode } {
  const node: GraphNode = {
    path: opts.nodePath,
    meta: {
      name: opts.nodePath,
      type: 'module',
      description: '',
      aspects: opts.nodeAspects ?? [],
      relations: [],
      mapping: opts.mapping,
    },
    children: [],
    parent: null,
  };
  const graph: Graph = {
    rootPath: '/tmp/project/.yggdrasil',
    nodes: new Map([[opts.nodePath, node]]),
    aspects: opts.aspects,
    flows: [],
    architecture: { node_types: [{ id: 'module', allowed_parents: [] }] },
    config: { reviewer: { default: 'standard', tiers: { standard: { provider: 'ollama', consensus: 1, config: {} } } } },
    schemas: [],
  } as unknown as Graph;
  return { graph, node };
}

describe('collectTrackedFiles — references', () => {
  it('LLM aspect with references → entries appear as graph/aspects', () => {
    const aspect: AspectDef = {
      id: 'a', name: 'A', reviewer: { type: 'llm' },
      artifacts: [{ filename: 'content.md', content: '' }, { filename: 'yg-aspect.yaml', content: '' }],
      references: [{ path: 'docs/codes.md' }],
    };
    const { graph, node } = makeMinimalGraph({ nodePath: 'svc', nodeAspects: ['a'], aspects: [aspect] });
    const tracked = collectTrackedFiles(node, graph);
    const ref = tracked.find(t => t.path === 'docs/codes.md');
    expect(ref).toBeDefined();
    expect(ref?.category).toBe('graph');
    expect(ref?.layer).toBe('aspects');
  });

  it('AST aspect with references is treated as if it had none (LLM guard)', () => {
    const aspect: AspectDef = {
      id: 'a', name: 'A', reviewer: { type: 'deterministic' },
      artifacts: [{ filename: 'check.mjs', content: '' }, { filename: 'yg-aspect.yaml', content: '' }],
      // Should not happen (parser rejects), but defensive guard:
      references: [{ path: 'docs/codes.md' }],
    } as AspectDef;
    const { graph, node } = makeMinimalGraph({ nodePath: 'svc', nodeAspects: ['a'], aspects: [aspect] });
    const tracked = collectTrackedFiles(node, graph);
    expect(tracked.find(t => t.path === 'docs/codes.md')).toBeUndefined();
  });

  it('reference path in node mapping → classified as source/source, not graph/aspects', () => {
    const aspect: AspectDef = {
      id: 'a', name: 'A', reviewer: { type: 'llm' },
      artifacts: [{ filename: 'content.md', content: '' }, { filename: 'yg-aspect.yaml', content: '' }],
      references: [{ path: 'src/own.ts' }],
    };
    const { graph, node } = makeMinimalGraph({
      nodePath: 'svc', nodeAspects: ['a'], aspects: [aspect],
      mapping: ['src/own.ts'],
    });
    const tracked = collectTrackedFiles(node, graph);
    const own = tracked.find(t => t.path === 'src/own.ts');
    expect(own?.category).toBe('source');
    expect(own?.layer).toBe('source');
  });

  it('reference UNDER a directory mapping → owned (prefix-aware), not classified as graph/aspects', () => {
    // A reference file that sits inside a directory mapping is claimed by the SOURCE
    // step (the directory expands to it at hash time). It must NOT also be tracked as
    // an upstream graph/aspects reference — that would classify an own-file edit as an
    // upstream cascade and bypass the source-drift log requirement.
    const aspect: AspectDef = {
      id: 'a', name: 'A', reviewer: { type: 'llm' },
      artifacts: [{ filename: 'content.md', content: '' }, { filename: 'yg-aspect.yaml', content: '' }],
      references: [{ path: 'src/feature/own.ts' }],
    };
    const { graph, node } = makeMinimalGraph({
      nodePath: 'svc', nodeAspects: ['a'], aspects: [aspect],
      mapping: ['src/feature/'], // directory mapping (trailing slash normalized away)
    });
    const tracked = collectTrackedFiles(node, graph);
    // The reference is owned by the directory mapping → not a separate upstream entry.
    expect(tracked.find(t => t.path === 'src/feature/own.ts')).toBeUndefined();
    // The directory mapping itself is the SOURCE entry.
    const dir = tracked.find(t => t.path === 'src/feature');
    expect(dir?.category).toBe('source');
    expect(dir?.layer).toBe('source');
  });

  it('shared reference across two aspects → tracked once', () => {
    const aspects: AspectDef[] = [
      { id: 'a', name: 'A', reviewer: { type: 'llm' }, artifacts: [{ filename: 'content.md', content: '' }, { filename: 'yg-aspect.yaml', content: '' }], references: [{ path: 'docs/shared.md' }] },
      { id: 'b', name: 'B', reviewer: { type: 'llm' }, artifacts: [{ filename: 'content.md', content: '' }, { filename: 'yg-aspect.yaml', content: '' }], references: [{ path: 'docs/shared.md' }] },
    ];
    const { graph, node } = makeMinimalGraph({ nodePath: 'svc', nodeAspects: ['a', 'b'], aspects });
    const tracked = collectTrackedFiles(node, graph);
    const matches = tracked.filter(t => t.path === 'docs/shared.md');
    expect(matches.length).toBe(1);
  });

  it('aspect without references → no extra tracked entries (regression guard)', () => {
    const aspect: AspectDef = {
      id: 'a', name: 'A', reviewer: { type: 'llm' },
      artifacts: [{ filename: 'content.md', content: '' }, { filename: 'yg-aspect.yaml', content: '' }],
    };
    const { graph, node } = makeMinimalGraph({ nodePath: 'svc', nodeAspects: ['a'], aspects: [aspect] });
    const tracked = collectTrackedFiles(node, graph);
    expect(tracked.find(t => t.category === 'graph' && t.layer === 'aspects' && t.path.startsWith('docs/'))).toBeUndefined();
  });

  it('two aspects with different declared paths produce two tracked entries (symlink-alias dedup contract)', () => {
    // Spec: dedup is by declared string path, not realpath.
    // Two distinct declared paths (even if they resolve to the same file on disk via a symlink)
    // produce two separate TrackedFile entries — drift fires independently for each declared path.
    const aspects: AspectDef[] = [
      {
        id: 'a', name: 'A', reviewer: { type: 'llm' },
        artifacts: [{ filename: 'content.md', content: '' }, { filename: 'yg-aspect.yaml', content: '' }],
        references: [{ path: 'docs/a.md' }],  // canonical path
      },
      {
        id: 'b', name: 'B', reviewer: { type: 'llm' },
        artifacts: [{ filename: 'content.md', content: '' }, { filename: 'yg-aspect.yaml', content: '' }],
        references: [{ path: 'docs/b.md' }],  // different declared path (could be a symlink to a.md)
      },
    ];
    const { graph, node } = makeMinimalGraph({ nodePath: 'svc', nodeAspects: ['a', 'b'], aspects });
    const tracked = collectTrackedFiles(node, graph);
    const aEntry = tracked.find(t => t.path === 'docs/a.md');
    const bEntry = tracked.find(t => t.path === 'docs/b.md');
    // Both declared paths appear as separate entries — dedup is by declared string, not realpath
    expect(aEntry).toBeDefined();
    expect(bEntry).toBeDefined();
    expect(aEntry?.category).toBe('graph');
    expect(aEntry?.layer).toBe('aspects');
    expect(bEntry?.category).toBe('graph');
    expect(bEntry?.layer).toBe('aspects');
  });

  it('cross-node: file in nodeY mapping, referenced by aspect on nodeX → classified separately per node', () => {
    const aspect: AspectDef = {
      id: 'a', name: 'A', reviewer: { type: 'llm' },
      artifacts: [{ filename: 'content.md', content: '' }, { filename: 'yg-aspect.yaml', content: '' }],
      references: [{ path: 'src/y.ts' }],
    };
    const nodeX: GraphNode = {
      path: 'x',
      meta: { name: 'x', type: 'module', description: '', aspects: ['a'], relations: [] },
      children: [],
      parent: null,
    };
    const nodeY: GraphNode = {
      path: 'y',
      meta: { name: 'y', type: 'module', description: '', aspects: [], relations: [], mapping: ['src/y.ts'] },
      children: [],
      parent: null,
    };
    const graph: Graph = {
      rootPath: '/tmp/project/.yggdrasil',
      nodes: new Map([['x', nodeX], ['y', nodeY]]),
      aspects: [aspect],
      flows: [],
      architecture: { node_types: [{ id: 'module', allowed_parents: [] }] },
      config: { reviewer: { default: 'standard', tiers: { standard: { provider: 'ollama', consensus: 1, config: {} } } } },
      schemas: [],
    } as unknown as Graph;

    const trackedX = collectTrackedFiles(nodeX, graph);
    const trackedY = collectTrackedFiles(nodeY, graph);

    const xEntry = trackedX.find(t => t.path === 'src/y.ts');
    const yEntry = trackedY.find(t => t.path === 'src/y.ts');

    expect(xEntry?.category).toBe('graph');
    expect(xEntry?.layer).toBe('aspects');
    expect(yEntry?.category).toBe('source');
    expect(yEntry?.layer).toBe('source');
  });
});
