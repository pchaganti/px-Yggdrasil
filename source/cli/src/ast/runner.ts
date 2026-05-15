import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { ensureLoaderRegistered } from './loader-hook.js';
import { parseFile } from './parser.js';
import { buildIssueMessage } from '../formatters/message-builder.js';
import { collectSuppressions, isLineSuppressed, SuppressMarkerError } from './suppress.js';
import type { Node } from 'web-tree-sitter';
import type { CheckContext, Violation } from './types.js';

export interface RunAstAspectParams {
  aspectDir: string;
  aspectId: string;
  files: Array<{ path: string }>;
  projectRoot: string;
}

export interface RunAstAspectResult {
  violations: Violation[];
}

export class AstRunnerError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'AstRunnerError';
  }
}

export { SuppressMarkerError };

export async function runAstAspect(params: RunAstAspectParams): Promise<RunAstAspectResult> {
  ensureLoaderRegistered();

  const checkPath = path.resolve(params.projectRoot, params.aspectDir, 'check.mjs');

  let mod: Record<string, unknown>;
  try {
    mod = await import(pathToFileURL(checkPath).href) as Record<string, unknown>;
  } catch (e: unknown) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'MODULE_NOT_FOUND' || code === 'ERR_MODULE_NOT_FOUND') {
      throw new AstRunnerError('AST_LOADER_RESOLVE_FAILED', buildIssueMessage({
        what: `Could not resolve a module imported by check.mjs (aspect '${params.aspectId}').`,
        why: `Missing module: ${(e as Error).message}.`,
        next: `Reinstall the CLI or remove the unresolved import from check.mjs.`,
      }));
    }
    throw e;
  }

  if (mod.check === undefined) {
    const defaultExport = mod.default;
    if (typeof defaultExport === 'function' && defaultExport.name === 'check') {
      throw new AstRunnerError('AST_CHECK_DEFAULT_EXPORT', buildIssueMessage({
        what: `check.mjs exports 'check' as default, but a NAMED export is required.`,
        why: `The runner imports the named export. A default export is invisible to it.`,
        next: `Change 'export default function check(...)' to 'export function check(...)'`,
      }));
    }
    throw new AstRunnerError('AST_CHECK_NOT_EXPORTED', buildIssueMessage({
      what: `check.mjs does not export a function named 'check' (aspect '${params.aspectId}').`,
      why: `The runner expects 'export function check(ctx) { ... }'.`,
      next: `Add a named export 'check' in check.mjs.`,
    }));
  }
  if (typeof mod.check !== 'function') {
    throw new AstRunnerError('AST_CHECK_NOT_FUNCTION', buildIssueMessage({
      what: `'check' is exported but is not a function (got ${typeof mod.check}).`,
      why: `The runner calls check(ctx).`,
      next: `Re-export check as a function.`,
    }));
  }
  if (mod.check.length !== 1) {
    throw new AstRunnerError('AST_CHECK_WRONG_ARITY', buildIssueMessage({
      what: `'check' must accept exactly 1 parameter (ctx); declared arity is ${mod.check.length}.`,
      why: `The runner invokes check(ctx).`,
      next: `Change the signature to function check(ctx).`,
    }));
  }

  const sourceFiles = [];
  for (const f of params.files) {
    const content = await readFile(path.resolve(params.projectRoot, f.path), 'utf-8');
    let ast;
    try {
      ast = await parseFile(f.path, content);
    } catch (e: unknown) {
      const msg = (e as Error).message ?? String(e);
      if (msg.startsWith('no parser for extension')) {
        throw new AstRunnerError('AST_NO_PARSER_FOR_EXTENSION', buildIssueMessage({
          what: msg + ` (file: ${f.path})`,
          why: `v1 supports only .ts/.tsx/.js/.mjs/.cjs/.jsx.`,
          next: `Remove ${f.path} from the node's mapping.`,
        }));
      }
      throw new AstRunnerError('AST_GRAMMAR_LOAD_FAILED', buildIssueMessage({
        what: `Failed to load tree-sitter grammar for ${f.path}: ${msg}`,
        why: `The bundled WASM grammar could not be loaded.`,
        next: `Reinstall the CLI.`,
      }));
    }
    if (ast.rootNode.hasError) {
      const err = findFirstErrorNode(ast.rootNode);
      throw new AstRunnerError('AST_SOURCE_PARSE_ERROR', buildIssueMessage({
        what: `Source file ${f.path} has a syntax error at line ${(err?.startPosition.row ?? 0) + 1}.`,
        why: `Tree-sitter could not parse the file cleanly.`,
        next: `Fix the syntax error in ${f.path}.`,
      }));
    }
    sourceFiles.push({ path: f.path, content, ast });
  }

  // Collect suppressions BEFORE invoking check
  const rangesPerFile = new Map<string, ReturnType<typeof collectSuppressions>>();
  for (const f of sourceFiles) {
    const totalLines = f.content.split('\n').length;
    rangesPerFile.set(f.path, collectSuppressions(f.ast, f.path, totalLines));
  }

  const ctx: CheckContext = { files: sourceFiles };
  let raw: unknown;
  try {
    raw = mod.check(ctx);
  } catch (e: unknown) {
    throw new AstRunnerError('AST_CHECK_THROWN', buildIssueMessage({
      what: `check.mjs threw an exception while running (aspect '${params.aspectId}').`,
      why: (e instanceof Error ? e.stack : undefined) ?? String(e),
      next: `Fix the bug in check.mjs and re-run yg approve.`,
    }));
  }

  if (raw !== null && typeof raw === 'object' && typeof (raw as Record<string, unknown>).then === 'function') {
    throw new AstRunnerError('AST_CHECK_ASYNC', buildIssueMessage({
      what: `check.mjs returned a Promise; only synchronous returns are supported in v1.`,
      why: `The runner does not await check's return value.`,
      next: `Refactor check to be synchronous.`,
    }));
  }

  if (!Array.isArray(raw)) {
    throw new AstRunnerError('AST_CHECK_RETURN_SHAPE', buildIssueMessage({
      what: `check.mjs returned ${typeof raw}, expected Violation[].`,
      why: `The runner reports violations from the array returned by check.`,
      next: `Return [] or Violation[] from check.`,
    }));
  }

  // Filter suppressed violations
  const filtered = (raw as Violation[]).filter(v => {
    const ranges = rangesPerFile.get(v.file);
    if (!ranges) return true;
    return !isLineSuppressed(ranges, params.aspectId, v.line);
  });

  return { violations: filtered };
}

function findFirstErrorNode(node: Node): Node | null {
  if (node.isError) return node;
  for (const child of node.children) {
    const found = findFirstErrorNode(child);
    if (found) return found;
  }
  return null;
}
