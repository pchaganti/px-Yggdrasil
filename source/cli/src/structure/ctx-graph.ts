import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Graph, GraphNode as ModelNode } from '../model/graph.js';
import type { GraphNode, Relation, File, Port } from './types.js';
import { normalizeMappingPath } from './expand-mapping-sync.js';

export class UndeclaredGraphReadError extends Error {
  constructor(public readonly nodePath: string) {
    super(`structure-aspect-undeclared-graph-read: ${nodePath}`);
    this.name = 'UndeclaredGraphReadError';
  }
}

export interface CtxGraphParams {
  currentNodePath: string;
  graph: Graph;
  projectRoot: string;
  /** mutable touched files list */
  touchedFiles: string[];
}

export interface CtxGraph {
  node(id: string): GraphNode | undefined;
  nodesByType(type: string): GraphNode[];
  relationsFrom(node: GraphNode): Relation[];
  relationsTo(node: GraphNode): Relation[];
  children(node: GraphNode): GraphNode[];
  flowParticipants(flowName: string): GraphNode[];
}

function computeAllowedNodePaths(currentPath: string, graph: Graph): Set<string> {
  const allowed = new Set<string>([currentPath]);
  const current = graph.nodes.get(currentPath);
  if (!current) return allowed;

  for (const rel of current.meta.relations ?? []) {
    allowed.add(rel.target);
    const target = graph.nodes.get(rel.target);
    if (!target) continue;
    const relStack: ModelNode[] = [...target.children];
    while (relStack.length > 0) {
      const n = relStack.pop()!;
      allowed.add(n.path);
      relStack.push(...n.children);
    }
  }

  let cursor = current.parent;
  while (cursor) { allowed.add(cursor.path); cursor = cursor.parent; }

  const stack: ModelNode[] = [...current.children];
  while (stack.length) {
    const n = stack.pop()!;
    allowed.add(n.path);
    stack.push(...n.children);
  }
  return allowed;
}

export function createCtxGraph(params: CtxGraphParams): CtxGraph {
  const { currentNodePath, graph, projectRoot, touchedFiles } = params;
  const allowed = computeAllowedNodePaths(currentNodePath, graph);

  function assertAllowed(id: string): void {
    if (!allowed.has(id)) throw new UndeclaredGraphReadError(id);
  }

  function toPublicNode(m: ModelNode): GraphNode {
    const files: File[] = [];
    for (const raw of m.meta.mapping ?? []) {
      const p = normalizeMappingPath(raw);
      if (!p) continue;
      const abs = path.resolve(projectRoot, p);
      try {
        const stat = fs.statSync(abs);
        if (stat.isFile()) {
          const content = fs.readFileSync(abs, 'utf8');
          files.push({ path: p, content });
          touchedFiles.push(p);
        }
      } catch {
        // missing path — skip silently
      }
    }
    return {
      id: m.path,
      type: m.meta.type,
      mapping: m.meta.mapping ?? [],
      files,
      ports: (m.meta.ports ?? {}) as Record<string, Port>,
    };
  }

  return {
    node(id) {
      assertAllowed(id);
      const m = graph.nodes.get(id);
      return m ? toPublicNode(m) : undefined;
    },
    nodesByType(type) {
      const out: GraphNode[] = [];
      for (const id of allowed) {
        const m = graph.nodes.get(id);
        if (m && m.meta.type === type) out.push(toPublicNode(m));
      }
      return out;
    },
    relationsFrom(node) {
      assertAllowed(node.id);
      const m = graph.nodes.get(node.id);
      return (m?.meta.relations ?? []) as Relation[];
    },
    relationsTo(node) {
      const out: Relation[] = [];
      for (const id of allowed) {
        const m = graph.nodes.get(id);
        if (!m) continue;
        for (const rel of m.meta.relations ?? []) {
          if (rel.target === node.id) out.push(rel as Relation);
        }
      }
      return out;
    },
    children(node) {
      assertAllowed(node.id);
      const m = graph.nodes.get(node.id);
      return m ? m.children.map(toPublicNode) : [];
    },
    flowParticipants(flowName) {
      const flow = graph.flows.find(f => f.name === flowName || f.path === flowName);
      if (!flow) return [];
      const participates = flow.nodes.some(n => {
        if (n === currentNodePath) return true;
        let cursor = graph.nodes.get(currentNodePath)?.parent;
        while (cursor) { if (cursor.path === n) return true; cursor = cursor.parent; }
        return false;
      });
      if (!participates) throw new UndeclaredGraphReadError(`flow:${flowName}`);
      const out: GraphNode[] = [];
      for (const nodeId of flow.nodes) {
        const m = graph.nodes.get(nodeId);
        if (m) out.push(toPublicNode(m));
      }
      return out;
    },
  };
}
