import path from 'node:path';
import { readSortedDir, readSortedDirOrEmpty, readTextFile } from '../io/graph-fs.js';
import { gt, valid } from 'semver';
import type {
  Graph,
  GraphNode,
  AspectDef,
  FlowDef,
  SchemaDef,
  YggConfig,
  ArchitectureDef,
} from '../model/graph.js';
import { parseConfig, ConfigParseError } from '../io/config-parser.js';
import { parseNodeYaml } from '../io/node-parser.js';
import { parseAspect } from '../io/aspect-parser.js';
import { parseFlow } from '../io/flow-parser.js';
import { parseSchema } from '../io/schema-parser.js';
import { parseArchitecture } from '../io/architecture-parser.js';
import { WhenPredicateInvalidError } from './parsing/file-when-parser.js';
import type { ArchitectureLoadError } from '../model/graph.js';
import type { IssueMessage } from '../model/validation.js';
import { findYggRoot } from '../io/paths.js';
import { detectVersion } from './migrator.js';

const CLI_SUPPORTED_SCHEMA = '4.3.0';

function toModelPath(absolutePath: string, modelDir: string): string {
  return path.relative(modelDir, absolutePath).replace(/\\/g, '/').replace(/\/+$/, '');
}

const FALLBACK_CONFIG: YggConfig = {};

export async function loadGraph(
  projectRoot: string,
  options: { tolerateInvalidConfig?: boolean } = {},
): Promise<Graph> {
  const yggRoot = await findYggRoot(projectRoot);

  const detected = await detectVersion(yggRoot);
  if (detected !== null && valid(detected) && gt(detected, CLI_SUPPORTED_SCHEMA)) {
    throw new Error(
      `yg-config.yaml version "${detected}" is newer than this CLI supports ` +
        `(max: ${CLI_SUPPORTED_SCHEMA}).\nUpgrade CLI: \`npm i -g @chrisdudek/yg\`.`,
    );
  }

  let configError: string | undefined;
  let configErrorCode: string | undefined;
  let configErrorMessage: IssueMessage | undefined;
  let config = FALLBACK_CONFIG;
  try {
    config = await parseConfig(path.join(yggRoot, 'yg-config.yaml'));
  } catch (error) {
    if (error instanceof ConfigParseError) {
      // Structured config error — always capture (never rethrow), propagate structured message
      configErrorMessage = error.messageData;
      configErrorCode = error.code;
      configError = error.messageData.what;
    } else if (!options.tolerateInvalidConfig) {
      throw error;
    } else {
      configError = (error as Error).message;
    }
  }

  const { architecture, error: architectureError } = await loadArchitecture(yggRoot);

  const modelDir = path.join(yggRoot, 'model');
  const nodes = new Map<string, GraphNode>();
  const nodeParseErrors: Array<{ nodePath: string; messageData: IssueMessage }> = [];
  try {
    await scanModelDirectory(modelDir, modelDir, null, nodes, nodeParseErrors);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Directory .yggdrasil/model/ does not exist. Run 'yg init' first.`, {
        cause: err,
      });
    }
    throw err;
  }

  const aspectsLoad = await loadAspects(path.join(yggRoot, 'aspects'));
  const flows = await loadFlows(path.join(yggRoot, 'flows'));
  const schemas = await loadSchemas(path.join(yggRoot, 'schemas'));

  return {
    config,
    architecture,
    architectureError,
    configError,
    configErrorCode,
    configErrorMessage,
    nodeParseErrors: nodeParseErrors.length > 0 ? nodeParseErrors : undefined,
    aspectParseErrors: aspectsLoad.parseErrors.length > 0 ? aspectsLoad.parseErrors : undefined,
    nodes,
    aspects: aspectsLoad.aspects,
    flows,
    schemas,
    rootPath: yggRoot.replace(/\\/g, '/').replace(/\/+$/, ''),
  };
}

async function loadArchitecture(
  yggRoot: string,
): Promise<{ architecture: ArchitectureDef; error?: ArchitectureLoadError }> {
  const architectureFilePath = path.join(yggRoot, 'yg-architecture.yaml');
  const emptyArch: ArchitectureDef = { node_types: {} };

  try {
    const architecture = await parseArchitecture(architectureFilePath);
    return { architecture };
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      return { architecture: emptyArch };
    }
    if (error instanceof WhenPredicateInvalidError) {
      const whenMsg: IssueMessage = {
        what: error.message,
        why: 'The when: predicate in yg-architecture.yaml could not be parsed. Architecture cannot be loaded until this is fixed.',
        next: 'Fix the when: predicate syntax in yg-architecture.yaml. See schemas/yg-architecture.yaml for the allowed shape.',
      };
      return {
        architecture: emptyArch,
        error: { code: 'when-predicate-invalid', messageData: whenMsg },
      };
    }
    const msg = (error as Error).message;
    const archInvalidMsg: IssueMessage = {
      what: msg,
      why: `yg-architecture.yaml failed to parse. No architecture-level rules can be checked until this is fixed.`,
      next: `Fix the YAML syntax in yg-architecture.yaml. Run yg check again to verify.`,
    };
    return { architecture: emptyArch, error: { code: 'architecture-invalid', messageData: archInvalidMsg } };
  }
}

async function scanModelDirectory(
  dirPath: string,
  modelDir: string,
  parent: GraphNode | null,
  nodes: Map<string, GraphNode>,
  nodeParseErrors: Array<{ nodePath: string; messageData: IssueMessage }>,
): Promise<void> {
  const entries = await readSortedDir(dirPath);
  const hasNodeYaml = entries.some((e) => e.isFile() && e.name === 'yg-node.yaml');

  if (!hasNodeYaml && dirPath !== modelDir) {
    return;
  }

  if (hasNodeYaml) {
    const graphPath = toModelPath(dirPath, modelDir);
    const nodeYamlPath = path.join(dirPath, 'yg-node.yaml');
    let meta;
    let nodeYamlRaw: string | undefined;
    try {
      nodeYamlRaw = await readTextFile(nodeYamlPath);
      meta = await parseNodeYaml(nodeYamlPath);
    } catch (err) {
      nodeParseErrors.push({
        nodePath: graphPath,
        messageData: {
          what: `yg-node.yaml parse error in ${graphPath}.`,
          why: (err as Error).message,
          next: `Fix the YAML in .yggdrasil/model/${graphPath}/yg-node.yaml.`,
        },
      });
      return;
    }

    const node: GraphNode = {
      path: graphPath,
      meta,
      nodeYamlRaw,
      children: [],
      parent,
    };

    nodes.set(graphPath, node);
    if (parent) {
      parent.children.push(node);
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.')) continue;

      await scanModelDirectory(
        path.join(dirPath, entry.name),
        modelDir,
        node,
        nodes,
        nodeParseErrors,
      );
    }
  } else {
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.')) continue;

      await scanModelDirectory(
        path.join(dirPath, entry.name),
        modelDir,
        null,
        nodes,
        nodeParseErrors,
      );
    }
  }
}

async function loadAspects(
  aspectsDir: string,
): Promise<{ aspects: AspectDef[]; parseErrors: Array<{ aspectId: string; code: string; messageData: IssueMessage }> }> {
  const aspects: AspectDef[] = [];
  const parseErrors: Array<{ aspectId: string; code: string; messageData: IssueMessage }> = [];
  try {
    await scanAspectsDirectory(aspectsDir, aspectsDir, aspects, parseErrors);
  } catch {
    // directory doesn't exist — return empty
  }
  return { aspects, parseErrors };
}

async function scanAspectsDirectory(
  dirPath: string,
  aspectsRoot: string,
  aspects: AspectDef[],
  parseErrors: Array<{ aspectId: string; code: string; messageData: IssueMessage }>,
): Promise<void> {
  const entries = await readSortedDir(dirPath);
  const hasAspectYaml = entries.some((e) => e.isFile() && e.name === 'yg-aspect.yaml');

  if (hasAspectYaml) {
    const id = path.relative(aspectsRoot, dirPath).replace(/\\/g, '/').replace(/\/+$/, '');
    const aspectYamlPath = path.join(dirPath, 'yg-aspect.yaml');
    const result = await parseAspect(dirPath, aspectYamlPath, id);
    if (result.ok) {
      aspects.push(result.aspect);
    } else {
      for (const err of result.errors) {
        parseErrors.push({ aspectId: result.aspectId, code: err.code, messageData: err.messageData });
      }
    }
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.')) continue;
    await scanAspectsDirectory(path.join(dirPath, entry.name), aspectsRoot, aspects, parseErrors);
  }
}

async function loadFlows(flowsDir: string): Promise<FlowDef[]> {
  const entries = await readSortedDirOrEmpty(flowsDir);
  if (entries.length === 0) return [];
  const flows: FlowDef[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const flowYamlPath = path.join(flowsDir, entry.name, 'yg-flow.yaml');
    const flow = await parseFlow(path.join(flowsDir, entry.name), flowYamlPath);
    flows.push(flow);
  }
  return flows;
}

async function loadSchemas(schemasDir: string): Promise<SchemaDef[]> {
  const entries = await readSortedDirOrEmpty(schemasDir);
  const schemas: SchemaDef[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith('.yaml') && !entry.name.endsWith('.yml')) continue;
    const s = await parseSchema(path.join(schemasDir, entry.name));
    schemas.push(s);
  }
  return schemas;
}
