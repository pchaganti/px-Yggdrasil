import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import type { NodeMeta, PortDef, Relation, RelationType } from '../model/graph.js';
import { parseAspectAttachment } from './when-parser.js';
import type { WhenPredicate } from '../model/when.js';

const RELATION_TYPES: RelationType[] = [
  'uses',
  'calls',
  'extends',
  'implements',
  'emits',
  'listens',
];

function isValidRelationType(t: unknown): t is RelationType {
  return typeof t === 'string' && RELATION_TYPES.includes(t as RelationType);
}

export async function parseNodeYaml(filePath: string): Promise<NodeMeta> {
  const content = await readFile(filePath, 'utf-8');
  const raw = parseYaml(content) as Record<string, unknown>;

  if (!raw || typeof raw !== 'object') {
    throw new Error(`yg-node.yaml at ${filePath}: file is empty or not a valid YAML mapping`);
  }

  if (!raw.name || typeof raw.name !== 'string' || raw.name.trim() === '') {
    throw new Error(`yg-node.yaml at ${filePath}: missing or empty 'name'`);
  }
  if (!raw.type || typeof raw.type !== 'string' || raw.type.trim() === '') {
    throw new Error(`yg-node.yaml at ${filePath}: missing or empty 'type'`);
  }

  const description = typeof raw.description === 'string' ? raw.description.trim() : undefined;
  const relations = parseRelations(raw.relations, filePath);
  const mapping = parseMapping(raw.mapping, filePath);
  const aspectsResult = parseAspects(raw.aspects, filePath);
  const ports = parsePorts(raw.ports, filePath);

  return {
    name: (raw.name as string).trim(),
    type: (raw.type as string).trim(),
    description,
    aspects: aspectsResult.aspects,
    aspectWhens: aspectsResult.aspectWhens,
    relations: relations.length > 0 ? relations : undefined,
    mapping,
    ports,
  };
}

function parseAspects(
  raw: unknown,
  filePath: string,
): { aspects?: string[]; aspectWhens?: Record<string, WhenPredicate> } {
  if (raw === undefined || raw === null) return {};
  if (!Array.isArray(raw)) {
    throw new Error(`yg-node.yaml at ${filePath}: 'aspects' must be an array`);
  }
  if (raw.length === 0) return {};

  const aspects: string[] = [];
  let aspectWhens: Record<string, WhenPredicate> | undefined;
  const seen = new Set<string>();

  for (let i = 0; i < raw.length; i++) {
    const parsed = parseAspectAttachment(
      raw[i],
      `yg-node.yaml at ${filePath}: aspects[${i}]`,
    );
    if (seen.has(parsed.id)) {
      throw new Error(`yg-node.yaml at ${filePath}: duplicate aspect '${parsed.id}' in aspects list`);
    }
    seen.add(parsed.id);
    aspects.push(parsed.id);
    if (parsed.when) {
      (aspectWhens ??= {})[parsed.id] = parsed.when;
    }
  }

  return { aspects: aspects.length > 0 ? aspects : undefined, aspectWhens };
}

function parseRelations(raw: unknown, filePath: string): Relation[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new Error(`yg-node.yaml at ${filePath}: 'relations' must be an array`);
  }

  const result: Relation[] = [];
  for (let index = 0; index < raw.length; index++) {
    const r = raw[index];
    if (typeof r !== 'object' || r === null) {
      throw new Error(`yg-node.yaml at ${filePath}: relations[${index}] must be an object`);
    }
    const obj = r as Record<string, unknown>;
    const target = obj.target;
    const type = obj.type;

    if (typeof target !== 'string' || target.trim() === '') {
      throw new Error(
        `yg-node.yaml at ${filePath}: relations[${index}].target must be a non-empty string`,
      );
    }
    if (!isValidRelationType(type)) {
      throw new Error(`yg-node.yaml at ${filePath}: relations[${index}].type is invalid`);
    }

    const rel: Relation = {
      target: target.trim(),
      type: type as RelationType,
    };
    if (Array.isArray(obj.consumes)) {
      rel.consumes = (obj.consumes as unknown[]).filter((c): c is string => typeof c === 'string');
    }
    if (typeof obj.event_name === 'string' && obj.event_name.trim()) {
      rel.event_name = obj.event_name.trim();
    }

    result.push(rel);
  }
  return result;
}

function validateRelativePath(pathValue: string, filePath: string, fieldName: string): string {
  const normalized = pathValue.trim();
  if (normalized === '') {
    throw new Error(`yg-node.yaml at ${filePath}: '${fieldName}' must be non-empty`);
  }
  if (normalized.startsWith('/')) {
    throw new Error(`yg-node.yaml at ${filePath}: '${fieldName}' must be relative to repository root`);
  }
  return normalized;
}

function parseMapping(rawMapping: unknown, filePath: string): string[] | undefined {
  if (!rawMapping) return undefined;

  if (!Array.isArray(rawMapping)) {
    throw new Error(
      `yg-node.yaml at ${filePath}: mapping must be an array of file/directory paths.`,
    );
  }

  if (rawMapping.length === 0) {
    throw new Error(`yg-node.yaml at ${filePath}: mapping array must not be empty`);
  }

  const paths: string[] = [];
  for (let i = 0; i < rawMapping.length; i++) {
    const entry = rawMapping[i];
    if (typeof entry === 'object' && entry !== null) {
      throw new Error(
        `yg-node.yaml at ${filePath}: mapping[${i}] is an object. ` +
        `Mapping must be a flat list of file/directory paths.`,
      );
    }
    if (typeof entry !== 'string' || entry.trim() === '') {
      throw new Error(
        `yg-node.yaml at ${filePath}: mapping[${i}] must be a non-empty string (file or directory path)`,
      );
    }
    paths.push(validateRelativePath(entry, filePath, `mapping[${i}]`));
  }

  return paths;
}

function parsePorts(rawPorts: unknown, filePath: string): Record<string, PortDef> | undefined {
  if (!rawPorts || rawPorts === null) return undefined;

  if (typeof rawPorts !== 'object' || Array.isArray(rawPorts)) {
    throw new Error(`yg-node.yaml at ${filePath}: ports must be a mapping of port names to definitions`);
  }

  const ports: Record<string, PortDef> = {};
  for (const [name, raw] of Object.entries(rawPorts as Record<string, unknown>)) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new Error(`yg-node.yaml at ${filePath}: ports.${name} must be an object`);
    }
    const obj = raw as Record<string, unknown>;

    if (typeof obj.description !== 'string' || obj.description.trim() === '') {
      throw new Error(`yg-node.yaml at ${filePath}: ports.${name}.description must be a non-empty string`);
    }

    if (!Array.isArray(obj.aspects)) {
      throw new Error(`yg-node.yaml at ${filePath}: ports.${name}.aspects must be an array`);
    }

    const portAspects: string[] = [];
    let portAspectWhens: Record<string, WhenPredicate> | undefined;
    const seenPortAspects = new Set<string>();
    for (let i = 0; i < (obj.aspects as unknown[]).length; i++) {
      const parsed = parseAspectAttachment(
        (obj.aspects as unknown[])[i],
        `yg-node.yaml at ${filePath}: ports.${name}.aspects[${i}]`,
      );
      if (seenPortAspects.has(parsed.id)) {
        throw new Error(`yg-node.yaml at ${filePath}: ports.${name}.aspects has duplicate '${parsed.id}'`);
      }
      seenPortAspects.add(parsed.id);
      portAspects.push(parsed.id);
      if (parsed.when) {
        (portAspectWhens ??= {})[parsed.id] = parsed.when;
      }
    }
    ports[name] = {
      description: obj.description.trim(),
      aspects: portAspects,
      ...(portAspectWhens && { aspectWhens: portAspectWhens }),
    };
  }

  return Object.keys(ports).length > 0 ? ports : undefined;
}
