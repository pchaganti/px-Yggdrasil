import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectTrackedFiles } from '../../../src/core/graph/files.js';
import { loadGraph } from '../../../src/core/graph-loader.js';
import type { Graph, GraphNode } from '../../../src/model/graph.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PROJECT = path.join(__dirname, '../../fixtures/sample-project');

describe('collectTrackedFiles', () => {
  it('records own metadata in the typed identity (ownSubset hash)', async () => {
    const graph = await loadGraph(FIXTURE_PROJECT);
    const node = graph.nodes.get('orders/order-service')!;
    const { identity } = collectTrackedFiles(node, graph);

    // Own yg-node.yaml subset is tracked as the identity.ownSubset hash, not a file.
    expect(identity.ownSubset).toMatch(/^[a-f0-9]{64}$/);
  });

  it('includes parent yg-node.yaml', async () => {
    const graph = await loadGraph(FIXTURE_PROJECT);
    const node = graph.nodes.get('orders/order-service')!;
    const { trackedFiles } = collectTrackedFiles(node, graph);
    const paths = trackedFiles.map((f) => f.path);

    expect(paths).toContain('.yggdrasil/model/orders/yg-node.yaml');
  });

  it('records aspect meta in identity and tracks the content.md artifact', async () => {
    const graph = await loadGraph(FIXTURE_PROJECT);
    const node = graph.nodes.get('orders/order-service')!;
    const { trackedFiles, identity } = collectTrackedFiles(node, graph);
    const paths = trackedFiles.map((f) => f.path);

    // requires-audit aspect: definition metadata (status-stripped) lives in
    // identity.aspects[id].meta, NOT as a tracked file; the content.md artifact
    // IS a tracked file; the raw yg-aspect.yaml is not.
    expect(identity.aspects['requires-audit']?.meta).toMatch(/^[a-f0-9]{64}$/);
    expect(paths).not.toContain('.yggdrasil/aspects/requires-audit/yg-aspect.yaml');
    expect(paths).toContain('.yggdrasil/aspects/requires-audit/content.md');
  });

  it('includes source files from mapping', async () => {
    const graph = await loadGraph(FIXTURE_PROJECT);
    const node = graph.nodes.get('orders/order-service')!;
    const { trackedFiles } = collectTrackedFiles(node, graph);
    const paths = trackedFiles.map((f) => f.path);

    expect(paths).toContain('src/orders/order.service.ts');
  });

  it('categorizes tracked files as source or graph (real paths only)', async () => {
    const graph = await loadGraph(FIXTURE_PROJECT);
    const node = graph.nodes.get('orders/order-service')!;
    const { trackedFiles } = collectTrackedFiles(node, graph);

    const sourceFiles = trackedFiles.filter((f) => f.category === 'source');
    const graphFiles = trackedFiles.filter((f) => f.category === 'graph');

    // Source files should not start with .yggdrasil/
    for (const f of sourceFiles) {
      expect(f.path).not.toMatch(/^\.yggdrasil\//);
    }
    // Graph files are REAL files under .yggdrasil/ — no synthetic keys remain.
    for (const f of graphFiles) {
      expect(f.path).toMatch(/^\.yggdrasil\//);
    }

    expect(sourceFiles.length).toBeGreaterThan(0);
    expect(graphFiles.length).toBeGreaterThan(0);
  });

  it('assigns correct layer to each tracked file', async () => {
    const graph = await loadGraph(FIXTURE_PROJECT);
    const node = graph.nodes.get('orders/order-service')!;
    const { trackedFiles } = collectTrackedFiles(node, graph);

    // Hierarchy layer: parent node files
    const hierarchyNodeYaml = trackedFiles.find((f) => f.path === '.yggdrasil/model/orders/yg-node.yaml');
    expect(hierarchyNodeYaml).toBeDefined();
    expect(hierarchyNodeYaml?.layer).toBe('hierarchy');

    // Aspects layer: the aspect's content.md artifact
    const aspectContent = trackedFiles.find((f) => f.path === '.yggdrasil/aspects/requires-audit/content.md');
    expect(aspectContent).toBeDefined();
    expect(aspectContent?.layer).toBe('aspects');

    // Source layer: mapped source files
    const sourceFile = trackedFiles.find((f) => f.path === 'src/orders/order.service.ts');
    expect(sourceFile).toBeDefined();
    expect(sourceFile?.layer).toBe('source');
    expect(sourceFile?.category).toBe('source');

    // Relational layer: dependency yg-node.yaml
    const relationalFile = trackedFiles.find((f) => f.path === '.yggdrasil/model/auth/auth-api/yg-node.yaml');
    expect(relationalFile).toBeDefined();
    expect(relationalFile?.layer).toBe('relational');
  });

  it('no duplicate tracked-file paths', async () => {
    const graph = await loadGraph(FIXTURE_PROJECT);
    const node = graph.nodes.get('orders/order-service')!;
    const { trackedFiles } = collectTrackedFiles(node, graph);
    const paths = trackedFiles.map((f) => f.path);

    expect(new Set(paths).size).toBe(paths.length);
  });

  it('returns empty source files for nodes without mapping; still records own identity', async () => {
    const graph = await loadGraph(FIXTURE_PROJECT);
    // 'orders' is a module node with no mapping
    const node = graph.nodes.get('orders')!;
    const { trackedFiles, identity } = collectTrackedFiles(node, graph);

    const sourceFiles = trackedFiles.filter((f) => f.category === 'source');

    expect(sourceFiles).toHaveLength(0);
    // Still records its own metadata hash in identity.
    expect(identity.ownSubset).toMatch(/^[a-f0-9]{64}$/);
  });

  it('includes relational dependency yg-node.yaml', async () => {
    const graph = await loadGraph(FIXTURE_PROJECT);
    const node = graph.nodes.get('orders/order-service')!;
    const { trackedFiles } = collectTrackedFiles(node, graph);
    const paths = trackedFiles.map((f) => f.path);

    expect(paths).toContain('.yggdrasil/model/auth/auth-api/yg-node.yaml');
    expect(paths).toContain('.yggdrasil/model/users/user-repo/yg-node.yaml');
  });

  it('tracks dependency yg-node.yaml for relational deps', () => {
    const target: GraphNode = {
      path: 'dep/svc',
      meta: { name: 'DepSvc', type: 'service' },
      children: [],
      parent: null,
    };
    const node: GraphNode = {
      path: 'my/svc',
      meta: {
        name: 'MySvc',
        type: 'service',
        relations: [{ target: 'dep/svc', type: 'uses' }],
      },
      children: [],
      parent: null,
    };
    const graph: Graph = {
      config: {},
      architecture: { node_types: {} },
      nodes: new Map([
        ['my/svc', node],
        ['dep/svc', target],
      ]),
      aspects: [],
      flows: [],
      schemas: [],
      rootPath: '/project/.yggdrasil',
    };

    const { trackedFiles } = collectTrackedFiles(node, graph);
    const paths = trackedFiles.map((f) => f.path);

    expect(paths).toContain('.yggdrasil/model/dep/svc/yg-node.yaml');
  });

  it('handles nodes without aspects', async () => {
    const graph = await loadGraph(FIXTURE_PROJECT);
    // 'users' module has no aspects
    const node = graph.nodes.get('users')!;
    const { trackedFiles, identity } = collectTrackedFiles(node, graph);
    const paths = trackedFiles.map((f) => f.path);

    expect(identity.ownSubset).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.keys(identity.aspects)).toHaveLength(0);
    const aspectPaths = paths.filter((p) => p.includes('/aspects/'));
    expect(aspectPaths).toHaveLength(0);
  });

  it('handles nodes without relations', async () => {
    const graph = await loadGraph(FIXTURE_PROJECT);
    // 'users' module has no relations
    const node = graph.nodes.get('users')!;
    const { trackedFiles, identity } = collectTrackedFiles(node, graph);
    const paths = trackedFiles.map((f) => f.path);

    expect(identity.ownSubset).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.keys(identity.ports)).toHaveLength(0);
    const otherModelPaths = paths.filter(
      (p) => p.startsWith('.yggdrasil/model/') && !p.startsWith('.yggdrasil/model/users'),
    );
    expect(otherModelPaths).toHaveLength(0);
  });

  it('includes event relation target metadata (emits/listens)', () => {
    const target: GraphNode = {
      path: 'events/bus',
      meta: { name: 'EventBus', type: 'service' },
      children: [],
      parent: null,
    };
    const node: GraphNode = {
      path: 'my/svc',
      meta: {
        name: 'MySvc',
        type: 'service',
        relations: [{ target: 'events/bus', type: 'emits' }],
      },
      children: [],
      parent: null,
    };
    const graph: Graph = {
      config: {},
      architecture: { node_types: {} },
      nodes: new Map([
        ['my/svc', node],
        ['events/bus', target],
      ]),
      aspects: [],
      flows: [],
      schemas: [],
      rootPath: '/project/.yggdrasil',
    };

    const { trackedFiles } = collectTrackedFiles(node, graph);
    const paths = trackedFiles.map((f) => f.path);

    expect(paths).toContain('.yggdrasil/model/events/bus/yg-node.yaml');
  });

  it('skips relations with missing targets', () => {
    const node: GraphNode = {
      path: 'my/svc',
      meta: {
        name: 'MySvc',
        type: 'service',
        relations: [{ target: 'nonexistent/svc', type: 'calls' }],
      },
      children: [],
      parent: null,
    };
    const graph: Graph = {
      config: {},
      architecture: { node_types: {} },
      nodes: new Map([['my/svc', node]]),
      aspects: [],
      flows: [],
      schemas: [],
      rootPath: '/project/.yggdrasil',
    };

    // Should not throw, just skip the broken relation.
    const { identity } = collectTrackedFiles(node, graph);
    expect(identity.ownSubset).toMatch(/^[a-f0-9]{64}$/);
  });

  it('records target ports hash in identity.ports when dependency has ports', () => {
    const target: GraphNode = {
      path: 'dep/svc',
      meta: {
        name: 'DepSvc',
        type: 'service',
        ports: { charge: { description: 'Payment', aspects: ['correlation-id'] } },
      },
      children: [],
      parent: null,
    };
    const node: GraphNode = {
      path: 'my/svc',
      meta: {
        name: 'MySvc',
        type: 'service',
        relations: [{ target: 'dep/svc', type: 'calls' }],
      },
      children: [],
      parent: null,
    };
    const graph: Graph = {
      config: {},
      architecture: { node_types: {} },
      nodes: new Map([
        ['my/svc', node],
        ['dep/svc', target],
      ]),
      aspects: [],
      flows: [],
      schemas: [],
      rootPath: '/project/.yggdrasil',
    };

    const { trackedFiles, identity } = collectTrackedFiles(node, graph);
    const paths = trackedFiles.map((f) => f.path);

    // Target with ports → identity.ports[targetPath] hash; yg-node.yaml still tracked.
    expect(identity.ports['dep/svc']).toMatch(/^[a-f0-9]{64}$/);
    expect(paths).toContain('.yggdrasil/model/dep/svc/yg-node.yaml');
  });

  it('does NOT record target ports hash when dependency has no ports', () => {
    const target: GraphNode = {
      path: 'dep/svc',
      meta: { name: 'DepSvc', type: 'service' },
      children: [],
      parent: null,
    };
    const node: GraphNode = {
      path: 'my/svc',
      meta: {
        name: 'MySvc',
        type: 'service',
        relations: [{ target: 'dep/svc', type: 'calls' }],
      },
      children: [],
      parent: null,
    };
    const graph: Graph = {
      config: {},
      architecture: { node_types: {} },
      nodes: new Map([
        ['my/svc', node],
        ['dep/svc', target],
      ]),
      aspects: [],
      flows: [],
      schemas: [],
      rootPath: '/project/.yggdrasil',
    };

    const { trackedFiles, identity } = collectTrackedFiles(node, graph);
    const paths = trackedFiles.map((f) => f.path);

    expect(identity.ports['dep/svc']).toBeUndefined();
    expect(paths).toContain('.yggdrasil/model/dep/svc/yg-node.yaml');
  });

  it('deduplicates aspect files inherited from both own and ancestor', () => {
    const parent: GraphNode = {
      path: 'orders',
      meta: { name: 'Orders', type: 'module', aspects: ['requires-audit'] },
      children: [],
      parent: null,
    };
    const child: GraphNode = {
      path: 'orders/order-service',
      meta: { name: 'OrderService', type: 'service', aspects: ['requires-audit'] },
      children: [],
      parent,
    };
    parent.children = [child];

    const graph: Graph = {
      config: {},
      architecture: { node_types: {} },
      nodes: new Map([
        ['orders', parent],
        ['orders/order-service', child],
      ]),
      aspects: [
        {
          name: 'Audit',
          id: 'requires-audit',
          reviewer: { type: 'llm' as const }, artifacts: [{ filename: 'content.md', content: 'Audit rules' }],
        },
      ],
      flows: [],
      schemas: [],
      rootPath: '/project/.yggdrasil',
    };

    const { trackedFiles, identity } = collectTrackedFiles(child, graph);
    const paths = trackedFiles.map((f) => f.path);

    // requires-audit appears via both parent and child aspects, but its content.md
    // artifact is tracked once, and its identity slice is keyed once.
    const auditPaths = paths.filter((p) => p.includes('requires-audit'));
    expect(auditPaths).toHaveLength(1); // content.md only
    expect(new Set(paths).size).toBe(paths.length);
    expect(Object.keys(identity.aspects)).toContain('requires-audit');
  });

  it('includes dependency ancestor yg-node.yaml files', async () => {
    const graph = await loadGraph(FIXTURE_PROJECT);
    const node = graph.nodes.get('orders/order-service')!;
    const { trackedFiles } = collectTrackedFiles(node, graph);
    const paths = trackedFiles.map((f) => f.path);

    const authParentFiles = paths.filter((p) => p.includes('model/auth/') && !p.includes('auth-api'));
    expect(authParentFiles.length).toBeGreaterThan(0);
  });

  it('includes event relation target files and ancestors', async () => {
    const graph = await loadGraph(FIXTURE_PROJECT);
    const node = graph.nodes.get('orders/order-service')!;
    const originalRelations = node.meta.relations ?? [];
    node.meta.relations = [
      ...originalRelations,
      { type: 'emits', target: 'auth/auth-api', event_name: 'order.created' },
    ];

    const { trackedFiles } = collectTrackedFiles(node, graph);
    const paths = trackedFiles.map((f) => f.path);

    const authApiFiles = paths.filter(p => p.includes('model/auth/auth-api/'));
    expect(authApiFiles.length).toBeGreaterThan(0);

    const authParentFiles = paths.filter(p =>
      p.includes('model/auth/') && !p.includes('auth-api') && !p.includes('auth-service')
    );
    expect(authParentFiles.length).toBeGreaterThan(0);

    node.meta.relations = originalRelations;
  });

  it('tracks only yg-node.yaml for dependency (no content .md files)', () => {
    const target: GraphNode = {
      path: 'dep/svc',
      meta: { name: 'DepSvc', type: 'service' },
      children: [],
      parent: null,
    };
    const node: GraphNode = {
      path: 'my/svc',
      meta: {
        name: 'MySvc',
        type: 'service',
        relations: [{ target: 'dep/svc', type: 'uses' }],
      },
      children: [],
      parent: null,
    };
    const graph: Graph = {
      config: {},
      architecture: { node_types: {} },
      nodes: new Map([
        ['my/svc', node],
        ['dep/svc', target],
      ]),
      aspects: [],
      flows: [],
      schemas: [],
      rootPath: '/project/.yggdrasil',
    };

    const { trackedFiles } = collectTrackedFiles(node, graph);
    const paths = trackedFiles.map((f) => f.path);

    expect(paths).toContain('.yggdrasil/model/dep/svc/yg-node.yaml');
  });

  it('skips aspect that is not found in graph.aspects', () => {
    const node: GraphNode = {
      path: 'my/svc',
      meta: {
        name: 'MySvc',
        type: 'service',
        aspects: ['nonexistent-aspect'],
      },
      children: [],
      parent: null,
    };
    const graph: Graph = {
      config: {},
      architecture: { node_types: {} },
      nodes: new Map([['my/svc', node]]),
      aspects: [], // no aspects defined — the reference won't resolve
      flows: [],
      schemas: [],
      rootPath: '/project/.yggdrasil',
    };

    const { trackedFiles, identity } = collectTrackedFiles(node, graph);
    const paths = trackedFiles.map((f) => f.path);
    const aspectPaths = paths.filter((p) => p.includes('/aspects/'));
    expect(aspectPaths).toHaveLength(0);
    expect(Object.keys(identity.aspects)).toHaveLength(0);
    expect(identity.ownSubset).toMatch(/^[a-f0-9]{64}$/);
  });

  it('skips event relation with missing target', () => {
    const node: GraphNode = {
      path: 'my/svc',
      meta: {
        name: 'MySvc',
        type: 'service',
        relations: [{ target: 'nonexistent/bus', type: 'emits' }],
      },
      children: [],
      parent: null,
    };
    const graph: Graph = {
      config: {},
      architecture: { node_types: {} },
      nodes: new Map([['my/svc', node]]),
      aspects: [],
      flows: [],
      schemas: [],
      rootPath: '/project/.yggdrasil',
    };

    const { trackedFiles, identity } = collectTrackedFiles(node, graph);
    const paths = trackedFiles.map((f) => f.path);
    expect(paths).not.toContain('.yggdrasil/model/nonexistent/bus/yg-node.yaml');
    expect(identity.ownSubset).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe('drift hash uses check.mjs for deterministic aspects', () => {
  it('deterministic aspect artifact check.mjs appears in tracked files', () => {
    const svcNode: GraphNode = {
      path: 'svc',
      meta: {
        name: 'Svc',
        type: 'service',
        aspects: ['async-fs'],
        mapping: ['src/svc.ts'],
      },
      children: [],
      parent: null,
    };
    const graph: Graph = {
      config: {},
      architecture: { node_types: {} },
      nodes: new Map([['svc', svcNode]]),
      aspects: [
        {
          id: 'async-fs',
          name: 'AsyncFS',
          reviewer: { type: 'deterministic' as const },
          artifacts: [{ filename: 'check.mjs', content: 'export function check(ctx) { return []; }' }],
        },
      ],
      flows: [],
      schemas: [],
      rootPath: '/project/.yggdrasil',
    };

    const { trackedFiles } = collectTrackedFiles(svcNode, graph);
    const paths = trackedFiles.map((f) => f.path);

    expect(paths).toContain('.yggdrasil/aspects/async-fs/check.mjs');
    expect(paths).not.toContain('.yggdrasil/aspects/async-fs/content.md');
  });

  it('LLM aspect artifact content.md appears in tracked files', () => {
    const svcNode: GraphNode = {
      path: 'svc',
      meta: {
        name: 'Svc',
        type: 'service',
        aspects: ['my-rule'],
        mapping: ['src/svc.ts'],
      },
      children: [],
      parent: null,
    };
    const graph: Graph = {
      config: {},
      architecture: { node_types: {} },
      nodes: new Map([['svc', svcNode]]),
      aspects: [
        {
          id: 'my-rule',
          name: 'MyRule',
          reviewer: { type: 'llm' as const }, artifacts: [{ filename: 'content.md', content: '# Rule\nMust log.' }],
        },
      ],
      flows: [],
      schemas: [],
      rootPath: '/project/.yggdrasil',
    };

    const { trackedFiles } = collectTrackedFiles(svcNode, graph);
    const paths = trackedFiles.map((f) => f.path);

    expect(paths).toContain('.yggdrasil/aspects/my-rule/content.md');
    expect(paths).not.toContain('.yggdrasil/aspects/my-rule/check.mjs');
  });
});
