import path from 'node:path';
import type { Graph } from '../model/graph.js';
import type { ValidationResult, ValidationIssue } from '../model/validation.js';
import { inspectSecretsForValidation } from '../io/secrets-parser.js';
import { LANGUAGES } from './graph/language-registry.js';
import type {
  WhenPredicate,
  AtomicClause,
  RelationClause,
  DescendantsClause,
  NodeClause,
} from '../model/when.js';
import { normalizeMappingPaths } from '../io/paths.js';
import { expandMappingPaths } from '../io/hash.js';
import { readSortedDir, statPath, fileAccess, fileExistsSync } from '../io/graph-fs.js';
import { walkRepoFiles } from '../io/repo-scanner.js';
import type { IssueMessage } from '../model/validation.js';
import { computeEffectiveAspects } from './graph/aspects.js';
import { FileContentCache } from '../io/file-content-cache.js';
import { evaluateFileWhen } from './file-when-evaluator.js';
import { renderTrace } from '../formatters/predicate-trace.js';

function issueMsg(data: IssueMessage): { messageData: IssueMessage } {
  return { messageData: data };
}

// Architecture-level errors that abort per-node and global validation stages.
const ARCHITECTURE_FATAL_CODES = new Set<string>([
  'type-unknown-parent',
  'architecture-cycle',
  'enforce-strict-without-when',
  'when-predicate-invalid',
]);

export async function validate(graph: Graph, scope: string = 'all'): Promise<ValidationResult> {
  const issues: ValidationIssue[] = [];

  if (graph.configError) {
    const msgData: IssueMessage = graph.configErrorMessage ?? {
      what: 'yg-config.yaml failed to parse.',
      why: graph.configError,
      next: 'Fix the syntax error in .yggdrasil/yg-config.yaml.',
    };
    const errorCode = graph.configErrorCode ?? 'config-invalid';
    issues.push({
      severity: 'error',
      code: errorCode,
      rule: 'invalid-config',
      ...issueMsg(msgData),
      messageData: msgData,
    });
  }

  for (const { nodePath, messageData } of graph.nodeParseErrors ?? []) {
    issues.push({
      severity: 'error',
      code: 'yaml-invalid',
      rule: 'invalid-node-yaml',
      ...issueMsg(messageData),
      messageData,
      nodePath,
    });
  }

  for (const { code, messageData } of graph.aspectParseErrors ?? []) {
    issues.push({
      severity: 'error',
      code,
      rule: code,
      ...issueMsg(messageData),
      messageData,
    });
  }

  // Stage 1: architecture file failed to parse — cannot proceed.
  if (graph.architectureError) {
    const archErr = graph.architectureError;
    if (typeof archErr === 'object' && archErr.code === 'when-predicate-invalid') {
      issues.push({
        severity: 'error',
        code: 'when-predicate-invalid',
        rule: 'when-predicate-invalid',
        ...issueMsg(archErr.messageData),
        messageData: archErr.messageData,
      });
    } else {
      const archInvalid = archErr as { code: 'architecture-invalid'; messageData: IssueMessage };
      issues.push({
        severity: 'error',
        code: 'architecture-invalid',
        rule: 'architecture-invalid',
        ...issueMsg(archInvalid.messageData),
        messageData: archInvalid.messageData,
      });
    }
    return { issues, nodesScanned: 0 };
  }

  // Stage 2: schema-independent checks (run even when architecture has semantic errors).
  if (!graph.configError) {
    // Node type validation uses architecture file (yg-architecture.yaml), not config
    issues.push(...checkDanglingAspectRefs(graph));
    issues.push(...checkAspectIds(graph));
    issues.push(...checkAspectIdUniqueness(graph));
    issues.push(...checkImpliedAspectsExist(graph));
    issues.push(...checkImpliesNoCycles(graph));
    issues.push(...checkHighFanOut(graph));
    issues.push(...checkMissingDescriptions(graph));
    issues.push(...checkReviewerPresence(graph));
    issues.push(...checkAspectTierReferences(graph));
  }

  // Stage 3: architecture-level checks — fatal errors short-circuit per-node + global stages.
  const archIssues: ValidationIssue[] = [];
  archIssues.push(...checkTypeUnknownParent(graph));
  archIssues.push(...checkArchitectureParentCycles(graph));
  archIssues.push(...checkEnforceStrictWithoutWhen(graph));
  issues.push(...archIssues);
  const hasArchFatal = archIssues.some(
    (i) => i.severity === 'error' && i.code !== undefined && ARCHITECTURE_FATAL_CODES.has(i.code),
  );
  if (hasArchFatal) {
    return { issues, nodesScanned: 0 };
  }

  // Shared cache for file-content reads in Stage 4/5.
  const cache = new FileContentCache();

  // Stage 4: per-node checks.
  issues.push(...checkTypeWithoutWhenWithMapping(graph));
  const whenMismatchOutcome = await checkTypeWhenMismatch(graph, cache);
  issues.push(...whenMismatchOutcome.issues);
  const allUnreadable: ValidationIssue[] = [...whenMismatchOutcome.unreadable];
  issues.push(...(await checkFileMappingGitignored(graph)));

  issues.push(...checkSchemas(graph));
  issues.push(...checkRelationTargets(graph));
  issues.push(...checkNoCycles(graph));
  issues.push(...checkMappingOverlap(graph));
  issues.push(...(await checkMappingPathsExist(graph)));
  issues.push(...checkBrokenFlowRefs(graph));
  issues.push(...(await checkDirectoriesHaveNodeYaml(graph)));
  issues.push(...(await checkWideNodes(graph)));
  issues.push(...checkUnpairedEvents(graph));
  issues.push(...checkArchitectureConstraints(graph));
  issues.push(...checkPortAspectsDefined(graph));
  issues.push(...checkPortConsumes(graph));
  issues.push(...checkOrphanedAspects(graph));
  issues.push(...checkWhenReferences(graph));
  issues.push(...checkAspectRuleSources(graph));
  issues.push(...(await checkAspectReferences(graph)));

  // Stage 5: global checks.
  issues.push(...checkFileDuplicateMapping(graph));
  issues.push(...(await checkSecretsCredentialsOnly(graph)));
  const strictOutcome = await checkStrictBackwardCoverage(graph, cache);
  issues.push(...strictOutcome.issues);
  allUnreadable.push(...strictOutcome.unreadable);

  // De-duplicate file-unreadable by what (same file may surface from multiple checks).
  const seenUnreadable = new Set<string>();
  for (const u of allUnreadable) {
    if (!seenUnreadable.has(u.messageData.what)) {
      seenUnreadable.add(u.messageData.what);
      issues.push(u);
    }
  }

  let filtered = issues;
  let nodesScanned = graph.nodes.size;
  const normalizedScope = scope.trim().replace(/\\/g, '/').replace(/\/+$/, '');
  if (normalizedScope !== 'all' && normalizedScope) {
    if (!graph.nodes.has(normalizedScope)) {
      // Check if the node exists but has a parse error
      const parseError = (graph.nodeParseErrors ?? []).find(
        (e) => e.nodePath === normalizedScope || normalizedScope.startsWith(e.nodePath + '/'),
      );
      if (parseError) {
        return {
          issues: [{
            severity: 'error',
            code: 'yaml-invalid',
            rule: 'invalid-node-yaml',
            ...issueMsg(parseError.messageData),
            messageData: parseError.messageData,
            nodePath: parseError.nodePath,
          }],
          nodesScanned: 0,
        };
      }
      return {
        issues: [{ severity: 'error', rule: 'invalid-scope', ...issueMsg({ what: `Node not found: ${normalizedScope}`, why: 'Validation scope references a node that does not exist in the graph.', next: 'Check the node path and try again.' }) }],
        nodesScanned: 0,
      };
    }
    const scopePrefix = normalizedScope + '/';
    filtered = issues.filter((i) => !i.nodePath || i.nodePath === normalizedScope || i.nodePath.startsWith(scopePrefix));
    nodesScanned = [...graph.nodes.keys()].filter((p) => p === normalizedScope || p.startsWith(scopePrefix)).length;
  }

  return { issues: filtered, nodesScanned };
}

// --- New Stage 3/4/5 checks (implementations follow in subsequent tasks) ---

function checkTypeUnknownParent(graph: Graph): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const knownTypes = new Set(Object.keys(graph.architecture.node_types));
  for (const [typeName, typeConfig] of Object.entries(graph.architecture.node_types)) {
    for (const parent of typeConfig.parents ?? []) {
      if (!knownTypes.has(parent)) {
        issues.push({
          severity: 'error',
          code: 'type-unknown-parent',
          rule: 'type-unknown-parent',
          ...issueMsg({
            what: `Architecture type '${typeName}' declares parent '${parent}' which is not defined in node_types.`,
            why: `Parent types must be defined in yg-architecture.yaml — referencing an undefined type makes the architecture semantically invalid.`,
            next: `Add '${parent}' to node_types or remove it from '${typeName}.parents'.`,
          }),
          messageData: {
            what: `Architecture type '${typeName}' declares parent '${parent}' which is not defined in node_types.`,
            why: `Parent types must be defined in yg-architecture.yaml — referencing an undefined type makes the architecture semantically invalid.`,
            next: `Add '${parent}' to node_types or remove it from '${typeName}.parents'.`,
          },
        });
      }
    }
  }
  return issues;
}

function checkArchitectureParentCycles(graph: Graph): ValidationIssue[] {
  const types = graph.architecture.node_types;
  const typeIds = Object.keys(types);

  // Skip if any parent reference is unknown — checkTypeUnknownParent handles that
  const knownTypes = new Set(typeIds);
  for (const def of Object.values(types)) {
    if (def.parents?.some((p) => !knownTypes.has(p))) return [];
  }

  // Pass 1: DFS three-color — collect back-edges (cycle-forming edges)
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>(typeIds.map((id) => [id, WHITE]));
  const backEdges = new Set<string>();
  const recordedCycles: string[][] = [];

  function dfs(typeId: string, path: string[]): void {
    if (color.get(typeId) === GRAY) {
      const cycleStart = path.indexOf(typeId);
      if (cycleStart !== -1) recordedCycles.push([...path.slice(cycleStart), typeId]);
      const from = path[path.length - 1];
      if (from !== undefined) backEdges.add(`${from}->${typeId}`);
      return;
    }
    if (color.get(typeId) === BLACK) return;
    color.set(typeId, GRAY);
    path.push(typeId);
    for (const parent of types[typeId]?.parents ?? []) dfs(parent, path);
    path.pop();
    color.set(typeId, BLACK);
  }
  for (const id of typeIds) { if (color.get(id) === WHITE) dfs(id, []); }

  // Pass 2: BFS per type excluding back-edges — check if rootable type reachable
  function isRootable(id: string): boolean {
    const parents = types[id]?.parents;
    return !parents || parents.length === 0;
  }
  function canReachRootable(typeId: string): boolean {
    if (isRootable(typeId)) return true;
    const visited = new Set<string>([typeId]);
    const queue: string[] = [typeId];
    while (queue.length) {
      const cur = queue.shift()!;
      for (const parent of types[cur]?.parents ?? []) {
        if (backEdges.has(`${cur}->${parent}`)) continue;
        if (isRootable(parent)) return true;
        if (!visited.has(parent)) { visited.add(parent); queue.push(parent); }
      }
    }
    return false;
  }

  const trapped = typeIds.filter((id) => !canReachRootable(id));
  if (trapped.length === 0) return [];

  const cycleStr = recordedCycles.length > 0
    ? recordedCycles[0].join(' → ')
    : trapped.join(' ↔ ');
  return [{
    severity: 'error',
    code: 'architecture-cycle',
    rule: 'architecture-cycle',
    ...issueMsg({
      what: `Cycle in parents: declarations:\n  ${cycleStr}\nTrapped types: ${trapped.join(', ')}`,
      why: `Every type in the cycle can only reach other cycle members — no rootable type is reachable. Nodes of these types can never be instantiated.`,
      next: `Break the cycle: add a rootable parent (one with no parents:), remove one parents: declaration, or add a third type as alternative parent.`,
    }),
  }];
}
function checkEnforceStrictWithoutWhen(graph: Graph): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const [typeId, def] of Object.entries(graph.architecture.node_types)) {
    if (def.enforce === 'strict' && def.when === undefined) {
      issues.push({
        severity: 'error',
        code: 'enforce-strict-without-when',
        rule: 'enforce-strict-without-when',
        ...issueMsg({
          what: `Type '${typeId}' has enforce: strict but no when predicate.`,
          why: `enforce: strict requires when — it tells the validator which files must belong to a node of this type. Without when, there's no condition to evaluate.`,
          next: `Either add a when predicate to type '${typeId}', or remove enforce: strict. See schemas/yg-architecture.yaml.`,
        }),
        messageData: {
          what: `Type '${typeId}' has enforce: strict but no when predicate.`,
          why: `enforce: strict requires when — it tells the validator which files must belong to a node of this type. Without when, there's no condition to evaluate.`,
          next: `Either add a when predicate to type '${typeId}', or remove enforce: strict. See schemas/yg-architecture.yaml.`,
        },
      });
    }
  }
  return issues;
}
function checkTypeWithoutWhenWithMapping(graph: Graph): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const [nodePath, node] of graph.nodes) {
    const typeDef = graph.architecture.node_types[node.meta.type];
    if (typeDef === undefined) continue;
    if (typeDef.when !== undefined) continue;
    const mapping = node.meta.mapping ?? [];
    if (mapping.length === 0) continue;

    const preview = mapping.slice(0, 3).map((m) => `  - ${m}`).join('\n');
    const ellipsis = mapping.length > 3 ? `\n  ... (${mapping.length - 3} more)` : '';
    issues.push({
      severity: 'error',
      code: 'type-without-when-with-mapping',
      rule: 'type-without-when-with-mapping',
      nodePath,
      ...issueMsg({
        what: `Node '${nodePath}' has type '${node.meta.type}' (no \`when\` — organizational type) but mapping is not empty:\n  mapping:\n${preview}${ellipsis}`,
        why: `Types without \`when\` are organizational (parent-only). Nodes of such types cannot have mapped files.`,
        next: `Add a \`when\` predicate to type '${node.meta.type}' in yg-architecture.yaml, move the file(s) to a node whose type has \`when\`, or empty this node's mapping.`,
      }),
      messageData: {
        what: `Node '${nodePath}' has type '${node.meta.type}' (no \`when\` — organizational type) but mapping is not empty:\n  mapping:\n${preview}${ellipsis}`,
        why: `Types without \`when\` are organizational (parent-only). Nodes of such types cannot have mapped files.`,
        next: `Add a \`when\` predicate to type '${node.meta.type}' in yg-architecture.yaml, move the file(s) to a node whose type has \`when\`, or empty this node's mapping.`,
      },
    });
  }
  return issues;
}
async function checkTypeWhenMismatch(
  graph: Graph,
  cache: FileContentCache,
): Promise<{ issues: ValidationIssue[]; unreadable: ValidationIssue[] }> {
  const issues: ValidationIssue[] = [];
  const unreadable: ValidationIssue[] = [];
  const projectRoot = path.dirname(graph.rootPath);

  for (const [nodePath, node] of graph.nodes) {
    const typeDef = graph.architecture.node_types[node.meta.type];
    if (typeDef === undefined || typeDef.when === undefined) continue;
    const mapping = node.meta.mapping ?? [];
    for (const relPath of mapping) {
      const absPath = path.join(projectRoot, relPath);
      const result = await evaluateFileWhen(typeDef.when, {
        absPath,
        repoRelPath: relPath,
        projectRoot,
        cache,
      });

      if (result.unreadable) {
        unreadable.push({
          severity: 'error',
          code: 'file-unreadable',
          rule: 'file-unreadable',
          ...issueMsg({
            what: `Validator could not read '${relPath}' for when evaluation.\nOS error: ${result.unreadableReason ?? 'unknown'}`,
            why: `Type classification requires reading file content for content: predicates. Files that cannot be opened cannot be classified.`,
            next: `Fix file permissions, or remove the file from the node's mapping if it's not actually source code.`,
          }),
        });
        continue;
      }

      if (!result.result) {
        issues.push({
          severity: 'error',
          code: 'type-when-mismatch',
          rule: 'type-when-mismatch',
          nodePath,
          ...issueMsg({
            what: `File '${relPath}' is in mapping of node '${nodePath}' (type: ${node.meta.type}) but does not satisfy '${node.meta.type}'.when:\n${renderTrace(result.trace, '  ')}`,
            why: `When a node is declared as type '${node.meta.type}', every file in its mapping must satisfy the type's when predicate. This ensures type-default aspects apply to relevant code only.`,
            next: `Options:\n  1. Move file to a node of a different type that fits\n     (run: yg type-suggest --file ${relPath})\n  2. Refactor the file so it satisfies ${node.meta.type}.when\n  3. Broaden '${node.meta.type}'.when in yg-architecture.yaml`,
          }),
        });
      }
    }
  }
  return { issues, unreadable };
}
async function checkFileMappingGitignored(graph: Graph): Promise<ValidationIssue[]> {
  const projectRoot = path.dirname(graph.rootPath);
  const tracked = new Set(await walkRepoFiles(projectRoot));
  const issues: ValidationIssue[] = [];

  for (const [nodePath, node] of graph.nodes) {
    const mapping = node.meta.mapping ?? [];
    for (const relPath of mapping) {
      const absPath = path.join(projectRoot, relPath);
      let st;
      try { st = await statPath(absPath); } catch { continue; }
      if (!st.isFile()) continue;
      if (tracked.has(relPath)) continue;
      issues.push({
        severity: 'error',
        code: 'file-mapping-gitignored',
        rule: 'file-mapping-gitignored',
        nodePath,
        ...issueMsg({
          what: `File '${relPath}' is in mapping of node '${nodePath}' but is excluded by .gitignore.`,
          why: `Mappings cannot contain .gitignored files — strict backward scan skips them, creating a gap where agent-created files matching a strict type's when could evade enforcement.`,
          next: `Either:\n  1. Remove the file from .gitignore (if it should be tracked code).\n  2. Remove the file from the mapping (if it's a generated artifact).`,
        }),
      });
    }
  }
  return issues;
}
function checkFileDuplicateMapping(_graph: Graph): ValidationIssue[] { return []; }
async function checkStrictBackwardCoverage(
  graph: Graph,
  cache: FileContentCache,
): Promise<{ issues: ValidationIssue[]; unreadable: ValidationIssue[] }> {
  const strictTypes = Object.entries(graph.architecture.node_types).filter(
    ([, def]) => def.enforce === 'strict' && def.when !== undefined,
  );
  if (strictTypes.length === 0) return { issues: [], unreadable: [] };

  const projectRoot = path.dirname(graph.rootPath);

  // Build file → first owner map
  const fileToOwner = new Map<string, { nodePath: string; nodeType: string }>();
  for (const [nodePath, node] of graph.nodes) {
    for (const relPath of node.meta.mapping ?? []) {
      if (!fileToOwner.has(relPath)) fileToOwner.set(relPath, { nodePath, nodeType: node.meta.type });
    }
  }

  const repoFiles = await walkRepoFiles(projectRoot);
  const issues: ValidationIssue[] = [];
  const unreadable: ValidationIssue[] = [];
  const overlapPairsSeen = new Set<string>();

  for (const relPath of repoFiles) {
    const absPath = path.join(projectRoot, relPath);

    // Evaluate each strict type's when against this file.
    const matchingTypes: Array<{ typeId: string; trace: string }> = [];
    let fileSkipped = false;

    for (const [typeId, def] of strictTypes) {
      const result = await evaluateFileWhen(def.when!, {
        absPath,
        repoRelPath: relPath,
        projectRoot,
        cache,
      });

      if (result.unreadable) {
        unreadable.push({
          severity: 'error',
          code: 'file-unreadable',
          rule: 'file-unreadable',
          ...issueMsg({
            what: `Validator could not read '${relPath}' during strict backward scan.\nOS error: ${result.unreadableReason ?? 'unknown'}`,
            why: `Strict enforcement of type '${typeId}' requires reading file content. Files that cannot be opened cannot be classified.`,
            next: `Fix file permissions, or add to .gitignore if it's a generated artifact.`,
          }),
        });
        fileSkipped = true;
        break;
      }

      if (result.result) matchingTypes.push({ typeId, trace: renderTrace(result.trace, '  ') });
    }

    if (fileSkipped) continue;

    if (matchingTypes.length > 1) {
      // Two or more strict types claim this file — conflicting architecture.
      const sorted = matchingTypes.map((m) => m.typeId).sort();
      for (let i = 0; i < sorted.length; i++) {
        for (let j = i + 1; j < sorted.length; j++) {
          const key = `${sorted[i]}|${sorted[j]}`;
          if (overlapPairsSeen.has(key)) continue;
          overlapPairsSeen.add(key);
          issues.push({
            severity: 'error',
            code: 'strict-overlap-conflict',
            rule: 'strict-overlap-conflict',
            ...issueMsg({
              what: `Two types with enforce: strict have overlapping when predicates:\n  '${sorted[i]}'.when matches\n  '${sorted[j]}'.when matches\nExample matching file: '${relPath}'`,
              why: `Both types declare enforce: strict — each demands that any matching file be owned by a node of its type. With the one-owner rule, satisfying both simultaneously is impossible.`,
              next: `Narrow one of the when predicates so they cannot both match the same file.\nRun: yg impact --type ${sorted[i]}\nRun: yg impact --type ${sorted[j]}`,
            }),
          });
        }
      }
      continue; // Conflict supersedes orphan/misplaced for this file.
    }

    if (matchingTypes.length === 0) continue;

    const { typeId, trace } = matchingTypes[0];
    const owner = fileToOwner.get(relPath);
    if (owner === undefined) {
      issues.push({
        severity: 'error',
        code: 'type-strict-orphan',
        rule: 'type-strict-orphan',
        ...issueMsg({
          what: `File '${relPath}' satisfies when of type '${typeId}' (enforce: strict):\n${trace}\nBut file is not in any node's mapping.`,
          why: `Type '${typeId}' has enforce: strict — every file satisfying its when must belong to a mapping of a node of type '${typeId}'. Otherwise the file looks like a ${typeId} but bypasses ${typeId}-level enforcement.`,
          next: `Create yg-node.yaml with type: ${typeId} and add '${relPath}' to its mapping.`,
        }),
      });
    } else if (owner.nodeType !== typeId) {
      issues.push({
        severity: 'error',
        code: 'type-strict-misplaced',
        rule: 'type-strict-misplaced',
        nodePath: owner.nodePath,
        ...issueMsg({
          what: `File '${relPath}' satisfies when of type '${typeId}' (enforce: strict):\n${trace}\nBut is in mapping of node '${owner.nodePath}' (type: ${owner.nodeType}).`,
          why: `Type '${typeId}' has enforce: strict — every file satisfying its when must be owned by a node of type '${typeId}'. Current owner has wrong type.`,
          next: `Options:\n  1. Move mapping entry to a ${typeId}-type node.\n  2. Refactor file so it no longer matches ${typeId}.when.\n  3. Change '${owner.nodePath}' type to '${typeId}' if conceptually correct.`,
        }),
      });
    }
  }
  return { issues, unreadable };
}

// --- Rule 1: Relation targets exist ---

function findSimilar(target: string, candidates: string[]): string | null {
  if (candidates.length === 0) return null;

  let best: string | null = null;
  let bestScore = -1;

  for (const c of candidates) {
    if (c === target) return c;
    // Simple similarity: shared path segments
    const targetParts = target.split('/');
    const candParts = c.split('/');
    let score = 0;
    for (let i = 0; i < Math.min(targetParts.length, candParts.length); i++) {
      if (targetParts[i] === candParts[i]) score++;
      else break;
    }
    if (score > bestScore && score > 0) {
      bestScore = score;
      best = c;
    }
  }
  return best;
}

function checkRelationTargets(graph: Graph): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const nodePaths = [...graph.nodes.keys()];
  for (const [nodePath, node] of graph.nodes) {
    for (const rel of node.meta.relations ?? []) {
      if (!graph.nodes.has(rel.target)) {
        const suggestion = findSimilar(rel.target, nodePaths);
        const parts = rel.target.split('/');
        const parentPrefix = parts.length > 1 ? parts.slice(0, -1).join('/') + '/' : '';
        const existingInParent = nodePaths
          .filter((p) => p.startsWith(parentPrefix) && p !== rel.target)
          .map((p) => {
            const rest = p.slice(parentPrefix.length);
            return rest.split('/')[0];
          })
          .filter((v, i, a) => a.indexOf(v) === i)
          .sort();
        const existingLine =
          existingInParent.length > 0
            ? `\n     Existing nodes in ${parentPrefix || 'model/'}: ${existingInParent.join(', ')}`
            : '';
        const hint = suggestion ? `\n     Did you mean '${suggestion}'?` : '';
        issues.push({
          severity: 'error',
          code: 'relation-broken',
          rule: 'broken-relation',
          ...issueMsg({
            what: `Relation target '${rel.target}' does not exist.`,
            why: `This node declares a dependency that cannot be resolved.${existingLine}`,
            next: `Fix the target path in yg-node.yaml relations.${hint}`,
          }),
          nodePath,
        });
      }
    }
  }
  return issues;
}

// --- Rule 2: All aspect references must point to defined aspects (aspect-undefined) ---

function checkDanglingAspectRefs(graph: Graph): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const definedAspects = new Set(graph.aspects.map((a) => a.id));

  // Check node aspects
  for (const [nodePath, node] of graph.nodes) {
    for (const aspectId of node.meta.aspects ?? []) {
      if (!definedAspects.has(aspectId)) {
        issues.push({
          severity: 'error',
          code: 'aspect-undefined',
          rule: 'dangling-aspect-ref',
          nodePath,
          ...issueMsg({
            what: `Aspect '${aspectId}' is referenced by this node but not defined in aspects/.`,
            why: `Node declares an aspect that does not exist — aspect requirements cannot be verified.`,
            next: `Create aspects/${aspectId}/ with yg-aspect.yaml and content.md.`,
          }),
        });
      }
    }
    // Check port aspects
    if (node.meta.ports) {
      for (const [portName, port] of Object.entries(node.meta.ports)) {
        for (const aspectId of port.aspects) {
          if (!definedAspects.has(aspectId)) {
            issues.push({
              severity: 'error',
              code: 'aspect-undefined',
              rule: 'dangling-aspect-ref',
              nodePath,
              ...issueMsg({
                what: `Aspect '${aspectId}' is referenced by port '${portName}' but not defined in aspects/.`,
                why: `Port declares a required aspect that does not exist — port contracts cannot be enforced.`,
                next: `Create aspects/${aspectId}/ with yg-aspect.yaml and content.md.`,
              }),
            });
          }
        }
      }
    }
  }

  // Check architecture aspects
  for (const [typeId, typeDef] of Object.entries(graph.architecture?.node_types ?? {})) {
    for (const aspectId of typeDef.aspects ?? []) {
      if (!definedAspects.has(aspectId)) {
        issues.push({
          severity: 'error',
          code: 'aspect-undefined',
          rule: 'dangling-aspect-ref',
          ...issueMsg({
            what: `Aspect '${aspectId}' is referenced by architecture type '${typeId}' but not defined in aspects/.`,
            why: `Architecture declares a required aspect that does not exist.`,
            next: `Create aspects/${aspectId}/ with yg-aspect.yaml and content.md.`,
          }),
        });
      }
    }
  }

  // Check flow aspects
  for (const flow of graph.flows) {
    for (const aspectId of flow.aspects ?? []) {
      if (!definedAspects.has(aspectId)) {
        issues.push({
          severity: 'error',
          code: 'aspect-undefined',
          rule: 'dangling-aspect-ref',
          ...issueMsg({
            what: `Aspect '${aspectId}' is referenced by flow '${flow.name}' but not defined in aspects/.`,
            why: `Flow declares an aspect that does not exist — flow requirements cannot propagate.`,
            next: `Create aspects/${aspectId}/ with yg-aspect.yaml and content.md.`,
          }),
        });
      }
    }
  }

  return issues;
}

// --- Rule 3: Aspect ids (derived from directory path) — always valid when aspect exists ---

function checkAspectIds(_graph: Graph): ValidationIssue[] {
  // validAspectIds = graph.aspects.map(a => a.id), so every aspect's id is valid by definition
  return [];
}

function checkAspectIdUniqueness(graph: Graph): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const byId = new Map<string, string[]>();
  for (const aspect of graph.aspects) {
    const names = byId.get(aspect.id) ?? [];
    names.push(aspect.name);
    byId.set(aspect.id, names);
  }
  for (const [id, names] of byId) {
    if (names.length <= 1) continue;
    issues.push({
      severity: 'error',
      code: 'duplicate-aspect-id',
      rule: 'duplicate-aspect-binding',
      ...issueMsg({
        what: `Aspect '${id}' is bound to multiple aspects (${names.join(', ')}).`,
        why: `Aspect ids must be unique — duplicate ids cause ambiguous aspect resolution.`,
        next: `Rename one of the aspect directories to make ids unique.`,
      }),
    });
  }
  return issues;
}

// --- Rule: Implied aspects exist ---

function checkImpliedAspectsExist(graph: Graph): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const idToAspect = new Map<string, { name: string }>();
  for (const a of graph.aspects) {
    idToAspect.set(a.id, { name: a.name });
  }
  for (const aspect of graph.aspects) {
    for (const impliedId of aspect.implies ?? []) {
      if (!idToAspect.has(impliedId)) {
        issues.push({
          severity: 'error',
          code: 'implied-aspect-missing',
          rule: 'implied-aspect-missing',
          ...issueMsg({
            what: `Aspect '${aspect.name}' implies '${impliedId}' but no aspect with that id exists in aspects/.`,
            why: `Implies chain is broken — implied aspect requirements cannot be resolved.`,
            next: `Create the implied aspect or remove it from the implies list.`,
          }),
        });
      }
    }
  }
  return issues;
}

// --- Rule: No cycles in aspect implies graph ---

function checkImpliesNoCycles(graph: Graph): ValidationIssue[] {
  const idToAspect = new Map<string, { implies?: string[] }>();
  for (const a of graph.aspects) {
    idToAspect.set(a.id, { implies: a.implies });
  }
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  for (const id of idToAspect.keys()) color.set(id, WHITE);

  const issues: ValidationIssue[] = [];

  function dfs(id: string, pathArr: string[]): boolean {
    color.set(id, GRAY);
    pathArr.push(id);
    const aspect = idToAspect.get(id);
    for (const implied of aspect?.implies ?? []) {
      if (color.get(implied) === GRAY) {
        const cycle = pathArr.slice(pathArr.indexOf(implied)).concat(implied);
        issues.push({
          severity: 'error',
          code: 'aspect-implies-cycle',
          rule: 'aspect-implies-cycle',
          ...issueMsg({
            what: `Aspect implies cycle: ${cycle.join(' → ')}.`,
            why: `Cycles in implies prevent aspect resolution.`,
            next: `Break the cycle by removing one implies edge.`,
          }),
        });
        pathArr.pop();
        color.set(id, BLACK);
        return true;
      }
      if (color.get(implied) === WHITE && dfs(implied, pathArr)) {
        pathArr.pop();
        color.set(id, BLACK);
        return true;
      }
    }
    pathArr.pop();
    color.set(id, BLACK);
    return false;
  }

  for (const id of idToAspect.keys()) {
    if (color.get(id) === WHITE) {
      dfs(id, []);
    }
  }
  return issues;
}

// --- Rule 4: No circular dependencies ---

function checkNoCycles(graph: Graph): ValidationIssue[] {
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  for (const p of graph.nodes.keys()) color.set(p, WHITE);

  const issues: ValidationIssue[] = [];

  function dfs(nodePath: string, pathSegments: string[]): boolean {
    color.set(nodePath, GRAY);
    const node = graph.nodes.get(nodePath)!;
    const structuralTypes = new Set(['uses', 'calls', 'extends', 'implements']);
    for (const rel of node.meta.relations ?? []) {
      const targetNode = graph.nodes.get(rel.target);
      if (!targetNode) continue;
      if (!structuralTypes.has(rel.type)) continue;
      if (color.get(rel.target) === GRAY) {
        const cyclePath = [...pathSegments, nodePath, rel.target];
        issues.push({
          severity: 'error',
          code: 'structural-cycle',
          rule: 'structural-cycle',
          ...issueMsg({
            what: `Circular dependency: ${cyclePath.join(' -> ')}.`,
            why: `Cycles prevent deterministic context assembly and cascade tracking.`,
            next: `Break the cycle: extract a shared interface, invert a dependency, or merge nodes.`,
          }),
        });
        return true;
      }
      if (color.get(rel.target) === WHITE) {
        if (dfs(rel.target, [...pathSegments, nodePath])) return true;
      }
    }
    color.set(nodePath, BLACK);
    return false;
  }

  for (const nodePath of graph.nodes.keys()) {
    if (color.get(nodePath) === WHITE) {
      dfs(nodePath, []);
    }
  }

  return issues;
}

// --- Rule 5: Mapping ownership overlap ---

function normalizePathForCompare(mappingPath: string): string {
  return mappingPath.trim().replace(/\\/g, '/').replace(/\/+$/, '');
}

function arePathsOverlapping(pathA: string, pathB: string): boolean {
  if (pathA === pathB) return true;
  return pathA.startsWith(pathB + '/') || pathB.startsWith(pathA + '/');
}

function isAncestorNode(possibleAncestor: string, possibleDescendant: string): boolean {
  return possibleDescendant.startsWith(possibleAncestor + '/');
}

function checkMappingOverlap(graph: Graph): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const ownership: Array<{ nodePath: string; mappingPath: string }> = [];

  for (const [nodePath, node] of graph.nodes) {
    const mappingPaths = normalizeMappingPaths(node.meta.mapping)
      .map(normalizePathForCompare)
      .filter((mappingPath) => mappingPath.length > 0);
    for (const mappingPath of mappingPaths) {
      ownership.push({ nodePath, mappingPath });
    }
  }

  for (let index = 0; index < ownership.length; index++) {
    const current = ownership[index];
    for (let nestedIndex = index + 1; nestedIndex < ownership.length; nestedIndex++) {
      const candidate = ownership[nestedIndex];
      if (current.nodePath === candidate.nodePath) continue;
      if (!arePathsOverlapping(current.mappingPath, candidate.mappingPath)) continue;

      if (current.mappingPath === candidate.mappingPath) {
        issues.push({
          severity: 'error',
          code: 'file-duplicate-mapping',
          rule: 'file-duplicate-mapping',
          nodePath: candidate.nodePath,
          ...issueMsg({
            what: `File '${current.mappingPath}' appears in mappings of multiple nodes:\n  ${current.nodePath}\n  ${candidate.nodePath}`,
            why: `Each source file must have exactly one owner node. Duplicate mappings lead to ambiguous classification and conflicting aspect attribution.`,
            next: `Remove the file from one of the mappings. Decide which node logically owns the file based on its primary role. The other node should reference it via relations if needed.`,
          }),
        });
        continue;
      }

      // Allow containment overlaps between ancestor-descendant nodes ("child wins" model).
      const isHierarchical =
        isAncestorNode(current.nodePath, candidate.nodePath) ||
        isAncestorNode(candidate.nodePath, current.nodePath);

      if (isHierarchical) continue;

      issues.push({
        severity: 'error',
        code: 'overlapping-mapping',
        rule: 'overlapping-mapping',
        ...issueMsg({
          what: `Mapping paths '${current.mappingPath}' (${current.nodePath}) and '${candidate.mappingPath}' (${candidate.nodePath}) overlap.`,
          why: `Each source file must have exactly one owner node.`,
          next: `Keep one owner mapping and model other concerns via relations.`,
        }),
        nodePath: candidate.nodePath,
      });
    }
  }

  return issues;
}

// --- Rule: Mapping paths should exist on disk (mapping-path-missing) ---

async function checkMappingPathsExist(graph: Graph): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  const projectRoot = path.dirname(graph.rootPath);
  for (const [nodePath, node] of graph.nodes) {
    const mappingPaths = normalizeMappingPaths(node.meta.mapping);
    for (const mp of mappingPaths) {
      const absPath = path.join(projectRoot, mp);
      try {
        await fileAccess(absPath);
      } catch {
        issues.push({
          severity: 'error',
          code: 'mapping-path-missing',
          rule: 'mapping-path-missing',
          ...issueMsg({
            what: `Mapping path '${mp}' does not exist on disk.`,
            why: `Node maps a file that was deleted or moved.`,
            next: `Update mapping in yg-node.yaml: fix the path or remove the entry.`,
          }),
          nodePath,
        });
      }
    }
  }
  return issues;
}


// --- flow-node-broken: Broken flow refs (flow.nodes) ---

function checkBrokenFlowRefs(graph: Graph): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const nodePaths = new Set(graph.nodes.keys());
  for (const flow of graph.flows) {
    for (const n of flow.nodes) {
      if (!nodePaths.has(n)) {
        issues.push({
          severity: 'error',
          code: 'flow-node-broken',
          rule: 'broken-flow-ref',
          ...issueMsg({
            what: `Flow '${flow.name}' references non-existent node '${n}'.`,
            why: `Flow participants must exist in the graph.`,
            next: `Fix the nodes list in yg-flow.yaml or create the missing node.`,
          }),
        });
      }
    }
  }
  return issues;
}

// --- wide-node: Maps too many source files ---

async function checkWideNodes(graph: Graph): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  const maxFiles = graph.config.quality?.max_mapping_source_files ?? 10;
  const projectRoot = path.dirname(graph.rootPath);

  for (const [nodePath, node] of graph.nodes) {
    const effectiveAspects = computeEffectiveAspects(node, graph);
    if (effectiveAspects.size === 0) continue;
    const mappingPaths = normalizeMappingPaths(node.meta.mapping);
    if (mappingPaths.length === 0) continue;

    const sourceFiles = await expandMappingPaths(projectRoot, mappingPaths);
    if (sourceFiles.length <= maxFiles) continue;

    issues.push({
      severity: 'warning',
      code: 'wide-node',
      rule: 'wide-node',
      ...issueMsg({
        what: `Node maps ${sourceFiles.length} source files (max: ${maxFiles}).`,
        why: `Wide nodes degrade reviewer accuracy — the reviewer verifies aspects against all source files at once. Too many files dilute focus and cause false rejections.`,
        next: `Split into child nodes with 2-5 source files each. Each child should map only the files relevant to its aspects.`,
      }),
      nodePath,
    });
  }
  return issues;
}

// --- high-fan-out: Exceeds max_direct_relations ---

function checkHighFanOut(graph: Graph): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const maxRel = graph.config.quality?.max_direct_relations ?? 10;
  for (const [nodePath, node] of graph.nodes) {
    const count = node.meta.relations?.length ?? 0;
    if (count > maxRel) {
      issues.push({
        severity: 'warning',
        code: 'high-fan-out',
        rule: 'high-fan-out',
        ...issueMsg({
          what: `Node has ${count} direct relations (max: ${maxRel}).`,
          why: `High fan-out makes context packages large and suggests unclear separation of concerns.`,
          next: `Consider splitting responsibilities or introducing an intermediary node.`,
        }),
        nodePath,
      });
    }
  }
  return issues;
}

// --- unpaired-event: Unpaired event relations (emits without listens or vice versa) ---

function checkUnpairedEvents(graph: Graph): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const emitsTo = new Map<string, Set<string>>();
  const listensFrom = new Map<string, Set<string>>();
  for (const [nodePath, node] of graph.nodes) {
    for (const rel of node.meta.relations ?? []) {
      if (rel.type === 'emits') {
        const set = emitsTo.get(nodePath) ?? new Set();
        set.add(rel.target);
        emitsTo.set(nodePath, set);
      }
      if (rel.type === 'listens') {
        const set = listensFrom.get(nodePath) ?? new Set();
        set.add(rel.target);
        listensFrom.set(nodePath, set);
      }
    }
  }
  for (const [emitter, targets] of emitsTo) {
    for (const target of targets) {
      const listenerSet = listensFrom.get(target);
      if (!listenerSet?.has(emitter)) {
        issues.push({
          severity: 'error',
          code: 'event-unpaired',
          rule: 'unpaired-event',
          ...issueMsg({
            what: `Node '${emitter}' emits to '${target}' but '${target}' has no listens from '${emitter}'.`,
            why: `Events need paired emits/listens for flow tracking.`,
            next: `Add the complementary event relation.`,
          }),
          nodePath: emitter,
        });
      }
    }
  }
  for (const [listener, sources] of listensFrom) {
    for (const source of sources) {
      const emitterSet = emitsTo.get(source);
      if (!emitterSet?.has(listener)) {
        issues.push({
          severity: 'error',
          code: 'event-unpaired',
          rule: 'unpaired-event',
          ...issueMsg({
            what: `Node '${listener}' listens from '${source}' but '${source}' has no emits to '${listener}'.`,
            why: `Events need paired emits/listens for flow tracking.`,
            next: `Add the complementary event relation.`,
          }),
          nodePath: listener,
        });
      }
    }
  }
  return issues;
}

// --- Schema validation (required graph-layer schemas present in schemas/) ---

const REQUIRED_SCHEMAS = ['node', 'aspect', 'flow'] as const;

function checkSchemas(graph: Graph): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const present = new Set(graph.schemas.map((s) => s.schemaType));

  for (const required of REQUIRED_SCHEMAS) {
    if (!present.has(required)) {
      issues.push({
        severity: 'error',
        code: 'schema-missing',
        rule: 'missing-schema',
        ...issueMsg({
          what: `Schema 'yg-${required}.yaml' missing from .yggdrasil/schemas/.`,
          why: `Schemas validate graph elements — missing schemas allow invalid ${required} definitions.`,
          next: `Run yg init to restore missing schemas.`,
        }),
      });
    }
  }

  return issues;
}

// --- Directories have yg-node.yaml ---

async function checkDirectoriesHaveNodeYaml(graph: Graph): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  const modelDir = path.join(graph.rootPath, 'model');

  async function scanDir(dirPath: string, segments: string[]): Promise<void> {
    const entries = await readSortedDir(dirPath);
    const hasNodeYaml = entries.some((e) => e.isFile() && e.name === 'yg-node.yaml');

    const hasFiles = entries.some((e) => e.isFile());
    const graphPath = segments.join('/');

    if (!hasNodeYaml && graphPath !== '') {
      if (hasFiles) {
        issues.push({
          severity: 'error',
          code: 'node-yaml-missing',
          rule: 'missing-node-yaml',
          ...issueMsg({
            what: `Directory '${graphPath}' has files but no yg-node.yaml.`,
            why: `Every directory in model/ must have a node definition.`,
            next: `Create yg-node.yaml in ${graphPath}/ or move files to an existing node directory.`,
          }),
          nodePath: graphPath,
        });
      }
      // directory-without-node covered by unmapped-files check
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.')) continue;
      await scanDir(path.join(dirPath, entry.name), [...segments, entry.name]);
    }
  }

  try {
    const rootEntries = await readSortedDir(modelDir);
    for (const entry of rootEntries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.')) continue;
      await scanDir(path.join(modelDir, entry.name), [entry.name]);
    }
  } catch {
    // model/ may not exist
  }

  return issues;
}

// --- Mapping expansion utility ---


// --- missing-description: Missing description on nodes, aspects, and flows ---

function checkMissingDescriptions(graph: Graph): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  // Nodes
  for (const [nodePath, node] of graph.nodes) {
    if (!node.meta.description?.trim()) {
      issues.push({
        severity: 'error',
        code: 'description-missing',
        rule: 'missing-description',
        ...issueMsg({
          what: `Node has no description.`,
          why: `Description is used in context output — agents need it for orientation.`,
          next: `Add a description field to yg-node.yaml.`,
        }),
        nodePath,
      });
    }
  }

  // Aspects
  for (const aspect of graph.aspects) {
    if (!aspect.description?.trim()) {
      issues.push({
        severity: 'error',
        code: 'description-missing',
        rule: 'missing-description',
        ...issueMsg({
          what: `Aspect '${aspect.id}' has no description.`,
          why: `Description is used in context output — agents need it for orientation.`,
          next: `Add a description field to yg-aspect.yaml.`,
        }),
      });
    }

    if (aspect.reviewer.type === 'ast') {
      if (aspect.language === undefined) {
        issues.push({
          severity: 'error',
          code: 'aspect-ast-missing-language',
          rule: 'aspect-language-shape',
          ...issueMsg({
            what: `AST aspect '${aspect.id}' is missing required 'language:' field.`,
            why: `AST aspects must declare which languages they target so the runner knows which tree-sitter grammar to load.`,
            next: `Add 'language: [<lang>, ...]' to aspects/${aspect.id}/yg-aspect.yaml. Known: ${Object.keys(LANGUAGES).sort().join(', ')}.`,
          }),
        });
      } else if (!Array.isArray(aspect.language)) {
        issues.push({
          severity: 'error',
          code: 'aspect-language-not-array',
          rule: 'aspect-language-shape',
          ...issueMsg({
            what: `AST aspect '${aspect.id}' has 'language:' as a scalar; must be an array.`,
            why: `Even single-language aspects use array syntax for consistency with multi-language aspects.`,
            next: `Change 'language: ${String(aspect.language)}' to 'language: [${String(aspect.language)}]' in aspects/${aspect.id}/yg-aspect.yaml.`,
          }),
        });
      } else if (aspect.language.length === 0) {
        issues.push({
          severity: 'error',
          code: 'aspect-empty-language-list',
          rule: 'aspect-language-shape',
          ...issueMsg({
            what: `AST aspect '${aspect.id}' has 'language: []' — an empty list.`,
            why: `An AST aspect must target at least one language so the runner knows which grammar to use.`,
            next: `Add at least one language id to aspects/${aspect.id}/yg-aspect.yaml. Known: ${Object.keys(LANGUAGES).sort().join(', ')}.`,
          }),
        });
      } else {
        for (const lang of aspect.language) {
          if (!(lang in LANGUAGES)) {
            issues.push({
              severity: 'error',
              code: 'aspect-unknown-language',
              rule: 'aspect-language-shape',
              ...issueMsg({
                what: `AST aspect '${aspect.id}' references unknown language '${lang}'.`,
                why: `Language must be registered in the language registry before it can be used.`,
                next: `Known languages: ${Object.keys(LANGUAGES).sort().join(', ')}. Check aspects/${aspect.id}/yg-aspect.yaml.`,
              }),
            });
          }
        }
      }
    }

    if (aspect.reviewer.type !== 'ast' && Array.isArray(aspect.language)) {
      for (const lang of aspect.language) {
        if (!(lang in LANGUAGES)) {
          issues.push({
            severity: 'error',
            code: 'aspect-unknown-language',
            rule: 'aspect-language-shape',
            ...issueMsg({
              what: `Aspect '${aspect.id}' references unknown language '${lang}'.`,
              why: `Language must be registered in the language registry before it can be used.`,
              next: `Known languages: ${Object.keys(LANGUAGES).sort().join(', ')}. Check aspects/${aspect.id}/yg-aspect.yaml.`,
            }),
          });
        }
      }
    }
  }

  // Flows
  for (const flow of graph.flows) {
    if (!flow.description?.trim()) {
      issues.push({
        severity: 'error',
        code: 'description-missing',
        rule: 'missing-description',
        ...issueMsg({
          what: `Flow '${flow.name}' has no description.`,
          why: `Description is used in context output — agents need it for orientation.`,
          next: `Add a description field to yg-flow.yaml.`,
        }),
      });
    }
  }

  return issues;
}

// --- Architecture Constraints (invalid-relation-target, invalid-parent-type) ---
// Note: aspect-undefined (dangling-aspect-ref) is generated by checkDanglingAspectRefs above (line ~184).

function checkArchitectureConstraints(graph: Graph): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  // invalid-relation-target and invalid-parent-type require architecture to be defined and loaded
  // Only validate if architecture has node_types entries
  if (!graph.architecture || Object.keys(graph.architecture.node_types).length === 0) {
    return issues;
  }

  // type-undefined: node uses a type not defined in architecture
  issues.push(...checkNodeTypesExist(graph));

  // invalid-relation-target (sync, no I/O)
  issues.push(...checkArchitectureRelations(graph));

  // invalid-parent-type (sync, no I/O)
  issues.push(...checkArchitectureParents(graph));

  return issues;
}

function checkNodeTypesExist(graph: Graph): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const allowedTypes = new Set(Object.keys(graph.architecture!.node_types));

  for (const [nodePath, node] of graph.nodes) {
    if (!allowedTypes.has(node.meta.type)) {
      issues.push({
        severity: 'error',
        code: 'type-undefined',
        rule: 'unknown-node-type',
        ...issueMsg({
          what: `Node type '${node.meta.type}' is not defined in yg-architecture.yaml.`,
          why: `Allowed types: ${[...allowedTypes].join(', ')}.`,
          next: `Add '${node.meta.type}' to yg-architecture.yaml or change the node type.`,
        }),
        nodePath,
      });
    }
  }
  return issues;
}

/**
 * integration-aspect-missing
 * When a node consumes a port, that port's required aspects must be defined in aspects/.
 */
function checkPortAspectsDefined(graph: Graph): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const definedAspects = new Set(graph.aspects.map((a) => a.id));

  for (const [nodePath, node] of graph.nodes) {
    for (const rel of node.meta.relations ?? []) {
      const target = graph.nodes.get(rel.target);
      if (!target?.meta.ports) continue;

      for (const portName of rel.consumes ?? []) {
        const port = target.meta.ports[portName];
        if (!port) continue; // unknown-port catches this
        for (const aspectId of port.aspects) {
          if (!definedAspects.has(aspectId)) {
            issues.push({
              severity: 'error',
              code: 'port-missing-aspect',
              rule: 'integration-aspect-missing',
              nodePath,
              ...issueMsg({
                what: `Relation: ${rel.type} -> ${rel.target}, port '${portName}'`,
                why: `Port requires aspect '${aspectId}' but it is not defined in aspects/ — port contracts are broken.`,
                next: `Create aspects/${aspectId}/ with yg-aspect.yaml and content.md.`,
              }),
            });
          }
        }
      }
    }
  }

  return issues;
}

/**
 * invalid-relation-target
 * Relation target type must be in architecture's allowed list for the relation type.
 */
function checkArchitectureRelations(graph: Graph): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  for (const [nodePath, node] of graph.nodes) {
    const typeConfig = graph.architecture.node_types[node.meta.type];
    if (!typeConfig?.relations || !node.meta.relations || node.meta.relations.length === 0) {
      continue;
    }

    for (const rel of node.meta.relations) {
      const allowedTypes = typeConfig.relations[rel.type];
      if (!allowedTypes) continue; // Unconstrained relation type

      const target = graph.nodes.get(rel.target);
      if (!target) continue; // relation-target-missing catches this

      if (!allowedTypes.includes(target.meta.type)) {
        issues.push({
          severity: 'error',
          code: 'relation-target-forbidden',
          rule: 'invalid-relation-target',
          nodePath,
          ...issueMsg({
            what: `Relation: ${rel.type} -> ${rel.target} (type: ${target.meta.type})`,
            why: `Architecture does not allow type '${node.meta.type}' to '${rel.type}' type '${target.meta.type}'. Allowed targets for '${rel.type}': [${allowedTypes.join(', ')}]`,
            next: `Either change the relation type, change the target node's type, or update yg-architecture.yaml to allow this relation.`,
          }),
        });
      }
    }
  }

  return issues;
}

/**
 * invalid-parent-type
 * Parent type must be in architecture's allowed list for this node type.
 */
function checkArchitectureParents(graph: Graph): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  for (const [nodePath, node] of graph.nodes) {
    const typeConfig = graph.architecture.node_types[node.meta.type];
    if (!typeConfig?.parents || !node.parent) {
      continue;
    }

    if (!typeConfig.parents.includes(node.parent.meta.type)) {
      issues.push({
        severity: 'error',
        code: 'parent-type-forbidden',
        rule: 'invalid-parent-type',
        nodePath,
        ...issueMsg({
          what: `Parent: ${node.parent.path} (type: ${node.parent.meta.type})`,
          why: `Architecture does not allow type '${node.meta.type}' under parent type '${node.parent.meta.type}'. Allowed parents: [${typeConfig.parents.join(', ')}]`,
          next: `Either move this node under an allowed parent type, change this node's type, or update yg-architecture.yaml to allow this parent.`,
        }),
      });
    }
  }

  return issues;
}

/**
 * missing-consumes
 * When a relation target has non-empty ports, the consumer must declare which port(s) it consumes.
 *
 * unknown-port
 * When a consumer's consumes list references a port name that does not exist on the target.
 */
function checkPortConsumes(graph: Graph): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  for (const [nodePath, node] of graph.nodes) {
    for (const rel of node.meta.relations ?? []) {
      // Skip event relations — they don't consume ports
      if (rel.type === 'emits' || rel.type === 'listens') continue;

      const target = graph.nodes.get(rel.target);
      const hasPorts = target?.meta.ports && Object.keys(target.meta.ports).length > 0;

      // consumes-without-ports: consumes on a relation to a target without ports
      if (!hasPorts && rel.consumes && rel.consumes.length > 0) {
        issues.push({
          severity: 'error',
          code: 'consumes-without-ports',
          rule: 'consumes-without-ports',
          nodePath,
          ...issueMsg({
            what: `Relation: ${rel.type} -> ${rel.target} declares consumes: [${rel.consumes.join(', ')}]`,
            why: `Target has no ports. consumes is only meaningful when the target declares ports with required aspects.`,
            next: `Remove consumes from this relation in yg-node.yaml.`,
          }),
        });
        continue;
      }

      if (!hasPorts) continue;
      const ports = target!.meta.ports!;

      // missing-consumes: target has ports but consumer has no consumes
      if (!rel.consumes || rel.consumes.length === 0) {
        const portNames = Object.keys(ports);
        issues.push({
          severity: 'error',
          code: 'port-missing-consumes',
          rule: 'missing-consumes',
          nodePath,
          ...issueMsg({
            what: `Relation: ${rel.type} -> ${rel.target}`,
            why: `Target has ports: [${portNames.join(', ')}] — port-required aspects won't be verified without a consumes declaration.`,
            next: `Add consumes: [<port-names>] to this relation in yg-node.yaml.`,
          }),
        });
        continue;
      }

      // unknown-port: consumes references non-existent port
      for (const portName of rel.consumes) {
        if (!(portName in ports)) {
          const available = Object.keys(ports);
          issues.push({
            severity: 'error',
            code: 'port-undefined',
            rule: 'unknown-port',
            nodePath,
            ...issueMsg({
              what: `Relation: ${rel.type} -> ${rel.target}, port '${portName}' not found.`,
              why: `Port contract cannot be enforced for an undefined port. Available ports: [${available.join(', ')}]`,
              next: `Fix the port name in consumes, or add the port definition to the target node.`,
            }),
          });
        }
      }
    }
  }

  return issues;
}

/**
 * orphaned-aspect
 * An aspect defined in aspects/ is not referenced by any node, architecture type, or flow.
 * Implied aspects are exempt when the aspect that implies them is itself referenced.
 */
function checkOrphanedAspects(graph: Graph): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const referenced = new Set<string>();

  // Collect direct references from nodes (aspects field and port aspects)
  for (const [, node] of graph.nodes) {
    for (const a of node.meta.aspects ?? []) referenced.add(a);
    if (node.meta.ports) {
      for (const port of Object.values(node.meta.ports)) {
        for (const a of port.aspects) referenced.add(a);
      }
    }
  }

  // Collect references from architecture node_types
  for (const typeDef of Object.values(graph.architecture?.node_types ?? {})) {
    for (const a of typeDef.aspects ?? []) referenced.add(a);
  }

  // Collect references from flows
  for (const flow of graph.flows) {
    for (const a of flow.aspects ?? []) referenced.add(a);
  }

  // Propagate: aspects implied by a referenced aspect are also considered referenced
  // (iterate to fixpoint in case of chains)
  let changed = true;
  while (changed) {
    changed = false;
    for (const aspect of graph.aspects) {
      if (referenced.has(aspect.id) && aspect.implies) {
        for (const implied of aspect.implies) {
          if (!referenced.has(implied)) {
            referenced.add(implied);
            changed = true;
          }
        }
      }
    }
  }

  for (const aspect of graph.aspects) {
    if (!referenced.has(aspect.id)) {
      issues.push({
        severity: 'warning',
        code: 'orphaned-aspect',
        rule: 'orphaned-aspect',
        nodePath: `aspects/${aspect.id}`,
        ...issueMsg({
          what: `Aspect '${aspect.id}' is defined but not referenced by any node, architecture type, or flow.`,
          why: `Orphaned aspects add noise to the graph without enforcing any requirements.`,
          next: `Either add it to a node/architecture/flow or remove it.`,
        }),
      });
    }
  }

  return issues;
}

/**
 * when-unknown-type / when-unknown-node / when-unknown-port
 * Validates that every declared `when` predicate references types/nodes/ports
 * that actually exist in the graph.
 */
function checkWhenReferences(graph: Graph): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const knownTypes = new Set(Object.keys(graph.architecture?.node_types ?? {}));

  const visitPredicate = (p: WhenPredicate, ctx: string): void => {
    if ('all_of' in p) { p.all_of.forEach((c, i) => visitPredicate(c, `${ctx}/all_of[${i}]`)); return; }
    if ('any_of' in p) { p.any_of.forEach((c, i) => visitPredicate(c, `${ctx}/any_of[${i}]`)); return; }
    if ('not' in p) { visitPredicate(p.not, `${ctx}/not`); return; }
    visitAtomic(p, ctx);
  };

  const visitAtomic = (a: AtomicClause, ctx: string): void => {
    if (a.relations) visitRelationClause(a.relations, `${ctx}/relations`);
    if (a.descendants) visitDescendantsClause(a.descendants, `${ctx}/descendants`);
    if (a.node) visitNodeClause(a.node, `${ctx}/node`);
  };

  const visitRelationClause = (rc: RelationClause, ctx: string): void => {
    for (const [relType, match] of Object.entries(rc)) {
      if (!match) continue;
      if (match.target_type !== undefined && !knownTypes.has(match.target_type)) {
        issues.push({
          severity: 'error',
          code: 'when-unknown-type',
          rule: 'when-unknown-type',
          ...issueMsg({
            what: `Unknown node type '${match.target_type}' in when at ${ctx}/${relType}.target_type.`,
            why: 'The predicate references a type that is not defined in yg-architecture.yaml; it will never evaluate.',
            next: `Fix the type name or define it in yg-architecture.yaml. Known types: ${Array.from(knownTypes).join(', ')}.`,
          }),
        });
      }
      if (match.target !== undefined && !graph.nodes.has(match.target)) {
        issues.push({
          severity: 'error',
          code: 'when-unknown-node',
          rule: 'when-unknown-node',
          ...issueMsg({
            what: `Referenced node '${match.target}' in when at ${ctx}/${relType}.target does not exist.`,
            why: 'The predicate targets a node that is not in the graph.',
            next: `Fix the node path or add the node under .yggdrasil/model/.`,
          }),
        });
      }
      if (match.consumes_port !== undefined && match.target !== undefined) {
        const tgt = graph.nodes.get(match.target);
        if (tgt && !(tgt.meta.ports && match.consumes_port in tgt.meta.ports)) {
          issues.push({
            severity: 'error',
            code: 'when-unknown-port',
            rule: 'when-unknown-port',
            ...issueMsg({
              what: `Port '${match.consumes_port}' is not declared on node '${match.target}' in when at ${ctx}/${relType}.consumes_port.`,
              why: 'The predicate references a port that does not exist on the target node.',
              next: `Fix the port name or add it to .yggdrasil/model/${match.target}/yg-node.yaml.`,
            }),
          });
        }
      }
    }
  };

  const visitDescendantsClause = (dc: DescendantsClause, ctx: string): void => {
    if (dc.relations) visitRelationClause(dc.relations, `${ctx}/relations`);
    if (dc.type !== undefined && !knownTypes.has(dc.type)) {
      issues.push({
        severity: 'error',
        code: 'when-unknown-type',
        rule: 'when-unknown-type',
        ...issueMsg({
          what: `Unknown node type '${dc.type}' in when at ${ctx}/type.`,
          why: 'The predicate references a type that is not defined in yg-architecture.yaml.',
          next: `Fix the type name or define it in yg-architecture.yaml. Known types: ${Array.from(knownTypes).join(', ')}.`,
        }),
      });
    }
  };

  const visitNodeClause = (nc: NodeClause, ctx: string): void => {
    if (nc.type !== undefined && !knownTypes.has(nc.type)) {
      issues.push({
        severity: 'error',
        code: 'when-unknown-type',
        rule: 'when-unknown-type',
        ...issueMsg({
          what: `Unknown node type '${nc.type}' in when at ${ctx}/type.`,
          why: 'The predicate references a type that is not defined in yg-architecture.yaml.',
          next: `Fix the type name or define it in yg-architecture.yaml. Known types: ${Array.from(knownTypes).join(', ')}.`,
        }),
      });
    }
  };

  // 1. Aspect global and impliesWhens
  for (const aspect of graph.aspects) {
    if (aspect.when) visitPredicate(aspect.when, `aspect '${aspect.id}' when`);
    if (aspect.impliesWhens) {
      for (const [targetId, pred] of Object.entries(aspect.impliesWhens)) {
        visitPredicate(pred, `aspect '${aspect.id}' implies[${targetId}] when`);
      }
    }
  }

  // 2. Architecture type defaults
  if (graph.architecture) {
    for (const [typeName, typeDef] of Object.entries(graph.architecture.node_types)) {
      if (!typeDef.aspectWhens) continue;
      for (const [aspectId, pred] of Object.entries(typeDef.aspectWhens)) {
        visitPredicate(pred, `architecture node_types.${typeName} aspectWhens[${aspectId}]`);
      }
    }
  }

  // 3. Nodes
  for (const [nodePath, node] of graph.nodes) {
    if (node.meta.aspectWhens) {
      for (const [aspectId, pred] of Object.entries(node.meta.aspectWhens)) {
        visitPredicate(pred, `node '${nodePath}' aspectWhens[${aspectId}]`);
      }
    }
    if (node.meta.ports) {
      for (const [portName, portDef] of Object.entries(node.meta.ports)) {
        if (!portDef.aspectWhens) continue;
        for (const [aspectId, pred] of Object.entries(portDef.aspectWhens)) {
          visitPredicate(pred, `node '${nodePath}' ports.${portName} aspectWhens[${aspectId}]`);
        }
      }
    }
  }

  // 4. Flows
  for (const flow of graph.flows) {
    if (!flow.aspectWhens) continue;
    for (const [aspectId, pred] of Object.entries(flow.aspectWhens)) {
      visitPredicate(pred, `flow '${flow.path}' aspectWhens[${aspectId}]`);
    }
  }

  return issues;
}

// --- aspect-rule-sources: content.md vs check.mjs mutual exclusion ---

function checkAspectRuleSources(graph: Graph): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const projectRoot = path.dirname(graph.rootPath);

  for (const aspect of graph.aspects) {
    const reviewer = aspect.reviewer.type;
    if (reviewer !== 'ast' && reviewer !== 'llm') continue; // covered by enum check

    const aspectDir = path.join(projectRoot, '.yggdrasil', 'aspects', aspect.id);
    const hasContentMd = fileExistsSync(path.join(aspectDir, 'content.md'));
    const hasCheckMjs = fileExistsSync(path.join(aspectDir, 'check.mjs'));

    if (hasContentMd && hasCheckMjs) {
      issues.push({
        severity: 'error',
        code: 'aspect-both-rule-sources',
        rule: 'aspect-rule-sources',
        ...issueMsg({
          what: `Aspect '${aspect.id}' has both content.md and check.mjs.`,
          why: `Exactly one rule source is allowed per aspect; the validator cannot infer intent.`,
          next: `Remove the file that does not match aspect's reviewer field (currently '${reviewer}').`,
        }),
      });
      // Also flag the wrong file type for the declared reviewer
      if (reviewer === 'llm') {
        issues.push({
          severity: 'error',
          code: 'aspect-unexpected-rule-source',
          rule: 'aspect-rule-sources',
          ...issueMsg({
            what: `Aspect '${aspect.id}' has reviewer 'llm' but check.mjs is present.`,
            why: `LLM aspects must not ship check.mjs (that's the AST reviewer's input).`,
            next: `Remove .yggdrasil/aspects/${aspect.id}/check.mjs or change reviewer to 'ast'.`,
          }),
        });
      } else {
        issues.push({
          severity: 'error',
          code: 'aspect-unexpected-rule-source',
          rule: 'aspect-rule-sources',
          ...issueMsg({
            what: `Aspect '${aspect.id}' has reviewer 'ast' but content.md is present.`,
            why: `AST aspects must not ship content.md (that's the LLM reviewer's input).`,
            next: `Remove .yggdrasil/aspects/${aspect.id}/content.md or change reviewer to 'llm'.`,
          }),
        });
      }
      continue;
    }

    if (reviewer === 'llm') {
      if (!hasContentMd) {
        issues.push({
          severity: 'error',
          code: 'aspect-missing-rule-source',
          rule: 'aspect-rule-sources',
          ...issueMsg({
            what: `Aspect '${aspect.id}' has reviewer 'llm' but content.md is missing.`,
            why: `LLM aspects need content.md as the rule definition the reviewer reads.`,
            next: `Create .yggdrasil/aspects/${aspect.id}/content.md describing the rule.`,
          }),
        });
      }
      if (hasCheckMjs) {
        issues.push({
          severity: 'error',
          code: 'aspect-unexpected-rule-source',
          rule: 'aspect-rule-sources',
          ...issueMsg({
            what: `Aspect '${aspect.id}' has reviewer 'llm' but check.mjs is present.`,
            why: `LLM aspects must not ship check.mjs (that's the AST reviewer's input).`,
            next: `Remove .yggdrasil/aspects/${aspect.id}/check.mjs or change reviewer to 'ast'.`,
          }),
        });
      }
    } else {
      // reviewer === 'ast'
      if (!hasCheckMjs) {
        issues.push({
          severity: 'error',
          code: 'aspect-missing-rule-source',
          rule: 'aspect-rule-sources',
          ...issueMsg({
            what: `Aspect '${aspect.id}' has reviewer 'ast' but check.mjs is missing.`,
            why: `AST aspects need check.mjs as the rule definition the runner executes.`,
            next: `Create .yggdrasil/aspects/${aspect.id}/check.mjs exporting a check function.`,
          }),
        });
      }
      if (hasContentMd) {
        issues.push({
          severity: 'error',
          code: 'aspect-unexpected-rule-source',
          rule: 'aspect-rule-sources',
          ...issueMsg({
            what: `Aspect '${aspect.id}' has reviewer 'ast' but content.md is present.`,
            why: `AST aspects must not ship content.md (that's the LLM reviewer's input).`,
            next: `Remove .yggdrasil/aspects/${aspect.id}/content.md or change reviewer to 'llm'.`,
          }),
        });
      }
    }
  }

  return issues;
}

// --- config-reviewer-missing: reviewer section must exist in yg-config.yaml ---

function checkReviewerPresence(graph: Graph): ValidationIssue[] {
  if (graph.configError) return [];
  if (graph.config.reviewer) return [];
  const msgData: IssueMessage = {
    what: 'yg-config.yaml has no reviewer: section.',
    why: 'Every project must declare at least one reviewer tier — even AST-only projects need the section for future LLM aspects.',
    next: 'Add `reviewer: { tiers: { default-tier: { provider: ..., consensus: 1, config: { model: ... } } } }` to .yggdrasil/yg-config.yaml.',
  };
  return [{ code: 'config-reviewer-missing', severity: 'error', rule: 'config-reviewer-missing', ...issueMsg(msgData), messageData: msgData }];
}

// --- aspect-tier-unknown: aspect.reviewer.tier must reference a configured tier ---

function checkAspectTierReferences(graph: Graph): ValidationIssue[] {
  if (graph.configError) return [];
  const issues: ValidationIssue[] = [];
  for (const aspect of graph.aspects) {
    if (aspect.reviewer.type !== 'llm') continue;
    const tier = aspect.reviewer.tier;
    if (!tier) continue;
    const tiers = graph.config.reviewer?.tiers ?? {};
    if (!tiers[tier]) {
      const tierNames = Object.keys(tiers);
      const msgData: IssueMessage = {
        what: `Aspect '${aspect.id}' references tier '${tier}' that does not exist in yg-config.yaml.`,
        why: 'Every tier reference must match a configured tier name under reviewer.tiers.',
        next: tierNames.length > 0
          ? `Use one of: ${tierNames.join(', ')}, or remove 'tier:' to use the default tier.`
          : `Add tier '${tier}' under reviewer.tiers in .yggdrasil/yg-config.yaml, or remove 'tier:' from the aspect.`,
      };
      issues.push({ code: 'aspect-tier-unknown', severity: 'error', rule: 'aspect-tier-unknown', ...issueMsg(msgData), messageData: msgData });
    }
  }
  return issues;
}

// --- aspect-reference-broken: reference file must exist as a regular file ---

async function checkAspectReferences(graph: Graph): Promise<ValidationIssue[]> {
  const projectRoot = path.dirname(graph.rootPath);
  const issues: ValidationIssue[] = [];
  for (const aspect of graph.aspects) {
    if (aspect.reviewer.type !== 'llm') continue;
    for (const ref of aspect.references ?? []) {
      const absPath = path.join(projectRoot, ref.path);
      try {
        const stats = await statPath(absPath);
        if (!stats.isFile()) {
          const msgData: IssueMessage = {
            what: `Aspect '${aspect.id}' references '${ref.path}' but the path resolves to a directory.`,
            why: `reference files must be regular files; directories cannot be loaded into the reviewer prompt.`,
            next: `point references entry to a specific file or remove the entry in .yggdrasil/aspects/${aspect.id}/yg-aspect.yaml.`,
          };
          issues.push({
            severity: 'error',
            code: 'aspect-reference-broken',
            rule: 'aspect-reference-broken',
            ...issueMsg(msgData),
            messageData: msgData,
          });
        }
      } catch {
        const msgData: IssueMessage = {
          what: `Aspect '${aspect.id}' references '${ref.path}' but the file does not exist.`,
          why: `reviewer cannot load missing reference files; approve would fail at runtime.`,
          next: `create the file, fix the path, or remove the reference entry in .yggdrasil/aspects/${aspect.id}/yg-aspect.yaml.`,
        };
        issues.push({
          severity: 'error',
          code: 'aspect-reference-broken',
          rule: 'aspect-reference-broken',
          ...issueMsg(msgData),
          messageData: msgData,
        });
      }
    }
  }
  return issues;
}

// --- secrets-non-credential-field: yg-secrets.yaml must only contain api_key ---

async function checkSecretsCredentialsOnly(graph: Graph): Promise<ValidationIssue[]> {
  const foreign = await inspectSecretsForValidation(graph.rootPath);
  const issues: ValidationIssue[] = [];
  for (const { provider, foreignKeys } of foreign) {
    for (const key of foreignKeys) {
      const msgData: IssueMessage = {
        what: `yg-secrets.yaml has '${key}' under reviewer.${provider}.`,
        why: 'The secrets file accepts only api_key; non-credential fields belong in yg-config.yaml tiers.',
        next: `Move '${key}' into reviewer.tiers.<name> in .yggdrasil/yg-config.yaml and remove it from yg-secrets.yaml.`,
      };
      issues.push({ code: 'secrets-non-credential-field', severity: 'error', rule: 'secrets-non-credential-field', ...issueMsg(msgData), messageData: msgData });
    }
  }
  return issues;
}

