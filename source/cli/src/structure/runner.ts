import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ensureLoaderRegistered } from '../ast/loader-hook.js';
import { createCtxFs, UndeclaredFsReadError } from './ctx-fs.js';
import { createCtxGraph, UndeclaredGraphReadError } from './ctx-graph.js';
import { createCtxParsers, prewarmupAstCache, ParseAstNotPrewarmedError } from './ctx-parsers.js';
import { collectAllowedReadsForAspect } from './allowed-reads.js';
import { normalizeMappingPath } from './expand-mapping-sync.js';
import type { Graph, GraphNode as ModelNode } from '../model/graph.js';
import type { Ctx, Violation, File, Port } from './types.js';
import type { ParseCache } from '../ast/parse-cache.js';

export interface RunStructureAspectParams {
  aspectDir: string;
  aspectId: string;
  nodePath: string;
  graph: Graph;
  projectRoot: string;
  parseCache?: ParseCache;
}

export interface RunStructureAspectResult {
  violations: Violation[];
  touchedFiles: string[];
  succeeded?: boolean;
}

export class StructureRunnerError extends Error {
  constructor(public readonly code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = 'StructureRunnerError';
  }
}

function buildOwnFiles(node: ModelNode, projectRoot: string, touchedFiles: string[]): File[] {
  const childMappings = new Set<string>();
  for (const child of node.children) {
    for (const raw of child.meta.mapping ?? []) {
      const p = normalizeMappingPath(raw);
      if (p) childMappings.add(p);
    }
  }
  const result: File[] = [];
  for (const raw of node.meta.mapping ?? []) {
    const p = normalizeMappingPath(raw);
    if (!p || childMappings.has(p)) continue;
    const abs = path.resolve(projectRoot, p);
    try {
      const stat = fs.statSync(abs);
      if (stat.isFile()) {
        const content = fs.readFileSync(abs, 'utf8');
        result.push({ path: p, content });
        touchedFiles.push(p);
      }
    } catch {/* skip */}
  }
  return result;
}

/**
 * Sync mapping path enumeration for prewarmup. Reads from the filesystem.
 * Mapping entries may be files or directories; for a directory entry, we
 * walk it recursively to collect all files.
 */
function enumerateMappedFilesSync(mappingPaths: string[], projectRoot: string): string[] {
  const out: string[] = [];
  for (const raw of mappingPaths) {
    const rel = normalizeMappingPath(raw);
    if (!rel) continue;
    const abs = path.resolve(projectRoot, rel);
    try {
      const stat = fs.statSync(abs);
      if (stat.isFile()) {
        out.push(rel);
      } else if (stat.isDirectory()) {
        for (const sub of walkDirSync(abs)) {
          // Convert absolute back to repo-relative POSIX
          const relSub = path.relative(projectRoot, sub).split(/[\\/]/).join('/');
          out.push(relSub);
        }
      }
    } catch {/* skip missing */}
  }
  return out;
}

function* walkDirSync(dir: string): Generator<string> {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const child = path.join(dir, e.name);
    if (e.isDirectory()) yield* walkDirSync(child);
    else if (e.isFile()) yield child;
  }
}

export async function runStructureAspect(
  params: RunStructureAspectParams,
): Promise<RunStructureAspectResult> {
  ensureLoaderRegistered();
  const { aspectDir, aspectId, nodePath, graph, projectRoot } = params;
  const astCache: ParseCache = params.parseCache ?? new Map();
  const touchedFiles: string[] = [];

  const node = graph.nodes.get(nodePath);
  if (!node) {
    throw new StructureRunnerError(
      'STRUCTURE_NODE_MISSING',
      `Node '${nodePath}' not in graph.`,
    );
  }

  const aspectDirAbs = path.isAbsolute(aspectDir) ? aspectDir : path.resolve(projectRoot, aspectDir);
  const checkPath = path.join(aspectDirAbs, 'check.mjs');

  let mod: Record<string, unknown>;
  try {
    mod = await import(pathToFileURL(checkPath).href) as Record<string, unknown>;
  } catch (err) {
    throw new StructureRunnerError(
      'STRUCTURE_LOADER_RESOLVE_FAILED',
      `Failed to load check.mjs at ${checkPath}: ${(err as Error).message}`,
    );
  }

  if (mod.default !== undefined && typeof mod.default === 'function' && (mod.default as { name?: string }).name === 'check') {
    throw new StructureRunnerError(
      'STRUCTURE_CHECK_DEFAULT_EXPORT',
      `check.mjs uses default export. Use 'export function check(ctx)' (named export).`,
    );
  }
  if (!('check' in mod)) {
    throw new StructureRunnerError(
      'STRUCTURE_CHECK_NOT_EXPORTED',
      `check.mjs must export a named function 'check'.`,
    );
  }
  if (typeof mod.check !== 'function') {
    throw new StructureRunnerError(
      'STRUCTURE_CHECK_NOT_FUNCTION',
      `'check' export must be a function, got ${typeof mod.check}.`,
    );
  }
  const checkFn = mod.check as (...args: unknown[]) => unknown;
  if (checkFn.length !== 1) {
    throw new StructureRunnerError(
      'STRUCTURE_CHECK_WRONG_ARITY',
      `'check' must take exactly one argument (ctx); got ${checkFn.length}.`,
    );
  }

  const allowedSet = collectAllowedReadsForAspect(nodePath, graph);
  const ctxFs = createCtxFs({ allowedSet, projectRoot, touchedFiles });
  const ctxGraph = createCtxGraph({ currentNodePath: nodePath, graph, projectRoot, touchedFiles });
  const parsers = createCtxParsers({ allowedSet, projectRoot, touchedFiles, astCache });

  const ownFiles = buildOwnFiles(node, projectRoot, touchedFiles);
  const ctx: Ctx = {
    node: {
      id: node.path,
      type: node.meta.type,
      mapping: node.meta.mapping ?? [],
      files: ownFiles,
      ports: (node.meta.ports ?? {}) as Record<string, Port>,
    },
    files: ownFiles,
    fs: ctxFs,
    graph: ctxGraph,
    parseAst: parsers.parseAst,
    parseYaml: parsers.parseYaml,
    parseJson: parsers.parseJson,
    parseToml: parsers.parseToml,
  };

  // PREWARMUP — Decision A. Compute AST input set, prewarm cache.
  const astInputSet: File[] = [...ownFiles];
  for (const rel of (node.meta.relations ?? [])) {
    const target = graph.nodes.get(rel.target);
    if (!target) continue;
    for (const p of enumerateMappedFilesSync(target.meta.mapping ?? [], projectRoot)) {
      const abs = path.resolve(projectRoot, p);
      try {
        const content = fs.readFileSync(abs, 'utf8');
        astInputSet.push({ path: p, content });
      } catch {/* skip */}
    }
  }
  await prewarmupAstCache({ astCache, projectRoot, files: astInputSet });

  let raw: unknown;
  try {
    raw = checkFn(ctx);
  } catch (err) {
    if (err instanceof UndeclaredFsReadError) {
      return {
        violations: [{
          message: `Aspect tried to read undeclared path '${err.path}'. Add a relation in yg-node.yaml to the node owning this path.`,
          kind: 'structure-aspect-undeclared-fs-read',
          file: `.yggdrasil/aspects/${aspectId}/check.mjs`,
        }],
        touchedFiles: [],
        succeeded: false,
      };
    }
    if (err instanceof UndeclaredGraphReadError) {
      return {
        violations: [{
          message: `Aspect tried to read undeclared graph node '${err.nodePath}'. Add a relation in yg-node.yaml.`,
          kind: 'structure-aspect-undeclared-graph-read',
          file: `.yggdrasil/aspects/${aspectId}/check.mjs`,
        }],
        touchedFiles: [],
        succeeded: false,
      };
    }
    if (err instanceof ParseAstNotPrewarmedError) {
      return {
        violations: [{
          message: `Aspect called ctx.parseAst on '${err.filePath}', which was not pre-warmed by the dispatcher. Add a declared relation to the node owning this file, or use ctx.parseYaml/Json/Toml if AST is not required.`,
          kind: 'structure-aspect-parseast-not-prewarmed',
          file: `.yggdrasil/model/${nodePath}/yg-node.yaml`,
        }],
        touchedFiles: [],
        succeeded: false,
      };
    }
    throw new StructureRunnerError(
      'STRUCTURE_CHECK_THROWN',
      `check.mjs threw: ${(err as Error).message}\n${(err as Error).stack ?? ''}`,
    );
  }

  if (raw !== null && typeof raw === 'object' && typeof (raw as Record<string, unknown>).then === 'function') {
    throw new StructureRunnerError(
      'STRUCTURE_CHECK_ASYNC',
      `check.mjs returned a Promise; only synchronous returns are supported.`,
    );
  }
  if (!Array.isArray(raw)) {
    throw new StructureRunnerError(
      'STRUCTURE_CHECK_RETURN_SHAPE',
      `check.mjs returned ${typeof raw}, expected Violation[].`,
    );
  }

  const contextFiles = new Set<string>(ownFiles.map(f => f.path));
  for (const t of touchedFiles) contextFiles.add(t);

  const violations: Violation[] = [];
  for (const v of raw) {
    if (typeof v !== 'object' || v === null || typeof (v as Violation).message !== 'string') {
      throw new StructureRunnerError(
        'STRUCTURE_CHECK_RETURN_SHAPE',
        `Violation entry must be an object with a string 'message' field.`,
      );
    }
    const vv = v as Violation;
    if (typeof vv.file === 'string' && !contextFiles.has(normalizeMappingPath(vv.file))) {
      throw new StructureRunnerError(
        'STRUCTURE_CHECK_FILE_NOT_IN_CONTEXT',
        `Violation references file '${vv.file}' not in ctx (own mapping or touched via ctx.fs/ctx.graph).`,
      );
    }
    violations.push(vv);
  }

  return { violations, touchedFiles, succeeded: true };
}
