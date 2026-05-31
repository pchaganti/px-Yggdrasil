import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectTrackedFiles } from '../../../src/core/graph/files.js';
import { loadGraph } from '../../../src/core/graph-loader.js';
import type { Graph, GraphNode } from '../../../src/model/graph.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PROJECT = path.join(__dirname, '../../fixtures/sample-project');

describe('collectTrackedFiles', () => {
  it('includes own yg-node.yaml', async () => {
    const graph = await loadGraph(FIXTURE_PROJECT);
    const node = graph.nodes.get('orders/order-service')!;
    const files = collectTrackedFiles(node, graph);
    const paths = files.map((f) => f.path);

    // Own yg-node.yaml is tracked as synthetic hash, not as file path
    expect(paths).toContain('own-subset:orders/order-service');
  });

  it('includes parent yg-node.yaml', async () => {
    const graph = await loadGraph(FIXTURE_PROJECT);
    const node = graph.nodes.get('orders/order-service')!;
    const files = collectTrackedFiles(node, graph);
    const paths = files.map((f) => f.path);

    expect(paths).toContain('.yggdrasil/model/orders/yg-node.yaml');
  });

  it('includes aspect files', async () => {
    const graph = await loadGraph(FIXTURE_PROJECT);
    const node = graph.nodes.get('orders/order-service')!;
    const files = collectTrackedFiles(node, graph);
    const paths = files.map((f) => f.path);

    // orders/order-service has requires-audit aspect. Its definition metadata is
    // tracked as a status-stripped synthetic (aspect-meta:<id>), not the raw
    // yg-aspect.yaml file; the content.md artifact is tracked as a file.
    expect(paths).toContain('aspect-meta:requires-audit');
    expect(paths).not.toContain('.yggdrasil/aspects/requires-audit/yg-aspect.yaml');
    expect(paths).toContain('.yggdrasil/aspects/requires-audit/content.md');
  });

  it('includes source files from mapping', async () => {
    const graph = await loadGraph(FIXTURE_PROJECT);
    const node = graph.nodes.get('orders/order-service')!;
    const files = collectTrackedFiles(node, graph);
    const paths = files.map((f) => f.path);

    expect(paths).toContain('src/orders/order.service.ts');
  });

  it('categorizes files as source or graph', async () => {
    const graph = await loadGraph(FIXTURE_PROJECT);
    const node = graph.nodes.get('orders/order-service')!;
    const files = collectTrackedFiles(node, graph);

    const sourceFiles = files.filter((f) => f.category === 'source');
    const graphFiles = files.filter((f) => f.category === 'graph');

    // Source files should not start with .yggdrasil/
    for (const f of sourceFiles) {
      expect(f.path).not.toMatch(/^\.yggdrasil\//);
    }

    // Graph files should start with .yggdrasil/ or be synthetic hash entries
    for (const f of graphFiles) {
      expect(f.path).toMatch(/^(\.yggdrasil\/|own-subset:|port-aspects:|tier-identity:|aspect-meta:|check-touched:)/);
    }

    expect(sourceFiles.length).toBeGreaterThan(0);
    expect(graphFiles.length).toBeGreaterThan(0);
  });

  it('assigns correct layer to each tracked file', async () => {
    const graph = await loadGraph(FIXTURE_PROJECT);
    const node = graph.nodes.get('orders/order-service')!;
    const files = collectTrackedFiles(node, graph);

    // Own yg-node.yaml tracked as synthetic hash (not file path)
    const ownSubset = files.find((f) => f.path === 'own-subset:orders/order-service');
    expect(ownSubset).toBeDefined();
    expect(ownSubset?.layer).toBe('hierarchy');

    // Hierarchy layer: parent node files
    const hierarchyNodeYaml = files.find((f) => f.path === '.yggdrasil/model/orders/yg-node.yaml');
    expect(hierarchyNodeYaml).toBeDefined();
    expect(hierarchyNodeYaml?.layer).toBe('hierarchy');

    // Aspects layer: the aspect's definition metadata (status-stripped synthetic)
    const aspectMeta = files.find((f) => f.path === 'aspect-meta:requires-audit');
    expect(aspectMeta).toBeDefined();
    expect(aspectMeta?.layer).toBe('aspects');
    expect(aspectMeta?.syntheticHash).toBeDefined();

    const aspectContent = files.find((f) => f.path === '.yggdrasil/aspects/requires-audit/content.md');
    expect(aspectContent).toBeDefined();
    expect(aspectContent?.layer).toBe('aspects');

    // Source layer: mapped source files
    const sourceFile = files.find((f) => f.path === 'src/orders/order.service.ts');
    expect(sourceFile).toBeDefined();
    expect(sourceFile?.layer).toBe('source');
    expect(sourceFile?.category).toBe('source');

    // Relational layer: dependency yg-node.yaml
    const relationalFile = files.find((f) => f.path === '.yggdrasil/model/auth/auth-api/yg-node.yaml');
    expect(relationalFile).toBeDefined();
    expect(relationalFile?.layer).toBe('relational');
  });

  it('no duplicate paths', async () => {
    const graph = await loadGraph(FIXTURE_PROJECT);
    const node = graph.nodes.get('orders/order-service')!;
    const files = collectTrackedFiles(node, graph);
    const paths = files.map((f) => f.path);

    expect(new Set(paths).size).toBe(paths.length);
  });

  it('returns empty source files for nodes without mapping', async () => {
    const graph = await loadGraph(FIXTURE_PROJECT);
    // 'orders' is a module node with no mapping
    const node = graph.nodes.get('orders')!;
    const files = collectTrackedFiles(node, graph);

    const sourceFiles = files.filter((f) => f.category === 'source');
    const graphFiles = files.filter((f) => f.category === 'graph');

    expect(sourceFiles).toHaveLength(0);
    expect(graphFiles.length).toBeGreaterThan(0);

    // Should still have its own yg-node.yaml (as synthetic hash)
    const paths = files.map((f) => f.path);
    expect(paths).toContain('own-subset:orders');
  });

  it('includes relational dependency yg-node.yaml', async () => {
    const graph = await loadGraph(FIXTURE_PROJECT);
    const node = graph.nodes.get('orders/order-service')!;
    const files = collectTrackedFiles(node, graph);
    const paths = files.map((f) => f.path);

    // order-service uses auth/auth-api and users/user-repo
    // Only yg-node.yaml is tracked for relational deps
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

    const files = collectTrackedFiles(node, graph);
    const paths = files.map((f) => f.path);

    // Only yg-node.yaml is tracked for relational deps
    expect(paths).toContain('.yggdrasil/model/dep/svc/yg-node.yaml');
  });

  it('handles nodes without aspects', async () => {
    const graph = await loadGraph(FIXTURE_PROJECT);
    // 'users' module has no aspects
    const node = graph.nodes.get('users')!;
    const files = collectTrackedFiles(node, graph);
    const paths = files.map((f) => f.path);

    // Should still have node files
    expect(paths).toContain('own-subset:users');
    // Should not have aspect files
    const aspectPaths = paths.filter((p) => p.includes('/aspects/'));
    expect(aspectPaths).toHaveLength(0);
  });

  it('handles nodes without relations', async () => {
    const graph = await loadGraph(FIXTURE_PROJECT);
    // 'users' module has no relations
    const node = graph.nodes.get('users')!;
    const files = collectTrackedFiles(node, graph);
    const paths = files.map((f) => f.path);

    // Should have own files but no dep metadata from other nodes
    expect(paths).toContain('own-subset:users');
    // Should not have auth or order node files (those are only via relations)
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

    const files = collectTrackedFiles(node, graph);
    const paths = files.map((f) => f.path);

    // Event relations should include target yg-node.yaml
    expect(paths).toContain('.yggdrasil/model/events/bus/yg-node.yaml');
  });

  it('tracks event relation target yg-node.yaml', () => {
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

    const files = collectTrackedFiles(node, graph);
    const paths = files.map((f) => f.path);

    // Event relation includes target yg-node.yaml
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

    // Should not throw, just skip the broken relation
    const files = collectTrackedFiles(node, graph);
    expect(files.length).toBeGreaterThan(0);
  });

  it('tracks target ports hash when dependency has ports', () => {
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

    const files = collectTrackedFiles(node, graph);
    const paths = files.map((f) => f.path);

    // Target with ports should have a synthetic hash entry
    expect(paths).toContain('port-aspects:dep/svc');
    expect(paths).toContain('.yggdrasil/model/dep/svc/yg-node.yaml');
    const tracked = files.find(f => f.path === 'port-aspects:dep/svc');
    expect(tracked?.layer).toBe('relational');
    expect(tracked?.syntheticHash).toBeDefined();
  });

  it('does NOT track target ports hash when dependency has no ports', () => {
    const target: GraphNode = {
      path: 'dep/svc',
      meta: {
        name: 'DepSvc',
        type: 'service',
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

    const files = collectTrackedFiles(node, graph);
    const paths = files.map((f) => f.path);

    expect(paths).not.toContain('port-aspects:dep/svc');
    // yg-node.yaml is still tracked for deps even without ports
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

    const files = collectTrackedFiles(child, graph);
    const paths = files.map((f) => f.path);

    // requires-audit appears in both parent and child aspects,
    // but aspect files should only appear once
    const auditPaths = paths.filter((p) => p.includes('requires-audit'));
    expect(auditPaths).toHaveLength(3); // aspect-meta: synthetic + content.md + tier-identity: synthetic
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('includes dependency ancestor yg-node.yaml files', async () => {
    const graph = await loadGraph(FIXTURE_PROJECT);
    const node = graph.nodes.get('orders/order-service')!;
    const files = collectTrackedFiles(node, graph);
    const paths = files.map((f) => f.path);

    // order-service depends on auth/auth-api. auth-api's parent is auth/.
    // auth/ should have its yg-node.yaml tracked as a dependency ancestor.
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

    const files = collectTrackedFiles(node, graph);
    const paths = files.map((f) => f.path);

    // auth/auth-api's metadata should be tracked (event relation target)
    const authApiFiles = paths.filter(p => p.includes('model/auth/auth-api/'));
    expect(authApiFiles.length).toBeGreaterThan(0);

    // auth/ ancestor should also be tracked
    const authParentFiles = paths.filter(p =>
      p.includes('model/auth/') && !p.includes('auth-api') && !p.includes('auth-service')
    );
    expect(authParentFiles.length).toBeGreaterThan(0);

    // Restore original relations
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

    const files = collectTrackedFiles(node, graph);
    const paths = files.map((f) => f.path);

    // Only yg-node.yaml is tracked for deps — no .md content files
    expect(paths).toContain('.yggdrasil/model/dep/svc/yg-node.yaml');
  });

  it('skips aspect that is not found in graph.aspects (line 106)', () => {
    // Node references an aspect ID that doesn't exist in graph.aspects
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

    // Should not throw; just skip the missing aspect
    const files = collectTrackedFiles(node, graph);
    const paths = files.map((f) => f.path);
    // No aspect files should be present
    const aspectPaths = paths.filter((p) => p.includes('/aspects/'));
    expect(aspectPaths).toHaveLength(0);
    // But own-subset should still be there
    expect(paths).toContain('own-subset:my/svc');
  });

  it('skips event relation with missing target (line 146)', () => {
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

    // Should not throw; just skip the broken event relation
    const files = collectTrackedFiles(node, graph);
    const paths = files.map((f) => f.path);
    // Should not include the nonexistent target
    expect(paths).not.toContain('.yggdrasil/model/nonexistent/bus/yg-node.yaml');
    // But own-subset should still be there
    expect(paths).toContain('own-subset:my/svc');
  });
});

describe('Task 33 — drift hash uses check.mjs for AST aspects', () => {
  it('AST aspect artifact check.mjs appears in tracked files', () => {
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

    const files = collectTrackedFiles(svcNode, graph);
    const paths = files.map((f) => f.path);

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

    const files = collectTrackedFiles(svcNode, graph);
    const paths = files.map((f) => f.path);

    expect(paths).toContain('.yggdrasil/aspects/my-rule/content.md');
    expect(paths).not.toContain('.yggdrasil/aspects/my-rule/check.mjs');
  });
});
