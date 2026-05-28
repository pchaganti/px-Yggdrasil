import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import type { ArchitectureDef, ArchitectureNodeType, AspectStatus, RelationType } from '../model/graph.js';
import type { FileWhenPredicate } from '../model/file-when.js';
import { parseAspectAttachment } from '../core/parsing/when-parser.js';
import { parseFileWhen } from '../core/parsing/file-when-parser.js';
import type { WhenPredicate } from '../model/when.js';

const VALID_RELATION_TYPES: Set<string> = new Set(['uses', 'calls', 'extends', 'implements', 'emits', 'listens']);

export async function parseArchitecture(filePath: string): Promise<ArchitectureDef> {
  const content = await readFile(filePath, 'utf-8');
  const raw = parseYaml(content) as Record<string, unknown>;

  if (raw && (typeof raw !== 'object' || Array.isArray(raw))) {
    throw new Error(`yg-architecture.yaml: file must be a YAML mapping (or empty/omitted)`);
  }

  const nodeTypesRaw = raw?.node_types;
  if (
    nodeTypesRaw !== undefined &&
    nodeTypesRaw !== null &&
    (typeof nodeTypesRaw !== 'object' || Array.isArray(nodeTypesRaw))
  ) {
    throw new Error(`yg-architecture.yaml: 'node_types' must be a YAML mapping (or empty/omitted)`);
  }
  const nodeTypesObj = (nodeTypesRaw ?? {}) as Record<string, unknown>;

  const nodeTypes: Record<string, ArchitectureNodeType> = {};
  for (const [typeName, val] of Object.entries(nodeTypesObj)) {
    const entry = val as Record<string, unknown>;
    if (!entry || typeof entry !== 'object' || typeof entry.description !== 'string' || entry.description.trim() === '') {
      throw new Error(
        `yg-architecture.yaml: node_types.${typeName} must have a non-empty 'description' string`,
      );
    }

    if (entry.integration_aspects !== undefined) {
      throw new Error(
        `yg-architecture.yaml: node type '${typeName}' has unknown field 'integration_aspects'. Use ports on the target node instead.`,
      );
    }

    let aspects: string[] | undefined;
    let aspectWhens: Record<string, WhenPredicate> | undefined;
    let aspectStatus: Record<string, AspectStatus> | undefined;
    if (Array.isArray(entry.aspects)) {
      aspects = [];
      for (let i = 0; i < (entry.aspects as unknown[]).length; i++) {
        const parsed = parseAspectAttachment(
          (entry.aspects as unknown[])[i],
          `yg-architecture.yaml: node_types.${typeName}.aspects[${i}]`,
        );
        aspects.push(parsed.id);
        if (parsed.when) {
          (aspectWhens ??= {})[parsed.id] = parsed.when;
        }
        if (parsed.status) {
          (aspectStatus ??= {})[parsed.id] = parsed.status;
        }
      }
      if (aspects.length === 0) aspects = undefined;
    }

    const parents = Array.isArray(entry.parents)
      ? (entry.parents as unknown[]).filter((t): t is string => typeof t === 'string')
      : undefined;

    const relations: Partial<Record<RelationType, string[]>> | undefined = parseRelations(entry.relations, typeName);

    let logRequired: boolean | undefined;
    if (entry.log_required !== undefined) {
      if (typeof entry.log_required !== 'boolean') {
        throw new Error(
          `yg-architecture.yaml: node_types.${typeName}.log_required must be boolean, got ${typeof entry.log_required}`,
        );
      }
      logRequired = entry.log_required;
    }

    let when: FileWhenPredicate | undefined;
    if (entry.when !== undefined) {
      when = parseFileWhen(entry.when, `yg-architecture.yaml: node_types.${typeName}.when`);
    }

    let enforce: 'strict' | undefined;
    if (entry.enforce !== undefined) {
      if (entry.enforce !== 'strict') {
        throw new Error(
          `yg-architecture.yaml: node_types.${typeName}.enforce must be 'strict' (got: ${JSON.stringify(entry.enforce)})`,
        );
      }
      enforce = 'strict';
    }

    nodeTypes[typeName] = {
      description: entry.description as string,
      aspects,
      ...(aspectWhens && { aspectWhens }),
      ...(aspectStatus && { aspectStatus }),
      parents: parents && parents.length > 0 ? parents : undefined,
      relations: relations,
      ...(logRequired !== undefined && { log_required: logRequired }),
      ...(when !== undefined && { when }),
      ...(enforce !== undefined && { enforce }),
    };
  }

  return {
    node_types: nodeTypes,
  };
}

function parseRelations(
  relationsRaw: unknown,
  typeName: string,
): Partial<Record<RelationType, string[]>> | undefined {
  if (relationsRaw === undefined) {
    return undefined;
  }

  if (typeof relationsRaw !== 'object' || Array.isArray(relationsRaw)) {
    throw new Error(`yg-architecture.yaml: node_types.${typeName}.relations must be an object`);
  }

  const relations: Partial<Record<RelationType, string[]>> = {};

  for (const [relType, targets] of Object.entries(relationsRaw as Record<string, unknown>)) {
    if (!VALID_RELATION_TYPES.has(relType)) {
      throw new Error(
        `yg-architecture.yaml: node_types.${typeName}.relations: unknown relation type '${relType}' (valid types: ${Array.from(VALID_RELATION_TYPES).join(', ')})`,
      );
    }

    if (!Array.isArray(targets)) {
      throw new Error(
        `yg-architecture.yaml: node_types.${typeName}.relations.${relType} must be an array`,
      );
    }

    const targetStrings = (targets as unknown[]).filter((t): t is string => typeof t === 'string');
    if (targetStrings.length > 0) {
      relations[relType as RelationType] = targetStrings;
    }
  }

  return Object.keys(relations).length > 0 ? relations : {};
}
