import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Graph, GraphNode as ModelNode } from '../model/graph.js';
import type { GraphNode, Relation, File, Port } from './types.js';
import { normalizeMappingPath } from './expand-mapping-sync.js';
import type { ObservationRecorder } from './observations.js';

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
  /**
   * Per-node concrete file paths (repo-relative, POSIX), pre-expanded by the
   * async runner so directory and glob mapping entries resolve to real files.
   * Keyed by node path. When absent for a node, toPublicNode falls back to the
   * raw mapping entries (file-only, no glob/dir expansion). Content is still
   * read lazily per node so touchedFiles reflects only what the check accessed.
   */
  expandedFilesByNode?: Map<string, string[]>;
  /**
   * Optional observation recorder. When provided, each node returned to the check
   * records a graph: observation (keyed by node path, hashed from nodeYamlRaw).
   * File reads inside toPublicNode additionally record read: observations for
   * files NOT in `subjectFiles`.
   */
  recorder?: ObservationRecorder;
  /**
   * Set of repo-relative POSIX paths that are subject files for the current run.
   * File reads of these paths inside toPublicNode are NOT recorded as read:
   * observations (they are already hashed as subject inputs).
   */
  subjectFiles?: Set<string>;
}

export interface CtxGraph {
  node(id: string): GraphNode | undefined;
  nodesByType(type: string): GraphNode[];
  relationsFrom(node: GraphNode): Relation[];
  relationsTo(node: GraphNode): Relation[];
  children(node: GraphNode): GraphNode[];
  flowParticipants(flowName: string): GraphNode[];
}

export function computeAllowedNodePaths(currentPath: string, graph: Graph): Set<string> {
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
  const { currentNodePath, graph, projectRoot, touchedFiles, expandedFilesByNode, recorder, subjectFiles } = params;
  const allowed = computeAllowedNodePaths(currentNodePath, graph);

  function assertAllowed(id: string): void {
    if (!allowed.has(id)) throw new UndeclaredGraphReadError(id);
  }

  function recordGraphNode(m: ModelNode): void {
    if (!recorder) return;
    // Hash using nodeYamlRaw from the in-memory model (the trusted source loaded
    // at graph-load time). Fall back to reading the file from disk only when the
    // in-memory field is absent (e.g. in tests that build minimal graph stubs).
    let yamlBytes: Buffer;
    if (m.nodeYamlRaw !== undefined) {
      yamlBytes = Buffer.from(m.nodeYamlRaw, 'utf8');
    } else {
      // Derive yg-node.yaml path from the node path (model/<nodePath>/yg-node.yaml)
      const ygNodePath = path.join(projectRoot, '.yggdrasil', 'model', m.path, 'yg-node.yaml');
      try {
        yamlBytes = fs.readFileSync(ygNodePath);
      } catch {
        // File absent — record an empty buffer so the observation key is still
        // registered (the absence itself is information; a taint would fire if
        // content later appears at a second observation of the same path).
        yamlBytes = Buffer.alloc(0);
      }
    }
    recorder.recordGraphNode(m.path, yamlBytes);
  }

  function toPublicNode(m: ModelNode): GraphNode {
    const files: File[] = [];
    // Prefer the runner's pre-expanded concrete file list (directory and glob
    // entries already resolved to real files). Fall back to the raw mapping
    // entries when no expansion was supplied (file-only, as before).
    const preExpanded = expandedFilesByNode?.get(m.path);
    const candidatePaths = preExpanded ?? (m.meta.mapping ?? []).map(normalizeMappingPath);
    for (const p of candidatePaths) {
      if (!p) continue;
      const abs = path.resolve(projectRoot, p);
      try {
        const stat = fs.statSync(abs);
        if (stat.isFile()) {
          const bytes = fs.readFileSync(abs);
          const content = bytes.toString('utf8');
          files.push({ path: p, content });
          touchedFiles.push(p);
          // Record a read: observation for non-subject files handed to the check.
          if (recorder && !(subjectFiles?.has(p))) {
            recorder.recordRead(p, bytes);
          }
        }
      } catch {
        // missing path — skip silently
      }
    }
    // Record graph: observation for this node — after materializing files so the
    // observation is registered even if the node has no mapped files.
    recordGraphNode(m);
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
