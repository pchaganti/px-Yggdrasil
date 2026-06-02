import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ensureLoaderRegistered } from '../ast/loader-hook.js';
import { createCtxFs, UndeclaredFsReadError } from './ctx-fs.js';
import { createCtxGraph, UndeclaredGraphReadError } from './ctx-graph.js';
import { createCtxParsers, prewarmupAstCache, enrichFilesWithAst, ParseAstNotPrewarmedError, ParseAstSyntaxError } from './ctx-parsers.js';
import { collectAllowedReadsForAspect } from './allowed-reads.js';
import { normalizeMappingPath, isPathInMapping } from './expand-mapping-sync.js';
import { expandMappingPaths } from '../io/hash.js';
import { collectSuppressions, isLineSuppressed } from '../ast/suppress.js';
import type { SuppressedRange } from '../ast/suppress.js';
import { validateCheckModuleExport } from '../utils/validate-check-module.js';
import type { Graph, GraphNode as ModelNode } from '../model/graph.js';
import type { Ctx, Violation, File, Port } from './types.js';
import type { ParseCache } from '../ast/parse-cache.js';
import type { IssueMessage } from '../model/validation.js';
import type { Node as SyntaxNode } from 'web-tree-sitter';

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
  public readonly messageData: IssueMessage;
  constructor(public readonly code: string, data: IssueMessage) {
    // Keep the code token in .message so author-facing assertions and logs
    // that key off the code continue to find it; carry the full what/why/next
    // in messageData for the structured renderer (parity with AstRunnerError).
    super(`${code}: ${data.what}\n${data.why}\n${data.next}`);
    this.messageData = data;
    this.name = 'StructureRunnerError';
  }
}

/** Binary extensions whose content is never meaningful to a deterministic check. */
const BINARY_EXTENSIONS = new Set([
  '.gif', '.png', '.jpg', '.jpeg', '.webp', '.bmp', '.ico', '.svgz',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.zip', '.gz', '.tgz', '.tar', '.bz2', '.7z',
  '.pdf', '.mp4', '.mov', '.webm', '.mp3', '.wav', '.wasm', '.bin',
]);

/**
 * Expand the node's own mapping to a flat list of readable text files.
 * Directory entries are expanded recursively via the gitignore-aware
 * expandMappingPaths helper (same function used by the node-size budget and
 * build-context), so ctx.files exactly matches what the LLM path sees.
 * Files owned by descendant (child) nodes are carved out so a child's
 * aspects apply to those files, not the parent's.
 * Binary files (by extension) and unreadable files are silently skipped.
 */
async function buildOwnFiles(node: ModelNode, projectRoot: string, touchedFiles: string[]): Promise<File[]> {
  // Collect all mapping entries from child nodes — we exclude any file that falls
  // under a child's mapping (file-or-directory) to preserve the child-wins model.
  const childMappingEntries: string[] = [];
  for (const child of node.children) {
    for (const raw of child.meta.mapping ?? []) {
      const p = normalizeMappingPath(raw);
      if (p) childMappingEntries.push(p);
    }
  }

  const rawMapping = (node.meta.mapping ?? [])
    .map(normalizeMappingPath)
    .filter((p): p is string => p !== '');

  // Expand directories to constituent files (gitignore-aware).
  const expanded = await expandMappingPaths(projectRoot, rawMapping);

  const result: File[] = [];
  for (const p of expanded) {
    // Carve out files owned by descendant nodes.
    if (childMappingEntries.length > 0 && isPathInMapping(p, childMappingEntries)) continue;
    // Skip binary files by extension.
    if (BINARY_EXTENSIONS.has(path.extname(p).toLowerCase())) continue;
    const abs = path.resolve(projectRoot, p);
    let content: string;
    try {
      content = fs.readFileSync(abs, 'utf8');
    } catch {
      continue; // unreadable — skip
    }
    result.push({ path: p, content });
    touchedFiles.push(p);
  }
  return result;
}

/**
 * Async mapping path enumeration for prewarmup. Mapping entries may be files
 * or directories; directories are expanded via expandMappingPaths (gitignore-aware).
 */
async function enumerateMappedFilesAsync(mappingPaths: string[], projectRoot: string): Promise<string[]> {
  const normalized = mappingPaths
    .map(normalizeMappingPath)
    .filter((p): p is string => p !== '');
  return expandMappingPaths(projectRoot, normalized);
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
    throw new StructureRunnerError('STRUCTURE_NODE_MISSING', {
      what: `Node '${nodePath}' not in graph.`,
      why: `The runner resolves the node by path to load its mapped files and aspects.`,
      next: `Pass an existing node path, or add the node to the graph.`,
    });
  }

  const aspectDirAbs = path.isAbsolute(aspectDir) ? aspectDir : path.resolve(projectRoot, aspectDir);
  const checkPath = path.join(aspectDirAbs, 'check.mjs');

  let mod: Record<string, unknown>;
  try {
    mod = await import(pathToFileURL(checkPath).href) as Record<string, unknown>;
  } catch (err) {
    throw new StructureRunnerError('STRUCTURE_LOADER_RESOLVE_FAILED', {
      what: `Failed to load check.mjs at ${checkPath}: ${(err as Error).message}`,
      why: `The runner dynamically imports the aspect's check.mjs before invoking it.`,
      next: `Ensure check.mjs exists at the aspect directory and has no unresolved imports.`,
    });
  }

  const exportCheck = validateCheckModuleExport(mod, {
    codePrefix: 'STRUCTURE',
    runnerLabel: `aspect '${aspectId}'`,
  });
  if (!exportCheck.ok) {
    throw new StructureRunnerError(exportCheck.code, exportCheck.message);
  }
  const checkFn = mod.check as (...args: unknown[]) => unknown;

  const allowedSet = collectAllowedReadsForAspect(nodePath, graph);
  const ctxFs = createCtxFs({ allowedSet, projectRoot, touchedFiles });
  const ctxGraph = createCtxGraph({ currentNodePath: nodePath, graph, projectRoot, touchedFiles });
  const parsers = createCtxParsers({ allowedSet, projectRoot, touchedFiles, astCache });

  const ownFiles = await buildOwnFiles(node, projectRoot, touchedFiles);
  // Eagerly parse own-mapping files so ctx.files carry .ast + .language (AST-aspect parity).
  await prewarmupAstCache({ astCache, projectRoot, files: ownFiles });

  // Fix 3c: fail closed if any own-mapping file has a tree-sitter parse error.
  // A partial tree on a syntax-error file can cause a false PASS — treat it as
  // an infrastructure problem (checkRuntime disposition) symmetric with AstRunnerError.
  for (const f of ownFiles) {
    const cached = astCache.get(f.path);
    if (cached && cached.ast.rootNode.hasError) {
      const err = findFirstErrorNode(cached.ast.rootNode);
      throw new StructureRunnerError('STRUCTURE_SOURCE_PARSE_ERROR', {
        what: `Source file ${f.path} has a syntax error at line ${(err?.startPosition.row ?? 0) + 1}.`,
        why: `Tree-sitter could not parse the file cleanly. Walking a partial tree may produce a false PASS — the runner fails closed rather than letting a syntax-error file silently pass a deterministic check.`,
        next: `Fix the syntax error in ${f.path}, then re-run yg approve.`,
      });
    }
  }

  const ownFilesEnriched = enrichFilesWithAst(ownFiles, astCache);
  const ctx: Ctx = {
    node: {
      id: node.path,
      type: node.meta.type,
      mapping: node.meta.mapping ?? [],
      files: ownFilesEnriched,
      ports: (node.meta.ports ?? {}) as Record<string, Port>,
    },
    files: ownFilesEnriched,
    fs: ctxFs,
    graph: ctxGraph,
    parseAst: parsers.parseAst,
    parseYaml: parsers.parseYaml,
    parseJson: parsers.parseJson,
    parseToml: parsers.parseToml,
  };

  // PREWARMUP. Compute AST input set, prewarm cache.
  const astInputSet: File[] = [...ownFiles];
  for (const rel of (node.meta.relations ?? [])) {
    const target = graph.nodes.get(rel.target);
    if (!target) continue;
    for (const p of await enumerateMappedFilesAsync(target.meta.mapping ?? [], projectRoot)) {
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
    // Fix 3c (lazy cross-node gate): ctx.parseAst threw because the cached AST
    // has a syntax error. Fail closed — same disposition as the own-file eager check.
    if (err instanceof ParseAstSyntaxError) {
      throw new StructureRunnerError('STRUCTURE_SOURCE_PARSE_ERROR', {
        what: `Source file ${err.filePath} has a syntax error at line ${err.errorLine}.`,
        why: `Tree-sitter could not parse the file cleanly. Walking a partial tree may produce a false PASS — the runner fails closed rather than letting a syntax-error file silently pass a deterministic check.`,
        next: `Fix the syntax error in ${err.filePath}, then re-run yg approve.`,
      });
    }
    throw new StructureRunnerError('STRUCTURE_CHECK_THROWN', {
      what: `check.mjs threw an exception while running (aspect '${aspectId}').`,
      why: `${(err as Error).message}\n${(err as Error).stack ?? ''}`,
      next: `Fix the bug in check.mjs and re-run yg approve.`,
    });
  }

  if (raw !== null && typeof raw === 'object' && typeof (raw as Record<string, unknown>).then === 'function') {
    throw new StructureRunnerError('STRUCTURE_CHECK_ASYNC', {
      what: `check.mjs returned a Promise; only synchronous returns are supported.`,
      why: `The runner does not await check's return value.`,
      next: `Refactor check to be synchronous.`,
    });
  }
  if (!Array.isArray(raw)) {
    throw new StructureRunnerError('STRUCTURE_CHECK_RETURN_SHAPE', {
      what: `check.mjs returned ${typeof raw}, expected Violation[].`,
      why: `The runner reports violations from the array returned by check.`,
      next: `Return [] or Violation[] from check.`,
    });
  }

  const contextFiles = new Set<string>(ownFiles.map(f => f.path));
  for (const t of touchedFiles) contextFiles.add(t);

  const violations: Violation[] = [];
  for (const v of raw) {
    if (typeof v !== 'object' || v === null || typeof (v as Violation).message !== 'string') {
      throw new StructureRunnerError('STRUCTURE_CHECK_RETURN_SHAPE', {
        what: `Violation entry must be an object with a string 'message' field.`,
        why: `The runner renders each violation from its message and optional file/line.`,
        next: `Return objects shaped { message: string, file?: string, line?: number } from check.`,
      });
    }
    const vv = v as Violation;
    if (typeof vv.file === 'string' && !contextFiles.has(normalizeMappingPath(vv.file))) {
      throw new StructureRunnerError('STRUCTURE_CHECK_FILE_NOT_IN_CONTEXT', {
        what: `Violation references file '${vv.file}' not in ctx (own mapping or touched via ctx.fs/ctx.graph).`,
        why: `Author cannot synthesize violations against files they were not given.`,
        next: `Return only violations for files in ctx, or declare a relation to the node owning '${vv.file}'.`,
      });
    }
    violations.push(vv);
  }

  // Filter suppressed violations. Ranges come from each file's parsed tree in the
  // astCache (own files are eagerly parsed; cross-node files the check parsed are cached).
  // A violation with no file/line, or in a file with no parsed tree, is not suppressible.
  const rangesByFile = new Map<string, SuppressedRange[] | null>();
  function rangesFor(filePath: string): SuppressedRange[] | null {
    const existing = rangesByFile.get(filePath);
    if (existing !== undefined) return existing;
    const cached = astCache.get(filePath);
    const ranges = cached
      ? collectSuppressions(cached.ast, filePath, cached.content.split('\n').length)
      : null;
    rangesByFile.set(filePath, ranges);
    return ranges;
  }
  const visible = violations.filter(v => {
    if (typeof v.file !== 'string' || typeof v.line !== 'number') return true;
    const ranges = rangesFor(normalizeMappingPath(v.file));
    if (!ranges) return true;
    return !isLineSuppressed(ranges, aspectId, v.line);
  });

  return { violations: visible, touchedFiles, succeeded: true };
}

function findFirstErrorNode(node: SyntaxNode): SyntaxNode | null {
  if (node.isError) return node;
  for (const child of node.children) {
    const found = findFirstErrorNode(child);
    if (found) return found;
  }
  return null;
}
