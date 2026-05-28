import type { Graph, GraphNode, AspectStatus, AspectDef, StatusInherit } from '../../model/graph.js';
import { STATUS_ORDER } from '../../model/graph.js';
import type { WhenPredicate } from '../../model/when.js';
import { evaluateWhen } from '../when-evaluator.js';
import { collectAncestors } from './traversal.js';
import { debugWrite } from '../../utils/debug-log.js';

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

// ============================================================
// computeEffectiveAspectStatuses — phase-1 (channels 1–6)
// ============================================================

function maxStatus(a: AspectStatus | undefined, b: AspectStatus): AspectStatus {
  if (a === undefined) return b;
  return STATUS_ORDER[a] >= STATUS_ORDER[b] ? a : b;
}

function aspectDefaultStatus(graph: Graph, aspectId: string): AspectStatus {
  const def = graph.aspects.find(a => a.id === aspectId);
  return def?.status ?? 'enforced';
}

/**
 * Compute effective status per aspect for a node. Phase-1: channels 1–6 only.
 * Phase-2 (implies) added by Task 11.
 *
 * Returns a Map keyed by aspect id; only contains entries reachable via at
 * least one channel after `when` filtering.
 *
 * @see computeEffectiveAspects for the parallel id-only set
 */
export function computeEffectiveAspectStatuses(node: GraphNode, graph: Graph): Map<string, AspectStatus> {
  const result = new Map<string, AspectStatus>();
  const ancestors = collectAncestors(node);

  const contribute = (
    aspectId: string,
    declared: AspectStatus | undefined,
    attachWhen: WhenPredicate | undefined,
  ): void => {
    const aspectDef = graph.aspects.find(a => a.id === aspectId);
    const globalWhen = aspectDef?.when;
    if (globalWhen && !evaluateWhen(globalWhen, node, graph)) return;
    if (attachWhen && !evaluateWhen(attachWhen, node, graph)) return;
    const effective = declared ?? aspectDefaultStatus(graph, aspectId);
    result.set(aspectId, maxStatus(result.get(aspectId), effective));
  };

  // 1. Own aspects
  for (const id of node.meta.aspects ?? []) {
    contribute(id, node.meta.aspectStatus?.[id], node.meta.aspectWhens?.[id]);
  }

  // 2. Ancestor node aspects
  for (const ancestor of ancestors) {
    for (const id of ancestor.meta.aspects ?? []) {
      contribute(id, ancestor.meta.aspectStatus?.[id], ancestor.meta.aspectWhens?.[id]);
    }
  }

  // 3. Own architecture type aspects
  if (graph.architecture) {
    const typeDef = graph.architecture.node_types[node.meta.type];
    for (const id of typeDef?.aspects ?? []) {
      contribute(id, typeDef?.aspectStatus?.[id], typeDef?.aspectWhens?.[id]);
    }
  }

  // 4. Ancestor architecture type aspects
  if (graph.architecture) {
    for (const ancestor of ancestors) {
      const typeDef = graph.architecture.node_types[ancestor.meta.type];
      for (const id of typeDef?.aspects ?? []) {
        contribute(id, typeDef?.aspectStatus?.[id], typeDef?.aspectWhens?.[id]);
      }
    }
  }

  // 5. Flow aspects
  const allPaths = new Set<string>([node.path, ...ancestors.map(a => a.path)]);
  for (const flow of graph.flows) {
    if (!flow.nodes.some(n => allPaths.has(n))) continue;
    for (const id of flow.aspects ?? []) {
      contribute(id, flow.aspectStatus?.[id], flow.aspectWhens?.[id]);
    }
  }

  // 6. Port consumption aspects
  if (node.meta.relations) {
    for (const relation of node.meta.relations) {
      const targetNode = graph.nodes.get(relation.target);
      if (!targetNode?.meta.ports || !relation.consumes) continue;
      for (const portName of relation.consumes) {
        const port = targetNode.meta.ports[portName];
        if (!port?.aspects) continue;
        for (const id of port.aspects) {
          contribute(id, port.aspectStatus?.[id], port.aspectWhens?.[id]);
        }
      }
    }
  }

  // Phase 2 — implies fix-point. Monotone (max only) → terminates in
  // O(aspects × max-depth). Draft aspects do not propagate.
  const idToAspect = new Map<string, AspectDef>();
  for (const a of graph.aspects) idToAspect.set(a.id, a as AspectDef);

  let changed = true;
  let iterations = 0;
  const maxIterations = graph.aspects.length + 1;
  while (changed) {
    if (++iterations > maxIterations) {
      throw new Error(`implies fix-point did not converge after ${maxIterations} iterations (cycle suspected)`);
    }
    changed = false;
    const currentIds = [...result.keys()];
    for (const implierId of currentIds) {
      const implierStatus = result.get(implierId)!;
      if (implierStatus === 'draft') continue;
      const implierDef = idToAspect.get(implierId);
      if (!implierDef?.implies) continue;
      for (const impliedId of implierDef.implies) {
        const impliedDef = idToAspect.get(impliedId);
        const globalWhen = impliedDef?.when;
        if (globalWhen && !evaluateWhen(globalWhen, node, graph)) continue;
        const perEdgeWhen = implierDef.impliesWhens?.[impliedId];
        if (perEdgeWhen && !evaluateWhen(perEdgeWhen, node, graph)) continue;

        const inheritMode: StatusInherit = implierDef.impliesStatusInherit?.[impliedId] ?? 'strictest';
        const impliedDefault: AspectStatus = impliedDef?.status ?? 'enforced';
        const declared: AspectStatus = inheritMode === 'own-default'
          ? impliedDefault
          : (STATUS_ORDER[implierStatus] >= STATUS_ORDER[impliedDefault] ? implierStatus : impliedDefault);

        const prior = result.get(impliedId);
        const next = maxStatus(prior, declared);
        if (prior === undefined || STATUS_ORDER[next] > STATUS_ORDER[prior]) {
          result.set(impliedId, next);
          changed = true;
        }
      }
    }
  }

  return result;
}

/**
 * Channels 1-6 only. Channel 7 (implies) is structural propagation, not a
 * direct attach declaration, so it never produces an AttachSource entry.
 */
export interface AttachSource {
  channel: 1 | 2 | 3 | 4 | 5 | 6;
  origin: string;
  declared: AspectStatus;
}

/**
 * Return per-channel provenance for an aspect's status on a node. Used by
 * validator (downgrade detection) and display paths (yg context, yg impact).
 */
export function getAspectStatusSources(node: GraphNode, aspectId: string, graph: Graph): AttachSource[] {
  const sources: AttachSource[] = [];
  const ancestors = collectAncestors(node);
  const aspectDef = graph.aspects.find(a => a.id === aspectId);
  const defaultStatus = aspectDef?.status ?? 'enforced';

  const tryAdd = (
    channel: 1 | 2 | 3 | 4 | 5 | 6,
    origin: string,
    declared: AspectStatus | undefined,
    attachWhen: WhenPredicate | undefined,
  ): void => {
    const globalWhen = aspectDef?.when;
    if (globalWhen && !evaluateWhen(globalWhen, node, graph)) return;
    if (attachWhen && !evaluateWhen(attachWhen, node, graph)) return;
    sources.push({ channel, origin, declared: declared ?? defaultStatus });
  };

  // 1. Own
  if (node.meta.aspects?.includes(aspectId)) {
    tryAdd(1, `own:${node.path}`, node.meta.aspectStatus?.[aspectId], node.meta.aspectWhens?.[aspectId]);
  }
  // 2. Ancestor nodes
  for (const ancestor of ancestors) {
    if (ancestor.meta.aspects?.includes(aspectId)) {
      tryAdd(2, `ancestor:${ancestor.path}`, ancestor.meta.aspectStatus?.[aspectId], ancestor.meta.aspectWhens?.[aspectId]);
    }
  }
  // 3. Own arch type
  if (graph.architecture) {
    const typeDef = graph.architecture.node_types[node.meta.type];
    if (typeDef?.aspects?.includes(aspectId)) {
      tryAdd(3, `type:${node.meta.type}`, typeDef?.aspectStatus?.[aspectId], typeDef?.aspectWhens?.[aspectId]);
    }
  }
  // 4. Ancestor arch type
  if (graph.architecture) {
    for (const ancestor of ancestors) {
      const typeDef = graph.architecture.node_types[ancestor.meta.type];
      if (typeDef?.aspects?.includes(aspectId)) {
        tryAdd(4, `ancestor-type:${ancestor.meta.type}@${ancestor.path}`, typeDef?.aspectStatus?.[aspectId], typeDef?.aspectWhens?.[aspectId]);
      }
    }
  }
  // 5. Flows
  const allPaths = new Set<string>([node.path, ...ancestors.map(a => a.path)]);
  for (const flow of graph.flows) {
    if (!flow.aspects?.includes(aspectId)) continue;
    if (!flow.nodes.some(n => allPaths.has(n))) continue;
    tryAdd(5, `flow:${flow.path}`, flow.aspectStatus?.[aspectId], flow.aspectWhens?.[aspectId]);
  }
  // 6. Ports
  if (node.meta.relations) {
    for (const relation of node.meta.relations) {
      const targetNode = graph.nodes.get(relation.target);
      if (!targetNode?.meta.ports || !relation.consumes) continue;
      for (const portName of relation.consumes) {
        const port = targetNode.meta.ports[portName];
        if (!port?.aspects?.includes(aspectId)) continue;
        tryAdd(6, `port:${portName}@${relation.target}`, port.aspectStatus?.[aspectId], port.aspectWhens?.[aspectId]);
      }
    }
  }

  return sources;
}

/**
 * Single source of truth for "this node has reviewer work to do".
 */
export function hasNonDraftEffectiveAspects(node: GraphNode, graph: Graph): boolean {
  const statuses = computeEffectiveAspectStatuses(node, graph);
  for (const s of statuses.values()) {
    if (s !== 'draft') return true;
  }
  return false;
}
