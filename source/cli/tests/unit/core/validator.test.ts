import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { validate } from '../../../src/core/validator.js';
import { loadGraph } from '../../../src/core/graph-loader.js';
import type { Graph, GraphNode } from '../../../src/model/graph.js';
import { buildIssueMessage } from '../../../src/formatters/message-builder.js';
const msgOf = (i: { messageData: Parameters<typeof buildIssueMessage>[0] }) => buildIssueMessage(i.messageData);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PROJECT = path.join(__dirname, '../../fixtures/sample-project');
const FIXTURE_ORPHAN_DIR = path.join(__dirname, '../../fixtures/sample-project-orphan-dir');
const CLI_ROOT = path.join(__dirname, '../../../..');

function createNode(nodePath: string, overrides: Partial<GraphNode['meta']> = {}): GraphNode {
  const name = nodePath.split('/').pop() ?? nodePath;
  return {
    path: nodePath,
    meta: {
      name,
      type: 'service',
      ...overrides,
    },
    children: [],
    parent: null,
  };
}

function createGraph(overrides: Partial<Graph> = {}): Graph {
  return {
    config: {},
    architecture: { node_types: {} },
    nodes: new Map(),
    aspects: [{ name: 'Valid', id: 'valid-tag', artifacts: [] }],
    flows: [],
    schemas: [],
    rootPath: path.join(FIXTURE_PROJECT, '.yggdrasil'),
    ...overrides,
  };
}

describe('validator', () => {
  it('validate with invalid scope returns error', async () => {
    const graph = await loadGraph(FIXTURE_PROJECT);
    const result = await validate(graph, 'nonexistent/node');

    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].rule).toBe('invalid-scope');
    expect(msgOf(result.issues[0])).toContain('Node not found');
    expect(result.nodesScanned).toBe(0);
  });

  it('validate with configError pushes invalid-config issue', async () => {
    const graph = createGraph();
    graph.configError = 'Config parse failed';
    graph.nodes.set('a', createNode('a'));

    const result = await validate(graph);
    const configIssue = result.issues.find((i) => i.rule === 'invalid-config');
    expect(configIssue).toBeDefined();
    expect(msgOf(configIssue!)).toContain('yg-config.yaml failed to parse.');
    expect(msgOf(configIssue!)).toContain('Config parse failed');
  });

  it('returns only expected errors for sample-project', async () => {
    const graph = await loadGraph(FIXTURE_PROJECT);
    const result = await validate(graph);

    const errors = result.issues.filter((i) => i.severity === 'error');
    // mapping-path-missing: users/missing-service maps src/users/missing.service.ts which doesn't exist on disk
    // (intentional fixture — used by drift tests to verify "missing" detection)
    const unexpectedErrors = errors.filter(
      (i) => !(i.code === 'mapping-path-missing' && i.nodePath === 'users/missing-service'),
    );
    expect(unexpectedErrors).toHaveLength(0);
    expect(result.nodesScanned).toBe(9);
  }, 10000);

  it('relation-targets-exist returns error for missing relation target', async () => {
    const graph = createGraph();
    graph.nodes.set(
      'a',
      createNode('a', { relations: [{ target: 'missing/target', type: 'uses' }] }),
    );

    const result = await validate(graph);
    const issues = result.issues.filter((i) => i.rule === 'broken-relation');
    expect(issues).toHaveLength(1);
    expect(issues[0].nodePath).toBe('a');
  });

  it('dangling-aspect-ref returns error when node aspect has no aspect def', async () => {
    const graph = createGraph();
    graph.nodes.set('a', createNode('a', { aspects: ['no-aspect-for-this'] }));

    const result = await validate(graph);
    const issues = result.issues.filter((i) => i.rule === 'dangling-aspect-ref');
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe('aspect-undefined');
    expect(msgOf(issues[0])).toContain('not defined in aspects/');
  });

  it('dangling-aspect-ref fires when a port references an undefined aspect', async () => {
    const graph = createGraph();
    graph.nodes.set('a', createNode('a', {
      ports: { 'api': { description: 'API port', aspects: ['missing-aspect'] } },
    }));

    const result = await validate(graph);
    const issues = result.issues.filter((i) => i.code === 'aspect-undefined' && i.nodePath === 'a');
    expect(issues).toHaveLength(1);
    expect(issues[0].rule).toBe('dangling-aspect-ref');
    expect(msgOf(issues[0])).toContain('missing-aspect');
    expect(msgOf(issues[0])).toContain("port 'api'");
  });

  it('dangling-aspect-ref fires when architecture node_type references an undefined aspect', async () => {
    const graph = createGraph({
      architecture: {
        node_types: {
          service: { description: 'A service', aspects: ['undefined-arch-aspect'] },
        },
      },
      aspects: [],
    });
    graph.nodes.set('a', createNode('a'));

    const result = await validate(graph);
    const issues = result.issues.filter((i) => i.code === 'aspect-undefined' && !i.nodePath);
    expect(issues).toHaveLength(1);
    expect(issues[0].rule).toBe('dangling-aspect-ref');
    expect(msgOf(issues[0])).toContain('undefined-arch-aspect');
    expect(msgOf(issues[0])).toContain("architecture type 'service'");
  });

  it('dangling-aspect-ref fires when a flow references an undefined aspect', async () => {
    const graph = createGraph({ aspects: [] });
    graph.nodes.set('a', createNode('a'));
    graph.flows.push({
      path: 'checkout-flow',
      name: 'Checkout',
      nodes: ['a'],
      aspects: ['missing-flow-aspect'],
    });

    const result = await validate(graph);
    const issues = result.issues.filter((i) => i.code === 'aspect-undefined');
    expect(issues).toHaveLength(1);
    expect(issues[0].rule).toBe('dangling-aspect-ref');
    expect(msgOf(issues[0])).toContain('missing-flow-aspect');
    expect(msgOf(issues[0])).toContain("flow");
    expect(msgOf(issues[0])).toContain("missing-flow-aspect");
  });

  it('duplicate-aspect-binding returns error when id bound to multiple aspects', async () => {
    const graph = createGraph({
      aspects: [
        { name: 'Aspect One', id: 'audit', artifacts: [] },
        { name: 'Aspect Two', id: 'audit', artifacts: [] },
      ],
    });
    graph.nodes.set('a', createNode('a'));

    const result = await validate(graph);
    const issues = result.issues.filter((i) => i.rule === 'duplicate-aspect-binding');
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe('duplicate-aspect-id');
    expect(msgOf(issues[0])).toContain('audit');
    expect(msgOf(issues[0])).toContain('Aspect One');
    expect(msgOf(issues[0])).toContain('Aspect Two');
  });


  it('invalid-node-yaml reports parse errors from graph loader', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-validator-parse-error');
    const yggRoot = path.join(tmpDir, '.yggdrasil');
    const modelDir = path.join(yggRoot, 'model');
    const badNodeDir = path.join(modelDir, 'bad-node');

    await mkdir(badNodeDir, { recursive: true });
    await writeFile(
      path.join(yggRoot, 'yg-config.yaml'),
      'version: "4.0.0"',
    );
    await writeFile(path.join(badNodeDir, 'yg-node.yaml'), 'type: service\n# missing name');

    try {
      const graph = await loadGraph(tmpDir);
      const result = await validate(graph);
      const issues = result.issues.filter((i) => i.rule === 'invalid-node-yaml');
      expect(issues).toHaveLength(1);
      expect(issues[0].code).toBe('yaml-invalid');
      expect(issues[0].nodePath).toBe('bad-node');
      expect(msgOf(issues[0])).toContain('name');
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('missing-node-yaml catches orphan directory with content', async () => {
    const graph = await loadGraph(FIXTURE_ORPHAN_DIR);
    const result = await validate(graph);
    const issues = result.issues.filter((i) => i.rule === 'missing-node-yaml');
    expect(issues).toHaveLength(1);
    expect(msgOf(issues[0])).toContain('no yg-node.yaml');
    expect(issues[0].nodePath).toBe('orders/orphan-service');
    expect(issues[0].code).toBe('node-yaml-missing');
  });

  it('directories-have-node-yaml catches orphan directory with content in model', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-validator-orphan');
    const yggRoot = path.join(tmpDir, '.yggdrasil');
    const modelDir = path.join(yggRoot, 'model');
    const orphanDir = path.join(modelDir, 'orphan-with-content');
    const serviceDir = path.join(modelDir, 'svc');

    await mkdir(orphanDir, { recursive: true });
    await mkdir(serviceDir, { recursive: true });
    await writeFile(
      path.join(yggRoot, 'yg-config.yaml'),
      'version: "4.0.0"',
    );
    await writeFile(path.join(serviceDir, 'yg-node.yaml'), 'name: Svc\ntype: service\n');
    await writeFile(path.join(orphanDir, 'readme.md'), '# orphan content');

    try {
      const graph = await loadGraph(tmpDir);
      const result = await validate(graph);
      const issues = result.issues.filter((i) => i.rule === 'missing-node-yaml');
      expect(issues).toHaveLength(1);
      expect(issues[0].nodePath).toBe('orphan-with-content');
      expect(issues[0].code).toBe('node-yaml-missing');
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('file-duplicate-mapping errors for exact duplicate mapping paths', async () => {
    const graph = createGraph();
    graph.nodes.set(
      'svc/a',
      createNode('svc/a', { mapping: ['src/shared/file.ts'] }),
    );
    graph.nodes.set(
      'svc/b',
      createNode('svc/b', { mapping: ['src/shared/file.ts'] }),
    );

    const result = await validate(graph);
    const issues = result.issues.filter((i) => i.rule === 'file-duplicate-mapping');
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('error');
    expect(result.issues.filter((i) => i.rule === 'overlapping-mapping')).toHaveLength(0);
  });

  it('overlapping-mapping errors for containment overlap between siblings', async () => {
    const graph = createGraph();
    graph.nodes.set(
      'svc/a',
      createNode('svc/a', { mapping: ['src/shared'] }),
    );
    graph.nodes.set(
      'svc/b',
      createNode('svc/b', { mapping: ['src/shared/file.ts'] }),
    );

    const result = await validate(graph);
    const issues = result.issues.filter((i) => i.rule === 'overlapping-mapping');
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('error');
  });

  it('overlapping-mapping allows containment overlap between parent and child nodes', async () => {
    const graph = createGraph();
    graph.nodes.set(
      'platform',
      createNode('platform', { mapping: ['src/platform'] }),
    );
    graph.nodes.set(
      'platform/auth',
      createNode('platform/auth', { mapping: ['src/platform/auth'] }),
    );

    const result = await validate(graph);
    const issues = result.issues.filter((i) => i.rule === 'overlapping-mapping');
    expect(issues).toHaveLength(0);
  });

  it('file-duplicate-mapping errors for exact duplicate between parent and child nodes', async () => {
    const graph = createGraph();
    graph.nodes.set(
      'platform',
      createNode('platform', { mapping: ['src/platform'] }),
    );
    graph.nodes.set(
      'platform/auth',
      createNode('platform/auth', { mapping: ['src/platform'] }),
    );

    const result = await validate(graph);
    const issues = result.issues.filter((i) => i.rule === 'file-duplicate-mapping');
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('error');
  });

  it('config-populated returns no issues for valid config', async () => {
    const graph = createGraph();
    graph.nodes.set('a', createNode('a'));

    const result = await validate(graph);
    const issues = result.issues.filter((i) => i.rule === 'config-populated');
    expect(issues).toHaveLength(0);
  });

  it('non-regression: does not enforce node/relation vocabulary', async () => {
    const graph = createGraph();
    graph.nodes.set(
      'strange/node',
      createNode('strange/node', {
        type: 'totally-custom-type',
        relations: [{ target: 'strange/target', type: 'uses' }],
      }),
    );
    graph.nodes.set(
      'strange/target',
      createNode('strange/target', { type: 'another-custom-type' }),
    );

    const result = await validate(graph);
    const typeOrRelationVocabularyIssues = result.issues.filter((i) => {
      return msgOf(i).includes('unknown node type') || msgOf(i).includes('unknown relation type');
    });
    expect(typeOrRelationVocabularyIssues).toHaveLength(0);
  });

  it('non-regression: does not require interface.yaml by node type', async () => {
    const graph = createGraph();
    graph.nodes.set('api/no-interface', createNode('api/no-interface', { type: 'api' }));

    const result = await validate(graph);
    const interfaceIssues = result.issues.filter((i) => msgOf(i).includes('interface.yaml'));
    expect(interfaceIssues).toHaveLength(0);
  });

  it('non-regression: check does not validate mapped file existence on disk', async () => {
    const graph = createGraph();
    graph.nodes.set(
      'svc/nonexistent-mapping',
      createNode('svc/nonexistent-mapping', {
        mapping: ['src'],
      }),
    );

    const result = await validate(graph);
    const mappingExistenceIssues = result.issues.filter((i) => {
      return msgOf(i).includes('does not exist');
    });
    expect(mappingExistenceIssues).toHaveLength(0);
  });

  it('flow validation uses FlowDef[] (not nodes)', async () => {
    const graph = createGraph();
    graph.nodes.set('svc/a', createNode('svc/a'));
    const result = await validate(graph);
    const flowRules = result.issues.filter((i) =>
      [
        'flow-type-in-flows-dir',
        'flow-outside-flows-dir',
        'flow-missing-description',
        'flow-bidirectional-relations',
      ].includes(i.rule),
    );
    expect(flowRules).toHaveLength(0);
  });

  it('relation-targets no suggestion when no similar candidates', async () => {
    const graph = createGraph();
    graph.nodes.set('a', createNode('a', { relations: [{ target: 'xyz/unknown', type: 'uses' }] }));
    graph.nodes.set('b', createNode('b'));

    const result = await validate(graph);
    const issues = result.issues.filter((i) => i.rule === 'broken-relation');
    expect(issues).toHaveLength(1);
    expect(msgOf(issues[0])).not.toContain('did you mean');
  });

  it('relation-targets suggests similar path when target not found', async () => {
    const graph = createGraph();
    graph.nodes.set(
      'a',
      createNode('a', { relations: [{ target: 'orders/ordr-servce', type: 'uses' }] }),
    );
    graph.nodes.set('orders/order-service', createNode('orders/order-service'));

    const result = await validate(graph);
    const issues = result.issues.filter((i) => i.rule === 'broken-relation');
    expect(issues).toHaveLength(1);
    expect(msgOf(issues[0])).toContain('Did you mean');
    expect(msgOf(issues[0])).toContain('orders/order-service');
  });

  it('broken-flow-ref returns error for non-existent node in flow', async () => {
    const graph = createGraph();
    graph.nodes.set('a', createNode('a'));
    graph.flows.push({
      path: 'f1',
      name: 'F1',
      nodes: ['a', 'nonexistent/node'],
    });

    const result = await validate(graph);
    const issues = result.issues.filter((i) => i.rule === 'broken-flow-ref');
    expect(issues.some((i) => msgOf(i).includes('non-existent node'))).toBe(true);
  });

  it('flow aspect id must have corresponding aspect', async () => {
    const graph = createGraph();
    graph.nodes.set('a', createNode('a'));
    graph.flows.push({
      path: 'saga-flow',
      name: 'SagaFlow',
      nodes: ['a'],
      aspects: ['undefined-tag'],
    });

    const result = await validate(graph);
    const issues = result.issues.filter((i) => i.rule === 'dangling-aspect-ref' && msgOf(i).includes('flow'));
    expect(issues).toHaveLength(1);
    expect(msgOf(issues[0])).toContain("undefined-tag");
  });

  it('flow aspect id without corresponding aspect returns error', async () => {
    const graph = createGraph({ aspects: [] });
    graph.nodes.set('a', createNode('a'));
    graph.flows.push({
      path: 'f2',
      name: 'F2',
      nodes: ['a'],
      aspects: ['valid-tag'],
    });
    // aspects[] is empty — no aspect binds to valid-tag

    const result = await validate(graph);
    const issues = result.issues.filter((i) => i.rule === 'dangling-aspect-ref' && msgOf(i).includes('flow'));
    expect(issues).toHaveLength(1);
    expect(msgOf(issues[0])).toContain("not defined in aspects");
  });

  it('high-fan-out warns when node exceeds max_direct_relations', async () => {
    const graph = createGraph();
    graph.config.quality = {
      max_direct_relations: 2,
    };
    const relations = Array.from({ length: 5 }, (_, i) => ({
      target: `target/${i}`,
      type: 'uses' as const,
    }));
    graph.nodes.set('a', createNode('a', { relations }));
    for (let i = 0; i < 5; i++) {
      graph.nodes.set(`target/${i}`, createNode(`target/${i}`));
    }

    const result = await validate(graph);
    const issues = result.issues.filter((i) => i.rule === 'high-fan-out');
    expect(issues).toHaveLength(1);
    expect(msgOf(issues[0])).toContain('5 direct relations');
  });

  it('unpaired-event warns when emits without listens', async () => {
    const graph = createGraph();
    graph.nodes.set(
      'emitter',
      createNode('emitter', { relations: [{ target: 'listener', type: 'emits' }] }),
    );
    graph.nodes.set('listener', createNode('listener'));

    const result = await validate(graph);
    const issues = result.issues.filter((i) => i.rule === 'unpaired-event');
    expect(issues.length).toBeGreaterThan(0);
  });

  it('unpaired-event warns when listens without emits', async () => {
    const graph = createGraph();
    graph.nodes.set('emitter', createNode('emitter'));
    graph.nodes.set(
      'listener',
      createNode('listener', { relations: [{ target: 'emitter', type: 'listens' }] }),
    );

    const result = await validate(graph);
    const issues = result.issues.filter((i) => i.rule === 'unpaired-event');
    expect(issues.length).toBeGreaterThan(0);
  });

  it('structural-cycle detects circular dependency', async () => {
    const graph = createGraph();
    graph.nodes.set('a', createNode('a', { relations: [{ target: 'b', type: 'uses' }] }));
    graph.nodes.set('b', createNode('b', { relations: [{ target: 'a', type: 'uses' }] }));

    const result = await validate(graph);
    const issues = result.issues.filter((i) => i.rule === 'structural-cycle');
    expect(issues).toHaveLength(1);
    expect(msgOf(issues[0])).toContain('Circular dependency');
  });

  it('validate with scope filters issues to that node only', async () => {
    const graph = createGraph();
    graph.nodes.set('a', createNode('a', { relations: [{ target: 'missing', type: 'uses' }] }));
    graph.nodes.set('b', createNode('b'));

    const result = await validate(graph, 'b');
    expect(result.nodesScanned).toBe(1);
    expect(result.issues.filter((i) => i.nodePath === 'a')).toHaveLength(0);
  });

  it('validate with scope all scans all nodes', async () => {
    const graph = createGraph();
    graph.nodes.set('a', createNode('a'));
    graph.nodes.set('b', createNode('b'));
    const result = await validate(graph, 'all');
    expect(result.nodesScanned).toBe(2);
  });

  it('validate with empty scope uses all nodes', async () => {
    const graph = createGraph();
    graph.nodes.set('a', createNode('a'));
    graph.nodes.set('b', createNode('b'));
    const result = await validate(graph, '   ');
    expect(result.nodesScanned).toBe(2);
  });

  it('aspect-id-uniqueness returns error when id bound to multiple aspects', async () => {
    const graph = createGraph({
      aspects: [
        { name: 'Aspect1', id: 'dup-tag', artifacts: [] },
        { name: 'Aspect2', id: 'dup-tag', artifacts: [] },
      ],
    });
    graph.nodes.set('a', createNode('a'));

    const result = await validate(graph);
    const issues = result.issues.filter((i) => i.rule === 'duplicate-aspect-binding');
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe('duplicate-aspect-id');
    expect(msgOf(issues[0])).toContain('multiple aspects');
  });

  it('implied-aspect-missing returns error when implied id has no aspect', async () => {
    const graph = createGraph({
      aspects: [
        { name: 'HIPAA', id: 'requires-hipaa', implies: ['requires-audit'], artifacts: [] },
      ],
    });
    graph.nodes.set('a', createNode('a'));

    const result = await validate(graph);
    const issues = result.issues.filter((i) => i.rule === 'implied-aspect-missing');
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe('implied-aspect-missing');
    expect(msgOf(issues[0])).toContain('HIPAA');
    expect(msgOf(issues[0])).toContain('requires-audit');
  });

  it('aspect-implies-cycle returns error when implies form cycle', async () => {
    const graph = createGraph({
      aspects: [
        { name: 'A', id: 'tag-a', implies: ['tag-b'], artifacts: [] },
        { name: 'B', id: 'tag-b', implies: ['tag-a'], artifacts: [] },
      ],
    });
    graph.nodes.set('a', createNode('a'));

    const result = await validate(graph);
    const issues = result.issues.filter((i) => i.rule === 'aspect-implies-cycle');
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe('aspect-implies-cycle');
    expect(msgOf(issues[0])).toContain('cycle');
    expect(msgOf(issues[0])).toContain('tag-a');
    expect(msgOf(issues[0])).toContain('tag-b');
  });

  it('checkSchemas: missing-schema when required schema is missing', async () => {
    const graph = createGraph();
    graph.schemas = [{ schemaType: 'node' }, { schemaType: 'aspect' }];
    // flow missing

    const result = await validate(graph);
    const issues = result.issues.filter((i) => i.rule === 'missing-schema');
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe('schema-missing');
    expect(msgOf(issues[0])).toContain('flow');
  });

  it('checkSchemas: no missing-schema when all 3 schemas present', async () => {
    const graph = createGraph();
    graph.schemas = [
      { schemaType: 'node' },
      { schemaType: 'aspect' },
      { schemaType: 'flow' },
    ];

    const result = await validate(graph);
    const issues = result.issues.filter((i) => i.rule === 'missing-schema');
    expect(issues).toHaveLength(0);
  });

  it('scoped validate returns parse error instead of "not found" for broken node', async () => {
    const graph = createGraph({
      nodeParseErrors: [
        { nodePath: 'broken/node', message: 'yg-node.yaml at broken/node/yg-node.yaml: file is empty' },
      ],
    });
    // The broken node is NOT in graph.nodes (it failed to parse)
    const result = await validate(graph, 'broken/node');
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].code).toBe('yaml-invalid');
    expect(result.issues[0].rule).toBe('invalid-node-yaml');
    expect(msgOf(result.issues[0])).toContain('empty');
  });

  it('scoped validate returns parse error for child of broken node', async () => {
    const graph = createGraph({
      nodeParseErrors: [
        { nodePath: 'broken', message: 'yg-node.yaml at broken/yg-node.yaml: file is empty' },
      ],
    });
    const result = await validate(graph, 'broken/child');
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].code).toBe('yaml-invalid');
  });

  it('wide-node warns when directory mapping resolves to many files', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-validator-wide-node');
    const srcDir = path.join(tmpDir, 'src', 'wide');
    const yggRoot = path.join(tmpDir, '.yggdrasil');
    const modelDir = path.join(yggRoot, 'model', 'wide');

    await mkdir(srcDir, { recursive: true });
    await mkdir(modelDir, { recursive: true });
    // Create 12 source files (exceeds default max of 10)
    for (let i = 0; i < 12; i++) {
      await writeFile(path.join(srcDir, `file${i}.ts`), `export const x${i} = ${i};`);
    }
    await writeFile(
      path.join(yggRoot, 'yg-config.yaml'),
      'version: "4.0.0"',
    );
    // Create an aspect so the node has effective aspects (nodes without aspects skip wide-node check)
    const aspDir = path.join(yggRoot, 'aspects', 'testing');
    await mkdir(aspDir, { recursive: true });
    await writeFile(path.join(aspDir, 'yg-aspect.yaml'), 'name: Testing\ndescription: test\n');
    await writeFile(path.join(aspDir, 'content.md'), 'Test rule.\n');
    await writeFile(
      path.join(modelDir, 'yg-node.yaml'),
      'name: Wide\ntype: service\ndescription: x\naspects:\n  - testing\nmapping:\n  - src/wide',
    );
    try {
      const graph = await loadGraph(tmpDir);
      const result = await validate(graph);
      const issues = result.issues.filter((i) => i.rule === 'wide-node');
      expect(issues).toHaveLength(1);
      expect(issues[0].code).toBe('wide-node');
      expect(issues[0].severity).toBe('warning');
      expect(msgOf(issues[0])).toContain('12 source files');
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  describe('missing-description', () => {
    it('missing-description emitted for a node without description', async () => {
      const graph = createGraph();
      graph.nodes.set('svc/no-desc', createNode('svc/no-desc'));

      const result = await validate(graph);
      const issues = result.issues.filter((i) => i.rule === 'missing-description' && i.nodePath === 'svc/no-desc');
      expect(issues).toHaveLength(1);
      expect(issues[0].code).toBe('description-missing');
      expect(issues[0].severity).toBe('error');
      expect(msgOf(issues[0])).toContain('no description');
    });

    it('no missing-description when node has description set', async () => {
      const graph = createGraph();
      graph.nodes.set('svc/with-desc', createNode('svc/with-desc', { description: 'A useful service.' }));

      const result = await validate(graph);
      const issues = result.issues.filter((i) => i.rule === 'missing-description' && i.nodePath === 'svc/with-desc');
      expect(issues).toHaveLength(0);
    });

    it('missing-description emitted for an aspect without description', async () => {
      const graph = createGraph({
        aspects: [{ name: 'NoDesc', id: 'no-desc-aspect', artifacts: [] }],
      });
      graph.nodes.set('a', createNode('a'));

      const result = await validate(graph);
      const issues = result.issues.filter(
        (i) => i.rule === 'missing-description' && msgOf(i).includes("'no-desc-aspect'"),
      );
      expect(issues).toHaveLength(1);
      expect(issues[0].code).toBe('description-missing');
      expect(issues[0].severity).toBe('error');
    });

    it('missing-description emitted for a flow without description', async () => {
      const graph = createGraph();
      graph.nodes.set('a', createNode('a'));
      graph.flows.push({
        path: 'checkout-flow',
        name: 'checkout-flow',
        nodes: ['a'],
      });

      const result = await validate(graph);
      const issues = result.issues.filter(
        (i) => i.rule === 'missing-description' && msgOf(i).includes("'checkout-flow'"),
      );
      expect(issues).toHaveLength(1);
      expect(issues[0].code).toBe('description-missing');
      expect(issues[0].severity).toBe('error');
    });
  });

  describe('Architecture Constraints', () => {
    it('invalid-relation-target when relation target type not allowed', async () => {
      const graph = createGraph({
        architecture: {
          node_types: {
            service: {
              description: 'A service',
              relations: { calls: ['service', 'module'] }, // can call service or module only
            },
            library: { description: 'A library' },
            module: { description: 'A module' },
          },
        },
      });
      graph.nodes.set('a', createNode('a', {
        type: 'service',
        relations: [{ target: 'b', type: 'calls' }],
      }));
      graph.nodes.set('b', createNode('b', { type: 'library' })); // library not in allowed list

      const result = await validate(graph);
      const relationTargetForbidden = result.issues.find(i => i.code === 'relation-target-forbidden' && i.nodePath === 'a');
      expect(relationTargetForbidden).toBeDefined();
      expect(msgOf(relationTargetForbidden!)).toContain('calls');
      expect(msgOf(relationTargetForbidden!)).toContain('library');
    });

    it('invalid-relation-target not fired when relation target type is allowed', async () => {
      const graph = createGraph({
        architecture: {
          node_types: {
            service: {
              description: 'A service',
              relations: { calls: ['service', 'module'] },
            },
            module: { description: 'A module' },
          },
        },
      });
      graph.nodes.set('a', createNode('a', {
        type: 'service',
        relations: [{ target: 'b', type: 'calls' }],
      }));
      graph.nodes.set('b', createNode('b', { type: 'module' }));

      const result = await validate(graph);
      const relationTargetForbidden = result.issues.find(i => i.code === 'relation-target-forbidden' && i.nodePath === 'a');
      expect(relationTargetForbidden).toBeUndefined();
    });

    it('invalid-parent-type when parent type not in allowed list', async () => {
      const parentNode = createNode('parent', { type: 'library' });
      const childNode = createNode('parent/child', { type: 'service' });
      childNode.parent = parentNode;

      const graph = createGraph({
        architecture: {
          node_types: {
            service: {
              description: 'A service',
              parents: ['module'], // only 'module' is allowed as parent
            },
            library: { description: 'A library' },
            module: { description: 'A module' },
          },
        },
      });
      graph.nodes.set('parent', parentNode);
      graph.nodes.set('parent/child', childNode);

      const result = await validate(graph);
      const parentTypeForbidden = result.issues.find(i => i.code === 'parent-type-forbidden' && i.nodePath === 'parent/child');
      expect(parentTypeForbidden).toBeDefined();
      expect(msgOf(parentTypeForbidden!)).toContain('library');
      expect(msgOf(parentTypeForbidden!)).toContain('service');
    });

    it('invalid-parent-type not fired when parent type is in allowed list', async () => {
      const parentNode = createNode('parent', { type: 'module' });
      const childNode = createNode('parent/child', { type: 'service' });
      childNode.parent = parentNode;

      const graph = createGraph({
        architecture: {
          node_types: {
            service: {
              description: 'A service',
              parents: ['module'],
            },
            module: { description: 'A module' },
          },
        },
      });
      graph.nodes.set('parent', parentNode);
      graph.nodes.set('parent/child', childNode);

      const result = await validate(graph);
      const parentTypeForbidden = result.issues.find(i => i.code === 'parent-type-forbidden' && i.nodePath === 'parent/child');
      expect(parentTypeForbidden).toBeUndefined();
    });

    it('integration-aspect-missing when consumer uses a port whose required aspect is not defined', async () => {
      const graph = createGraph({ aspects: [] }); // no aspects defined
      // Target node with a port that requires 'audit-logging'
      graph.nodes.set('target', createNode('target', {
        ports: { 'api': { description: 'API port', aspects: ['audit-logging'] } },
      }));
      // Consumer node with a relation that consumes the port
      graph.nodes.set('consumer', createNode('consumer', {
        relations: [{ target: 'target', type: 'uses', consumes: ['api'] }],
      }));

      const result = await validate(graph);
      const portMissingAspect = result.issues.filter(i => i.code === 'port-missing-aspect' && i.nodePath === 'consumer');
      expect(portMissingAspect).toHaveLength(1);
      expect(portMissingAspect[0].rule).toBe('integration-aspect-missing');
      expect(msgOf(portMissingAspect[0])).toContain('audit-logging');
      expect(msgOf(portMissingAspect[0])).toContain("port 'api'");
    });

    it('integration-aspect-missing not fired when consumer uses a port whose required aspect exists', async () => {
      const graph = createGraph({
        aspects: [{ name: 'Audit', id: 'audit-logging', artifacts: [] }],
      });
      graph.nodes.set('target', createNode('target', {
        ports: { 'api': { description: 'API port', aspects: ['audit-logging'] } },
      }));
      graph.nodes.set('consumer', createNode('consumer', {
        relations: [{ target: 'target', type: 'uses', consumes: ['api'] }],
      }));

      const result = await validate(graph);
      const portMissingAspect = result.issues.filter(i => i.code === 'port-missing-aspect' && i.nodePath === 'consumer');
      expect(portMissingAspect).toHaveLength(0);
    });

    it('integration-aspect-missing not fired when relation has no consumes field (no port consumption)', async () => {
      const graph = createGraph({ aspects: [] });
      graph.nodes.set('target', createNode('target', {
        ports: { 'api': { description: 'API port', aspects: ['audit-logging'] } },
      }));
      // Relation to target but no consumes — not consuming any port
      graph.nodes.set('consumer', createNode('consumer', {
        relations: [{ target: 'target', type: 'uses' }],
      }));

      const result = await validate(graph);
      const portMissingAspect = result.issues.filter(i => i.code === 'port-missing-aspect' && i.nodePath === 'consumer');
      expect(portMissingAspect).toHaveLength(0);
    });

    it('skips architecture checks when architecture is empty', async () => {
      const graph = createGraph({
        architecture: { node_types: {} }, // empty architecture
      });
      graph.nodes.set('a', createNode('a', {
        type: 'unknown-type',
        relations: [{ target: 'b', type: 'unknown-rel' as any }],
      }));

      const result = await validate(graph);
      const archErrors = result.issues.filter(i => i.code !== undefined && ['aspect-undefined', 'relation-target-forbidden', 'parent-type-forbidden', 'port-missing-aspect'].includes(i.code));
      // Should skip architecture checks when architecture has no node_types (fallback case)
      expect(archErrors.length).toBe(0);
    });
  });

  describe('missing-consumes', () => {
    it('fires when relation target has ports but consumer has no consumes', async () => {
      const graph = createGraph({
        aspects: [{ name: 'Audit', id: 'valid-tag', artifacts: [] }],
      });
      graph.nodes.set('provider', createNode('provider', {
        ports: { charge: { description: 'Pay', aspects: ['valid-tag'] } },
      }));
      graph.nodes.set('consumer', createNode('consumer', {
        relations: [{ target: 'provider', type: 'calls' }],
      }));

      const result = await validate(graph);
      const portMissingConsumes = result.issues.filter(i => i.code === 'port-missing-consumes');
      expect(portMissingConsumes).toContainEqual(expect.objectContaining({
        code: 'port-missing-consumes', rule: 'missing-consumes',
      }));
    });

    it('does not fire when target has empty ports (ports: {})', async () => {
      const graph = createGraph();
      graph.nodes.set('provider', createNode('provider', { ports: {} }));
      graph.nodes.set('consumer', createNode('consumer', {
        relations: [{ target: 'provider', type: 'calls' }],
      }));

      const result = await validate(graph);
      expect(result.issues.filter(i => i.code === 'port-missing-consumes')).toHaveLength(0);
    });

    it('does not fire when target has no ports', async () => {
      const graph = createGraph();
      graph.nodes.set('provider', createNode('provider'));
      graph.nodes.set('consumer', createNode('consumer', {
        relations: [{ target: 'provider', type: 'calls' }],
      }));

      const result = await validate(graph);
      expect(result.issues.filter(i => i.code === 'port-missing-consumes')).toHaveLength(0);
    });

    it('does not fire when consumer has consumes field', async () => {
      const graph = createGraph({
        aspects: [{ name: 'Audit', id: 'valid-tag', artifacts: [] }],
      });
      graph.nodes.set('provider', createNode('provider', {
        ports: { charge: { description: 'Pay', aspects: ['valid-tag'] } },
      }));
      graph.nodes.set('consumer', createNode('consumer', {
        relations: [{ target: 'provider', type: 'calls', consumes: ['charge'] }],
      }));

      const result = await validate(graph);
      expect(result.issues.filter(i => i.code === 'port-missing-consumes')).toHaveLength(0);
    });

    it('does not fire for emits/listens relations even when target has ports', async () => {
      const graph = createGraph({
        aspects: [{ name: 'Audit', id: 'valid-tag', artifacts: [] }],
      });
      graph.nodes.set('provider', createNode('provider', {
        ports: { charge: { description: 'Pay', aspects: ['valid-tag'] } },
      }));
      graph.nodes.set('emitter', createNode('emitter', {
        relations: [{ target: 'provider', type: 'emits' }],
      }));
      graph.nodes.set('listener', createNode('listener', {
        relations: [{ target: 'provider', type: 'listens' }],
      }));

      const result = await validate(graph);
      expect(result.issues.filter(i => i.code === 'port-missing-consumes')).toHaveLength(0);
    });
  });

  describe('unknown-port', () => {
    it('fires when consumes references non-existent port', async () => {
      const graph = createGraph({
        aspects: [{ name: 'Audit', id: 'valid-tag', artifacts: [] }],
      });
      graph.nodes.set('provider', createNode('provider', {
        ports: { charge: { description: 'Pay', aspects: ['valid-tag'] } },
      }));
      graph.nodes.set('consumer', createNode('consumer', {
        relations: [{ target: 'provider', type: 'calls', consumes: ['nonexistent'] }],
      }));

      const result = await validate(graph);
      expect(result.issues).toContainEqual(expect.objectContaining({
        code: 'port-undefined', rule: 'unknown-port',
      }));
    });

    it('does not fire when consumes references a valid port', async () => {
      const graph = createGraph({
        aspects: [{ name: 'Audit', id: 'valid-tag', artifacts: [] }],
      });
      graph.nodes.set('provider', createNode('provider', {
        ports: { charge: { description: 'Pay', aspects: ['valid-tag'] } },
      }));
      graph.nodes.set('consumer', createNode('consumer', {
        relations: [{ target: 'provider', type: 'calls', consumes: ['charge'] }],
      }));

      const result = await validate(graph);
      expect(result.issues.filter(i => i.code === 'port-undefined')).toHaveLength(0);
    });
  });

  describe('consumes-without-ports', () => {
    it('fires when relation has consumes but target has no ports', async () => {
      const graph = createGraph();
      // Provider has NO ports
      graph.nodes.set('provider', createNode('provider'));
      graph.nodes.set('consumer', createNode('consumer', {
        relations: [{ target: 'provider', type: 'calls', consumes: ['some-port'] }],
      }));

      const result = await validate(graph);
      expect(result.issues).toContainEqual(expect.objectContaining({
        code: 'consumes-without-ports', rule: 'consumes-without-ports',
      }));
    });

    it('does not fire when relation has consumes and target has ports', async () => {
      const graph = createGraph({
        aspects: [{ name: 'Audit', id: 'valid-tag', artifacts: [] }],
      });
      // Provider HAS ports
      graph.nodes.set('provider', createNode('provider', {
        ports: { charge: { description: 'Pay', aspects: ['valid-tag'] } },
      }));
      graph.nodes.set('consumer', createNode('consumer', {
        relations: [{ target: 'provider', type: 'calls', consumes: ['charge'] }],
      }));

      const result = await validate(graph);
      expect(result.issues.filter(i => i.code === 'consumes-without-ports')).toHaveLength(0);
    });
  });

  describe('orphaned-aspect', () => {
    it('fires when aspect is not used by any node, architecture, or flow', async () => {
      const graph = createGraph({
        aspects: [
          { name: 'Valid', id: 'valid-tag', description: 'Referenced', artifacts: [] },
          { name: 'Orphan', id: 'orphan-aspect', description: 'Never used', artifacts: [] },
        ],
      });
      graph.nodes.set('a', createNode('a', { aspects: ['valid-tag'] }));

      const result = await validate(graph);
      const w006 = result.issues.filter(i => i.code === 'orphaned-aspect');
      expect(w006).toContainEqual(expect.objectContaining({
        code: 'orphaned-aspect', rule: 'orphaned-aspect',
      }));
      // 'valid-tag' is referenced so should not appear
      expect(w006.every(i => !msgOf(i).includes('valid-tag'))).toBe(true);
    });

    it('does not fire when aspect is referenced by a node', async () => {
      const graph = createGraph({
        aspects: [{ name: 'Used', id: 'valid-tag', description: 'Used', artifacts: [] }],
      });
      graph.nodes.set('a', createNode('a', { aspects: ['valid-tag'] }));

      const result = await validate(graph);
      expect(result.issues.filter(i => i.code === 'orphaned-aspect')).toHaveLength(0);
    });

    it('does not fire when aspect is referenced by a port', async () => {
      const graph = createGraph({
        aspects: [{ name: 'Used', id: 'valid-tag', description: 'Used', artifacts: [] }],
      });
      graph.nodes.set('a', createNode('a', {
        ports: { api: { description: 'API', aspects: ['valid-tag'] } },
      }));

      const result = await validate(graph);
      expect(result.issues.filter(i => i.code === 'orphaned-aspect')).toHaveLength(0);
    });

    it('does not fire when aspect is referenced by a flow', async () => {
      const graph = createGraph({
        aspects: [{ name: 'Used', id: 'valid-tag', description: 'Used', artifacts: [] }],
      });
      graph.nodes.set('a', createNode('a'));
      graph.flows.push({
        path: 'checkout-flow',
        name: 'Checkout',
        nodes: ['a'],
        aspects: ['valid-tag'],
      });

      const result = await validate(graph);
      expect(result.issues.filter(i => i.code === 'orphaned-aspect')).toHaveLength(0);
    });

    it('does not fire for implied aspects when the implying aspect is referenced', async () => {
      const graph = createGraph({
        aspects: [
          { name: 'HIPAA', id: 'hipaa', description: 'Used', implies: ['audit'], artifacts: [] },
          { name: 'Audit', id: 'audit', description: 'Implied', artifacts: [] },
        ],
      });
      graph.nodes.set('a', createNode('a', { aspects: ['hipaa'] }));

      const result = await validate(graph);
      expect(result.issues.filter(i => i.code === 'orphaned-aspect')).toHaveLength(0);
    });
  });

  describe('validator — when schema checks', () => {
    it('reports unknown target_type in global when', async () => {
      const graph = createGraph({
        architecture: { node_types: { command: { description: 'cmd' } } },
        aspects: [{
          name: 'X', id: 'x', artifacts: [],
          when: { relations: { calls: { target_type: 'srvc-client' } } },
        }],
      });
      const result = await validate(graph);
      expect(result.issues.some(i =>
        i.code === 'when-unknown-type' && /srvc-client/.test(msgOf(i))
      )).toBe(true);
    });

    it('reports unknown target node path in when', async () => {
      const node = createNode('svc', { type: 'command' });
      const graph = createGraph({
        nodes: new Map([['svc', node]]),
        architecture: { node_types: { command: { description: 'cmd' } } },
        aspects: [{
          name: 'X', id: 'x', artifacts: [],
          when: { relations: { calls: { target: 'ghost/node' } } },
        }],
      });
      const result = await validate(graph);
      expect(result.issues.some(i =>
        i.code === 'when-unknown-node' && /ghost\/node/.test(msgOf(i))
      )).toBe(true);
    });

    it('reports unknown consumes_port on referenced target', async () => {
      const target = createNode('pay', {
        type: 'service',
        ports: { charge: { description: 'c', aspects: [] } },
      });
      const graph = createGraph({
        nodes: new Map([['pay', target]]),
        architecture: {
          node_types: { command: { description: 'cmd' }, service: { description: 'svc' } },
        },
        aspects: [{
          name: 'X', id: 'x', artifacts: [],
          when: { relations: { calls: { target: 'pay', consumes_port: 'refund' } } },
        }],
      });
      const result = await validate(graph);
      expect(result.issues.some(i =>
        i.code === 'when-unknown-port' && /refund/.test(msgOf(i))
      )).toBe(true);
    });

    it('allows when referencing a target_type when type exists', async () => {
      const graph = createGraph({
        architecture: {
          node_types: {
            command: { description: 'cmd' },
            'service-client': { description: 'svc-client' },
          },
        },
        aspects: [{
          name: 'X', id: 'x', artifacts: [],
          when: { relations: { calls: { target_type: 'service-client' } } },
        }],
      });
      const result = await validate(graph);
      expect(result.issues.some(i => i.code?.startsWith('when-'))).toBe(false);
    });

    it('validates when predicate inside flow aspectWhens', async () => {
      const graph = createGraph({
        architecture: { node_types: { command: { description: 'cmd' } } },
        aspects: [{ name: 'X', id: 'x', artifacts: [] }],
        flows: [{
          path: 'checkout',
          name: 'Checkout',
          description: 'flow',
          nodes: [],
          aspects: [],
          aspectWhens: { x: { relations: { calls: { target_type: 'ghost-type' } } } },
        }],
      });
      const result = await validate(graph);
      expect(result.issues.some(i =>
        i.code === 'when-unknown-type' && /ghost-type/.test(msgOf(i))
      )).toBe(true);
    });
  });

  describe('CLI exit codes', () => {
    it('exit code 0 when no errors', () => {
      const fixturePath = path.resolve(CLI_ROOT, 'tests', 'fixtures', 'sample-project');
      const binPath = path.resolve(CLI_ROOT, 'dist', 'bin.js');
      const result = spawnSync('node', [binPath, 'validate'], {
        cwd: fixturePath,
        encoding: 'utf-8',
      });

      if (result.error?.message?.includes('ENOENT')) {
        return;
      }

      expect(result.status).toBe(0);
    });

    it('exit code 1 when errors exist', () => {
      const fixturePath = path.resolve(CLI_ROOT, 'tests', 'fixtures', 'sample-project-orphan-dir');
      const binPath = path.resolve(CLI_ROOT, 'dist', 'bin.js');
      const result = spawnSync('node', [binPath, 'validate'], {
        cwd: fixturePath,
        encoding: 'utf-8',
      });

      if (result.error?.message?.includes('ENOENT')) {
        return;
      }

      expect(result.status).toBe(1);
    });
  });
});

describe('checkTypeWithoutWhenWithMapping', () => {
  it('emits error when node of type without when has non-empty mapping', async () => {
    const node = createNode('foo/bar', { type: 'module', mapping: ['src/foo.ts'] });
    const graph = createGraph({
      architecture: { node_types: { module: { description: 'Grouping' } } },
      nodes: new Map([['foo/bar', node]]),
    });
    const result = await validate(graph);
    const offending = result.issues.find((i) => i.code === 'type-without-when-with-mapping');
    expect(offending).toBeDefined();
    expect(offending?.nodePath).toBe('foo/bar');
  });

  it('does not emit when node of type without when has empty mapping', async () => {
    const node = createNode('foo/bar', { type: 'module', mapping: [] });
    const graph = createGraph({
      architecture: { node_types: { module: { description: 'Grouping' } } },
      nodes: new Map([['foo/bar', node]]),
    });
    const result = await validate(graph);
    expect(result.issues.find((i) => i.code === 'type-without-when-with-mapping')).toBeUndefined();
  });

  it('does not emit when node of type with when has mapping', async () => {
    const node = createNode('foo/bar', { type: 'command', mapping: ['src/foo.ts'] });
    const graph = createGraph({
      architecture: {
        node_types: { command: { description: 'CLI', when: { path: '**' } } },
      },
      nodes: new Map([['foo/bar', node]]),
    });
    const result = await validate(graph);
    expect(result.issues.find((i) => i.code === 'type-without-when-with-mapping')).toBeUndefined();
  });
});

describe('validator — pipeline short-circuit', () => {
  it('short-circuits per-node and global stages on architecture-level error', async () => {
    const graph = createGraph({
      architecture: {
        node_types: {
          a: { description: 'A', parents: ['nonexistent_type'] },
        },
      },
    });
    const result = await validate(graph);
    const codes = new Set(result.issues.map((i) => i.code));
    expect(codes.has('type-unknown-parent')).toBe(true);
    expect(codes.has('type-when-mismatch')).toBe(false);
    expect(codes.has('type-strict-orphan')).toBe(false);
  });

  it('description-missing on aspect fires even when architecture has fatal error', async () => {
    const graph = createGraph({
      architecture: {
        node_types: {
          a: { description: 'A', parents: ['nonexistent_type'] },
        },
      },
      aspects: [{ name: 'broken-aspect', id: 'broken-aspect', artifacts: [] }],
    });
    const result = await validate(graph);
    const codes = new Set(result.issues.map((i) => i.code));
    expect(codes.has('type-unknown-parent')).toBe(true);
    expect(codes.has('description-missing')).toBe(true);
  });

  it('returns architecture-invalid for string architectureError', async () => {
    const graph = createGraph({ architectureError: 'yg-architecture.yaml: bad syntax' });
    const result = await validate(graph);
    expect(result.nodesScanned).toBe(0);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].code).toBe('architecture-invalid');
  });

  it('returns when-predicate-invalid for structured architectureError', async () => {
    const graph = createGraph({
      architectureError: { code: 'when-predicate-invalid', message: 'unknown key: foo' },
    });
    const result = await validate(graph);
    expect(result.nodesScanned).toBe(0);
    expect(result.issues[0].code).toBe('when-predicate-invalid');
  });

  it('does not short-circuit when all parent types exist', async () => {
    const graph = createGraph({
      architecture: {
        node_types: {
          module: { description: 'Module' },
          service: { description: 'Service', parents: ['module'] },
        },
      },
    });
    const result = await validate(graph);
    const codes = new Set(result.issues.map((i) => i.code));
    expect(codes.has('type-unknown-parent')).toBe(false);
    expect(result.nodesScanned).toBeGreaterThanOrEqual(0);
  });
});

describe('checkArchitectureParentCycles', () => {
  it('emits error for unresolvable cycle (a→b→a)', async () => {
    const graph = createGraph({
      architecture: {
        node_types: {
          a: { description: 'A', parents: ['b'] },
          b: { description: 'B', parents: ['a'] },
        },
      },
    });
    const result = await validate(graph);
    expect(result.issues.find((i) => i.code === 'architecture-cycle')).toBeDefined();
  });

  it('allows self-loop with alternative parent (escape path exists)', async () => {
    const graph = createGraph({
      architecture: {
        node_types: {
          module: { description: 'Mod', parents: ['module', 'root'] },
          root: { description: 'Root' },
        },
      },
    });
    const result = await validate(graph);
    expect(result.issues.find((i) => i.code === 'architecture-cycle')).toBeUndefined();
  });

  it('emits error for self-loop without alternative parent', async () => {
    const graph = createGraph({
      architecture: {
        node_types: {
          module: { description: 'Mod', parents: ['module'] },
        },
      },
    });
    const result = await validate(graph);
    expect(result.issues.find((i) => i.code === 'architecture-cycle')).toBeDefined();
  });

  it('allows three-way chain with rootable end', async () => {
    const graph = createGraph({
      architecture: {
        node_types: {
          a: { description: 'A', parents: ['b'] },
          b: { description: 'B', parents: ['a', 'c'] },
          c: { description: 'C' },
        },
      },
    });
    const result = await validate(graph);
    expect(result.issues.find((i) => i.code === 'architecture-cycle')).toBeUndefined();
  });
});

describe('checkEnforceStrictWithoutWhen', () => {
  it('emits error when type has enforce: strict without when', async () => {
    const graph = createGraph({
      architecture: {
        node_types: {
          command: { description: 'CLI', enforce: 'strict' },
        },
      },
    });
    const result = await validate(graph);
    expect(result.issues.find((i) => i.code === 'enforce-strict-without-when')).toBeDefined();
  });

  it('does not emit when enforce: strict has when', async () => {
    const graph = createGraph({
      architecture: {
        node_types: {
          command: { description: 'CLI', enforce: 'strict', when: { path: '**' } },
        },
      },
    });
    const result = await validate(graph);
    expect(result.issues.find((i) => i.code === 'enforce-strict-without-when')).toBeUndefined();
  });
});

describe('checkTypeWhenMismatch', () => {
  it('emits type-when-mismatch when file does not satisfy type when predicate', async () => {
    const tmpDir = path.join(CLI_ROOT, '.temp-test-when-mismatch');
    try {
      const yggDir = path.join(tmpDir, '.yggdrasil');
      await mkdir(path.join(yggDir, 'model', 'svc'), { recursive: true });
      await mkdir(path.join(tmpDir, 'src'), { recursive: true });
      await writeFile(path.join(tmpDir, 'src', 'handler.ts'), 'export function handler() {}');
      await writeFile(path.join(yggDir, 'yg-config.yaml'), 'version: "4.3.0"\n');
      await writeFile(path.join(yggDir, 'yg-architecture.yaml'), [
        'node_types:',
        '  service:',
        '    description: Service',
        '    when:',
        '      content: "@Injectable"',
      ].join('\n'));
      await writeFile(path.join(yggDir, 'model', 'svc', 'yg-node.yaml'), [
        'name: svc',
        'type: service',
        'description: x',
        'mapping:',
        '  - src/handler.ts',
      ].join('\n'));
      const graph = await loadGraph(tmpDir);
      const result = await validate(graph);
      expect(result.issues.find((i) => i.code === 'type-when-mismatch')).toBeDefined();
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('does not emit type-when-mismatch when file satisfies type when predicate', async () => {
    const tmpDir = path.join(CLI_ROOT, '.temp-test-when-match');
    try {
      const yggDir = path.join(tmpDir, '.yggdrasil');
      await mkdir(path.join(yggDir, 'model', 'svc'), { recursive: true });
      await mkdir(path.join(tmpDir, 'src'), { recursive: true });
      await writeFile(path.join(tmpDir, 'src', 'handler.ts'), '@Injectable()\nexport class SvcService {}');
      await writeFile(path.join(yggDir, 'yg-config.yaml'), 'version: "4.3.0"\n');
      await writeFile(path.join(yggDir, 'yg-architecture.yaml'), [
        'node_types:',
        '  service:',
        '    description: Service',
        '    when:',
        '      content: "@Injectable"',
      ].join('\n'));
      await writeFile(path.join(yggDir, 'model', 'svc', 'yg-node.yaml'), [
        'name: svc',
        'type: service',
        'description: x',
        'mapping:',
        '  - src/handler.ts',
      ].join('\n'));
      const graph = await loadGraph(tmpDir);
      const result = await validate(graph);
      expect(result.issues.find((i) => i.code === 'type-when-mismatch')).toBeUndefined();
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('does not emit type-when-mismatch when type has no when predicate', async () => {
    const graph = createGraph({
      architecture: {
        node_types: {
          module: { description: 'Module' },
        },
      },
    });
    const result = await validate(graph);
    expect(result.issues.find((i) => i.code === 'type-when-mismatch')).toBeUndefined();
  });

  it('emits file-unreadable (not type-when-mismatch) when content predicate cannot read file', async () => {
    const tmpDir = path.join(CLI_ROOT, '.temp-test-file-unreadable');
    try {
      const yggDir = path.join(tmpDir, '.yggdrasil');
      await mkdir(path.join(yggDir, 'model', 'svc'), { recursive: true });
      await mkdir(path.join(tmpDir, 'src'), { recursive: true });
      await writeFile(path.join(yggDir, 'yg-config.yaml'), 'version: "4.3.0"\n');
      await writeFile(path.join(yggDir, 'yg-architecture.yaml'), [
        'node_types:',
        '  service:',
        '    description: Service',
        '    when:',
        '      content: "@Injectable"',
      ].join('\n'));
      await writeFile(path.join(yggDir, 'model', 'svc', 'yg-node.yaml'), [
        'name: svc',
        'type: service',
        'description: x',
        'mapping:',
        '  - src/ghost.ts',
      ].join('\n'));
      // src/ghost.ts intentionally NOT created — stat() fails → unreadable
      const graph = await loadGraph(tmpDir);
      const result = await validate(graph);
      const codes = new Set(result.issues.map((i) => i.code));
      expect(codes.has('file-unreadable')).toBe(true);
      expect(codes.has('type-when-mismatch')).toBe(false);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('checkFileMappingGitignored', () => {
  it('emits error for gitignored file in mapping', async () => {
    const tmpDir = path.join(CLI_ROOT, '.temp-test-gitignored');
    try {
      const yggDir = path.join(tmpDir, '.yggdrasil');
      await mkdir(path.join(yggDir, 'model', 'svc'), { recursive: true });
      await mkdir(path.join(tmpDir, 'src'), { recursive: true });
      await writeFile(path.join(tmpDir, '.gitignore'), 'src/generated.ts\n');
      await writeFile(path.join(tmpDir, 'src', 'generated.ts'), 'export const x = 1;');
      await writeFile(path.join(yggDir, 'yg-config.yaml'), 'version: "4.3.0"\n');
      await writeFile(path.join(yggDir, 'yg-architecture.yaml'), [
        'node_types:',
        '  service:',
        '    description: Service',
        '    when:',
        '      path: "**"',
      ].join('\n'));
      await writeFile(path.join(yggDir, 'model', 'svc', 'yg-node.yaml'), [
        'name: svc',
        'type: service',
        'description: x',
        'mapping:',
        '  - src/generated.ts',
      ].join('\n'));
      const graph = await loadGraph(tmpDir);
      const result = await validate(graph);
      expect(result.issues.find((i) => i.code === 'file-mapping-gitignored')).toBeDefined();
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('emits error for cascading-gitignored file', async () => {
    const tmpDir = path.join(CLI_ROOT, '.temp-test-cascading-gitignored');
    try {
      const yggDir = path.join(tmpDir, '.yggdrasil');
      await mkdir(path.join(yggDir, 'model', 'svc'), { recursive: true });
      await mkdir(path.join(tmpDir, 'src', 'sub'), { recursive: true });
      await writeFile(path.join(tmpDir, 'src', 'sub', '.gitignore'), 'local.ts\n');
      await writeFile(path.join(tmpDir, 'src', 'sub', 'local.ts'), 'export const y = 2;');
      await writeFile(path.join(yggDir, 'yg-config.yaml'), 'version: "4.3.0"\n');
      await writeFile(path.join(yggDir, 'yg-architecture.yaml'), [
        'node_types:',
        '  service:',
        '    description: Service',
        '    when:',
        '      path: "**"',
      ].join('\n'));
      await writeFile(path.join(yggDir, 'model', 'svc', 'yg-node.yaml'), [
        'name: svc',
        'type: service',
        'description: x',
        'mapping:',
        '  - src/sub/local.ts',
      ].join('\n'));
      const graph = await loadGraph(tmpDir);
      const result = await validate(graph);
      expect(result.issues.find((i) => i.code === 'file-mapping-gitignored')).toBeDefined();
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('does not emit for non-gitignored file', async () => {
    const tmpDir = path.join(CLI_ROOT, '.temp-test-not-gitignored');
    try {
      const yggDir = path.join(tmpDir, '.yggdrasil');
      await mkdir(path.join(yggDir, 'model', 'svc'), { recursive: true });
      await mkdir(path.join(tmpDir, 'src'), { recursive: true });
      await writeFile(path.join(tmpDir, 'src', 'handler.ts'), 'export function handle() {}');
      await writeFile(path.join(yggDir, 'yg-config.yaml'), 'version: "4.3.0"\n');
      await writeFile(path.join(yggDir, 'yg-architecture.yaml'), [
        'node_types:',
        '  service:',
        '    description: Service',
        '    when:',
        '      path: "**"',
      ].join('\n'));
      await writeFile(path.join(yggDir, 'model', 'svc', 'yg-node.yaml'), [
        'name: svc',
        'type: service',
        'description: x',
        'mapping:',
        '  - src/handler.ts',
      ].join('\n'));
      const graph = await loadGraph(tmpDir);
      const result = await validate(graph);
      expect(result.issues.find((i) => i.code === 'file-mapping-gitignored')).toBeUndefined();
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('checkStrictBackwardCoverage', () => {
  async function makeStrictGraph(tmpDir: string, opts: {
    fileContent: string;
    mappedTo?: { type: string; nodePath: string };
  }) {
    const yggDir = path.join(tmpDir, '.yggdrasil');
    await mkdir(path.join(yggDir, 'model', 'svc'), { recursive: true });
    await mkdir(path.join(tmpDir, 'src'), { recursive: true });
    await writeFile(path.join(tmpDir, 'src', 'handler.ts'), opts.fileContent);
    await writeFile(path.join(yggDir, 'yg-config.yaml'), 'version: "4.3.0"\n');
    const archLines = [
      'node_types:',
      '  command:',
      '    description: Command',
      '    enforce: strict',
      '    when:',
      '      content: "registerCommand"',
    ];
    if (opts.mappedTo) {
      archLines.push(...[
        '  utility:',
        '    description: Utility',
        '    when:',
        '      path: "**"',
      ]);
    }
    await writeFile(path.join(yggDir, 'yg-architecture.yaml'), archLines.join('\n'));
    if (opts.mappedTo) {
      await mkdir(path.join(yggDir, 'model', opts.mappedTo.nodePath.split('/')[0], opts.mappedTo.nodePath.split('/').slice(1).join('/')), { recursive: true }).catch(() => {});
      await mkdir(path.join(yggDir, 'model', ...opts.mappedTo.nodePath.split('/')), { recursive: true });
      await writeFile(path.join(yggDir, 'model', ...opts.mappedTo.nodePath.split('/'), 'yg-node.yaml'), [
        `name: ${opts.mappedTo.nodePath.split('/').pop()}`,
        `type: ${opts.mappedTo.type}`,
        'description: x',
        'mapping:',
        '  - src/handler.ts',
      ].join('\n'));
    }
    return loadGraph(tmpDir);
  }

  it('emits type-strict-orphan for matching file not in any mapping', async () => {
    const tmpDir = path.join(CLI_ROOT, '.temp-test-strict-orphan');
    try {
      const graph = await makeStrictGraph(tmpDir, { fileContent: 'registerCommand("foo");' });
      const result = await validate(graph);
      expect(result.issues.find((i) => i.code === 'type-strict-orphan')).toBeDefined();
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('emits type-strict-misplaced when matching file mapped to wrong type', async () => {
    const tmpDir = path.join(CLI_ROOT, '.temp-test-strict-misplaced');
    try {
      const graph = await makeStrictGraph(tmpDir, {
        fileContent: 'registerCommand("bar");',
        mappedTo: { type: 'utility', nodePath: 'util' },
      });
      const result = await validate(graph);
      expect(result.issues.find((i) => i.code === 'type-strict-misplaced')).toBeDefined();
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('does not emit when matching file is in correct strict-type node', async () => {
    const tmpDir = path.join(CLI_ROOT, '.temp-test-strict-ok');
    try {
      const yggDir = path.join(tmpDir, '.yggdrasil');
      await mkdir(path.join(yggDir, 'model', 'cmd'), { recursive: true });
      await mkdir(path.join(tmpDir, 'src'), { recursive: true });
      await writeFile(path.join(tmpDir, 'src', 'handler.ts'), 'registerCommand("baz");');
      await writeFile(path.join(yggDir, 'yg-config.yaml'), 'version: "4.3.0"\n');
      await writeFile(path.join(yggDir, 'yg-architecture.yaml'), [
        'node_types:',
        '  command:',
        '    description: Command',
        '    enforce: strict',
        '    when:',
        '      content: "registerCommand"',
      ].join('\n'));
      await writeFile(path.join(yggDir, 'model', 'cmd', 'yg-node.yaml'), [
        'name: cmd',
        'type: command',
        'description: x',
        'mapping:',
        '  - src/handler.ts',
      ].join('\n'));
      const graph = await loadGraph(tmpDir);
      const result = await validate(graph);
      expect(result.issues.find((i) => i.code === 'type-strict-orphan')).toBeUndefined();
      expect(result.issues.find((i) => i.code === 'type-strict-misplaced')).toBeUndefined();
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('checkStrictOverlapConflict', () => {
  async function makeOverlapGraph(tmpDir: string, typeCount: number) {
    const yggDir = path.join(tmpDir, '.yggdrasil');
    await mkdir(path.join(yggDir, 'model', 'dummy'), { recursive: true });
    await mkdir(path.join(tmpDir, 'src'), { recursive: true });
    await writeFile(path.join(tmpDir, 'src', 'foo.ts'), 'anything', 'utf-8');
    await writeFile(path.join(yggDir, 'yg-config.yaml'), 'version: "4.3.0"\n');
    const lines = ['node_types:'];
    for (let i = 0; i < typeCount; i++) {
      lines.push(`  type${i}:`, '    description: x', '    enforce: strict', '    when:', '      path: "**"');
    }
    await writeFile(path.join(yggDir, 'yg-architecture.yaml'), lines.join('\n'));
    await writeFile(path.join(yggDir, 'model', 'dummy', 'yg-node.yaml'), [
      'name: dummy', 'type: type0', 'description: x',
    ].join('\n'));
    return loadGraph(tmpDir);
  }

  it('emits strict-overlap-conflict when two strict types match same file', async () => {
    const tmpDir = path.join(CLI_ROOT, '.temp-test-strict-overlap-2');
    try {
      const graph = await makeOverlapGraph(tmpDir, 2);
      const result = await validate(graph);
      expect(result.issues.find((i) => i.code === 'strict-overlap-conflict')).toBeDefined();
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('emits N-choose-2 pairs when 3 strict types all overlap', async () => {
    const tmpDir = path.join(CLI_ROOT, '.temp-test-strict-overlap-3');
    try {
      const graph = await makeOverlapGraph(tmpDir, 3);
      const result = await validate(graph);
      const conflicts = result.issues.filter((i) => i.code === 'strict-overlap-conflict');
      expect(conflicts.length).toBe(3);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('emits one error per pair not per file (deduplication)', async () => {
    const tmpDir = path.join(CLI_ROOT, '.temp-test-strict-overlap-dedup');
    try {
      const yggDir = path.join(tmpDir, '.yggdrasil');
      await mkdir(path.join(yggDir, 'model', 'dummy'), { recursive: true });
      await mkdir(path.join(tmpDir, 'src'), { recursive: true });
      await writeFile(path.join(tmpDir, 'src', 'a.ts'), 'aaa', 'utf-8');
      await writeFile(path.join(tmpDir, 'src', 'b.ts'), 'bbb', 'utf-8');
      await writeFile(path.join(yggDir, 'yg-config.yaml'), 'version: "4.3.0"\n');
      await writeFile(path.join(yggDir, 'yg-architecture.yaml'), [
        'node_types:',
        '  typeA:', '    description: x', '    enforce: strict', '    when:', '      path: "**"',
        '  typeB:', '    description: y', '    enforce: strict', '    when:', '      path: "**"',
      ].join('\n'));
      await writeFile(path.join(yggDir, 'model', 'dummy', 'yg-node.yaml'), [
        'name: dummy', 'type: typeA', 'description: x',
      ].join('\n'));
      const graph = await loadGraph(tmpDir);
      const result = await validate(graph);
      const conflicts = result.issues.filter((i) => i.code === 'strict-overlap-conflict');
      // 2 files both match same pair (typeA, typeB) → exactly 1 conflict error, not 2
      expect(conflicts.length).toBe(1);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});
