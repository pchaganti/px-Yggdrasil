import type { Graph, GraphNode } from '../model/graph.js';
import type { WhenPredicate } from '../model/when.js';
import { evaluateWhen } from './when-evaluator.js';
import { debugWrite } from '../utils/debug-log.js';

/**
 * Compute the full set of effective aspects for a node from ALL 7 channels,
 * filtered by the 8th mechanism (`when` applicability predicate).
 *
 * Flow per channel:
 *   path_passes = evaluate(aspect.global_when) AND evaluate(attach_site.when)
 *
 * An aspect is effective on the node if AT LEAST ONE channel's path passes.
 * Implies expansion applies aspect.global_when on B and implier.impliesWhens[B]
 * additionally.
 */
export function computeEffectiveAspects(node: GraphNode, graph: Graph): Set<string> {
  const direct = new Set<string>();
  const ancestors = collectAncestors(node);

  const tryAdd = (
    aspectId: string,
    attachWhen: WhenPredicate | undefined,
  ): void => {
    const aspectDef = graph.aspects.find(a => a.id === aspectId);
    const globalWhen = aspectDef?.when;
    if (globalWhen && !evaluateWhen(globalWhen, node, graph)) {
      debugWrite(`[effective-aspects] node '${node.path}' aspect '${aspectId}' filtered: global when=false`);
      return;
    }
    if (attachWhen && !evaluateWhen(attachWhen, node, graph)) {
      debugWrite(`[effective-aspects] node '${node.path}' aspect '${aspectId}' filtered: attach-site when=false`);
      return;
    }
    direct.add(aspectId);
  };

  // 1. Own aspects
  for (const id of node.meta.aspects ?? []) {
    tryAdd(id, node.meta.aspectWhens?.[id]);
  }

  // 2. Ancestor node direct aspects
  for (const ancestor of ancestors) {
    for (const id of ancestor.meta.aspects ?? []) {
      tryAdd(id, ancestor.meta.aspectWhens?.[id]);
    }
  }

  // 3. Own architecture type aspects
  if (graph.architecture) {
    const typeDef = graph.architecture.node_types[node.meta.type];
    for (const id of typeDef?.aspects ?? []) {
      tryAdd(id, typeDef?.aspectWhens?.[id]);
    }
  }

  // 4. Ancestor architecture type aspects
  if (graph.architecture) {
    for (const ancestor of ancestors) {
      const typeDef = graph.architecture.node_types[ancestor.meta.type];
      for (const id of typeDef?.aspects ?? []) {
        tryAdd(id, typeDef?.aspectWhens?.[id]);
      }
    }
  }

  // 5. Flow aspects
  const allPaths = new Set<string>([node.path, ...ancestors.map(a => a.path)]);
  for (const flow of graph.flows) {
    if (!flow.nodes.some(n => allPaths.has(n))) continue;
    for (const id of flow.aspects ?? []) {
      tryAdd(id, flow.aspectWhens?.[id]);
    }
  }

  // 6. Port consumption aspects
  if (node.meta.relations) {
    for (const relation of node.meta.relations) {
      const targetNode = graph.nodes.get(relation.target);
      if (!targetNode) continue;
      if (!relation.consumes || !targetNode.meta.ports) continue;
      for (const portName of relation.consumes) {
        const port = targetNode.meta.ports[portName];
        if (!port?.aspects) continue;
        for (const id of port.aspects) {
          tryAdd(id, port.aspectWhens?.[id]);
        }
      }
    }
  }

  // 7. Expand implies (filter global + per-implies when)
  return expandImpliesFiltered(direct, node, graph);
}

function expandImpliesFiltered(
  directIds: Set<string>,
  node: GraphNode,
  graph: Graph,
): Set<string> {
  const idToAspect = new Map<string, typeof graph.aspects[number]>();
  for (const a of graph.aspects) idToAspect.set(a.id, a);

  const result = new Set<string>();
  const visited = new Set<string>();
  const stack = new Set<string>();

  const visit = (id: string, implierId: string | null): void => {
    if (stack.has(id)) {
      throw new Error(`Aspect implies cycle detected involving aspect '${id}'`);
    }
    if (visited.has(id)) return;

    const aspectDef = idToAspect.get(id);
    if (aspectDef?.when && !evaluateWhen(aspectDef.when, node, graph)) {
      debugWrite(`[effective-aspects] node '${node.path}' aspect '${id}' filtered: global when=false (implies path)`);
      return;
    }

    if (implierId) {
      const implierDef = idToAspect.get(implierId);
      const perImplies = implierDef?.impliesWhens?.[id];
      if (perImplies && !evaluateWhen(perImplies, node, graph)) {
        debugWrite(`[effective-aspects] node '${node.path}' aspect '${id}' filtered: impliesWhens from '${implierId}' is false`);
        return;
      }
    }

    stack.add(id);
    visited.add(id);
    result.add(id);

    const implies = aspectDef?.implies;
    if (implies) {
      for (const implied of implies) {
        visit(implied, id);
      }
    }
    stack.delete(id);
  };

  for (const id of directIds) visit(id, null);
  return result;
}

/**
 * Determine the source of an aspect for a node. Checks all 7 channels in order
 * and returns the first match (ignoring `when` — informational).
 */
export function getAspectSource(aspectId: string, node: GraphNode, graph: Graph): string {
  if (node.meta.aspects?.includes(aspectId)) {
    return 'own declaration';
  }

  const ancestors = collectAncestors(node);
  for (const ancestor of ancestors) {
    if (ancestor.meta.aspects?.includes(aspectId)) {
      return `inherited from parent '${ancestor.path}'`;
    }
  }

  if (graph.architecture) {
    const typeDef = graph.architecture.node_types[node.meta.type];
    if (typeDef?.aspects?.includes(aspectId)) {
      return `architecture (type: ${node.meta.type})`;
    }
  }

  if (graph.architecture) {
    for (const ancestor of ancestors) {
      const typeDef = graph.architecture.node_types[ancestor.meta.type];
      if (typeDef?.aspects?.includes(aspectId)) {
        return `inherited from parent (type: ${ancestor.meta.type})`;
      }
    }
  }

  const allPaths = new Set<string>([node.path, ...ancestors.map(a => a.path)]);
  for (const flow of graph.flows) {
    if (flow.aspects?.includes(aspectId) && flow.nodes.some(n => allPaths.has(n))) {
      if (flow.nodes.includes(node.path)) {
        return `flow '${flow.path}'`;
      }
      const viaAncestor = ancestors.find(a => flow.nodes.includes(a.path));
      if (viaAncestor) {
        return `flow '${flow.path}' (via parent '${viaAncestor.path}')`;
      }
      return `flow '${flow.path}'`;
    }
  }

  if (node.meta.relations) {
    for (const relation of node.meta.relations) {
      const targetNode = graph.nodes.get(relation.target);
      if (!targetNode?.meta.ports || !relation.consumes) continue;
      for (const portName of relation.consumes) {
        const port = targetNode.meta.ports[portName];
        if (port?.aspects?.includes(aspectId)) {
          return `port '${portName}' on '${relation.target}'`;
        }
      }
    }
  }

  for (const otherAspect of graph.aspects) {
    if (otherAspect.implies?.includes(aspectId)) {
      return `implied by '${otherAspect.id}'`;
    }
  }

  return 'unknown source';
}

function collectAncestors(node: GraphNode): GraphNode[] {
  const ancestors: GraphNode[] = [];
  let current = node.parent;
  while (current) {
    ancestors.push(current);
    current = current.parent;
  }
  return ancestors;
}
