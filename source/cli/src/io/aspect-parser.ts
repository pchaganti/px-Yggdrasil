import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import type { AspectDef } from '../model/graph.js';
import type { WhenPredicate } from '../model/when.js';
import { readArtifacts } from './artifact-reader.js';
import { parseWhen, parseAspectAttachment } from '../core/parsing/when-parser.js';

export async function parseAspect(
  aspectDir: string,
  aspectYamlPath: string,
  id: string,
): Promise<AspectDef> {
  const idTrimmed = id?.trim() ?? '';
  if (!idTrimmed) {
    throw new Error(`yg-aspect.yaml at ${aspectYamlPath}: aspect id must be non-empty (relative path in aspects/)`);
  }
  const content = await readFile(aspectYamlPath, 'utf-8');
  const raw = parseYaml(content) as Record<string, unknown>;

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`yg-aspect.yaml at ${aspectYamlPath}: file is empty or not a valid YAML mapping`);
  }

  if (!raw.name || typeof raw.name !== 'string' || raw.name.trim() === '') {
    throw new Error(`yg-aspect.yaml at ${aspectYamlPath}: missing or empty 'name'`);
  }

  const description = typeof raw.description === 'string' ? raw.description.trim() : undefined;

  let reviewer: 'ast' | 'llm' | undefined;
  if (raw.reviewer !== undefined) {
    if (raw.reviewer !== 'ast' && raw.reviewer !== 'llm') {
      throw new Error(`yg-aspect.yaml at ${aspectYamlPath}: 'reviewer' must be 'ast' or 'llm', got '${String(raw.reviewer)}'`);
    }
    reviewer = raw.reviewer;
  }

  const artifacts = await readArtifacts(aspectDir, ['yg-aspect.yaml']);

  let implies: string[] | undefined;
  let impliesWhens: Record<string, WhenPredicate> | undefined;
  if (raw.implies !== undefined) {
    if (!Array.isArray(raw.implies)) {
      throw new Error(`yg-aspect.yaml at ${aspectYamlPath}: 'implies' must be an array`);
    }
    implies = [];
    for (let i = 0; i < raw.implies.length; i++) {
      const parsed = parseAspectAttachment(
        raw.implies[i],
        `yg-aspect.yaml at ${aspectYamlPath}: implies[${i}]`,
      );
      implies.push(parsed.id);
      if (parsed.when) {
        (impliesWhens ??= {})[parsed.id] = parsed.when;
      }
    }
  }

  let when: WhenPredicate | undefined;
  if (raw.when !== undefined) {
    when = parseWhen(raw.when, `yg-aspect.yaml at ${aspectYamlPath}: when`);
  }

  return {
    name: (raw.name as string).trim(),
    id: idTrimmed,
    description,
    ...(reviewer && { reviewer }),
    implies,
    ...(impliesWhens && { impliesWhens }),
    ...(when && { when }),
    artifacts,
  };
}
