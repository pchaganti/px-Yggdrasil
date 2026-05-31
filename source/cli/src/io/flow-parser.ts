import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { AspectStatus, FlowDef } from '../model/graph.js';
import { parseAspectAttachment } from '../utils/when-parser.js';
import type { WhenPredicate } from '../model/when.js';

export async function parseFlow(flowDir: string, flowYamlPath: string): Promise<FlowDef> {
  const content = await readFile(flowYamlPath, 'utf-8');
  const raw = parseYaml(content) as Record<string, unknown>;

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`yg-flow.yaml at ${flowYamlPath}: file is empty or not a valid YAML mapping`);
  }

  if (!raw.name || typeof raw.name !== 'string' || raw.name.trim() === '') {
    throw new Error(`yg-flow.yaml at ${flowYamlPath}: missing or empty 'name'`);
  }

  const description = typeof raw.description === 'string' ? raw.description.trim() : undefined;

  const nodes = raw.nodes ?? raw.participants;
  if (!Array.isArray(nodes) || nodes.length === 0) {
    throw new Error(
      `yg-flow.yaml at ${flowYamlPath}: 'nodes' (or 'participants') must be a non-empty array`,
    );
  }

  const nonStringNodes = (nodes as unknown[])
    .map((n, i) => ({ value: n, index: i }))
    .filter((e) => typeof e.value !== 'string');
  if (nonStringNodes.length > 0) {
    const offenders = nonStringNodes
      .map((e) => `index ${e.index}: ${JSON.stringify(e.value)} (${typeof e.value})`)
      .join('; ');
    throw new Error(
      `yg-flow.yaml at ${flowYamlPath}: 'nodes' (or 'participants') contains non-string ${nonStringNodes.length === 1 ? 'entry' : 'entries'} [${offenders}]. ` +
        `Every entry must be a string node path; non-string entries would be silently dropped from the flow and escape aspect enforcement. ` +
        `Fix or remove the offending ${nonStringNodes.length === 1 ? 'entry' : 'entries'}.`,
    );
  }
  const nodePaths = nodes as string[];

  let aspects: string[] | undefined;
  let aspectWhens: Record<string, WhenPredicate> | undefined;
  const aspectStatus: Record<string, AspectStatus> = {};
  if (raw.aspects !== undefined) {
    if (!Array.isArray(raw.aspects)) {
      throw new Error(`yg-flow.yaml at ${flowYamlPath}: 'aspects' must be an array of strings`);
    }
    aspects = [];
    for (let i = 0; i < raw.aspects.length; i++) {
      const parsed = parseAspectAttachment(
        (raw.aspects as unknown[])[i],
        `yg-flow.yaml at ${flowYamlPath}: aspects[${i}]`,
      );
      aspects.push(parsed.id);
      if (parsed.when) {
        (aspectWhens ??= {})[parsed.id] = parsed.when;
      }
      if (parsed.status) {
        aspectStatus[parsed.id] = parsed.status;
      }
    }
  }

  return {
    path: path.basename(flowDir),
    name: (raw.name as string).trim(),
    description,
    nodes: nodePaths,
    ...(aspects !== undefined && { aspects }),
    ...(aspectWhens && { aspectWhens }),
    ...(Object.keys(aspectStatus).length > 0 && { aspectStatus }),
  };
}
