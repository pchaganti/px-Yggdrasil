import type { Graph } from '../../model/graph.js';
import type { ValidationIssue, IssueMessage } from '../../model/validation.js';
import { LANGUAGES } from '../graph/language-registry.js';
import { inspectSecretsForValidation } from '../../io/secrets-parser.js';
import { issueMsg } from './shared.js';

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

export function checkRelationTargets(graph: Graph): ValidationIssue[] {
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

// --- Rule 4: No circular dependencies ---

export function checkNoCycles(graph: Graph): ValidationIssue[] {
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

// --- flow-node-broken: Broken flow refs (flow.nodes) ---

export function checkBrokenFlowRefs(graph: Graph): ValidationIssue[] {
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

// --- high-fan-out: Exceeds max_direct_relations ---

export function checkHighFanOut(graph: Graph): ValidationIssue[] {
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

export function checkUnpairedEvents(graph: Graph): ValidationIssue[] {
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

export function checkSchemas(graph: Graph): ValidationIssue[] {
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

// --- missing-description: Missing description on nodes, aspects, and flows ---

export function checkMissingDescriptions(graph: Graph): ValidationIssue[] {
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

// --- secrets-non-credential-field: yg-secrets.yaml must only contain api_key ---

export async function checkSecretsCredentialsOnly(graph: Graph): Promise<ValidationIssue[]> {
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
