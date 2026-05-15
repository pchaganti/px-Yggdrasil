import { minimatch } from 'minimatch';
import type {
  FileWhenPredicate,
  PredicateTrace,
  EvaluationResult,
} from '../model/file-when.js';
import type { FileContentCache } from '../io/file-content-cache.js';

const YGGDRASIL_PREFIX = '.yggdrasil/';

/**
 * Native RegExp has no built-in timeout. Bound input length to avoid
 * pathological scans (catastrophic backtracking). 256KB head is enough
 * for content predicates; longer files indicate the wrong kind of check.
 */
function safeRegexTest(re: RegExp, str: string): { match: boolean; timeout?: boolean } {
  const HEAD_LIMIT = 256 * 1024;
  const head = str.length > HEAD_LIMIT ? str.slice(0, HEAD_LIMIT) : str;
  try {
    return { match: re.test(head) };
  } catch {
    return { match: false, timeout: true };
  }
}

export type EvalContext = {
  /** Absolute path to the file. */
  absPath: string;
  /** Repo-relative POSIX path (forward slashes). */
  repoRelPath: string;
  /** Absolute path to project root. */
  projectRoot: string;
  /** Per-run content cache. */
  cache: FileContentCache;
};

/**
 * Evaluate a FileWhenPredicate against a file. Returns boolean result plus
 * trace structure suitable for rendering predicate evaluation trees in
 * error messages (spec §7).
 *
 * Auto-exempts paths under `.yggdrasil/` (returns vacuously true).
 */
export async function evaluateFileWhen(
  predicate: FileWhenPredicate,
  ctx: EvalContext,
): Promise<EvaluationResult> {
  if (ctx.repoRelPath.startsWith(YGGDRASIL_PREFIX)) {
    return {
      result: true,
      trace: { kind: 'exempt', result: true, reason: '.yggdrasil/ auto-exempt' },
    };
  }

  return evaluatePredicate(predicate, ctx);
}

async function evaluatePredicate(
  predicate: FileWhenPredicate,
  ctx: EvalContext,
): Promise<EvaluationResult> {
  if ('all_of' in predicate) {
    const children: PredicateTrace[] = [];
    let allPass = true;
    let unreadable = false;
    let unreadableReason: string | undefined;
    for (const child of predicate.all_of) {
      const r = await evaluatePredicate(child, ctx);
      children.push(r.trace);
      if (!r.result) allPass = false;
      if (r.unreadable) {
        unreadable = true;
        unreadableReason ??= r.unreadableReason;
      }
    }
    return {
      result: allPass,
      ...(unreadable && { unreadable, unreadableReason }),
      trace: { kind: 'all_of', result: allPass, children },
    };
  }

  if ('any_of' in predicate) {
    const children: PredicateTrace[] = [];
    let anyPass = false;
    let unreadable = false;
    let unreadableReason: string | undefined;
    for (const child of predicate.any_of) {
      const r = await evaluatePredicate(child, ctx);
      children.push(r.trace);
      if (r.result) anyPass = true;
      if (r.unreadable) {
        unreadable = true;
        unreadableReason ??= r.unreadableReason;
      }
    }
    return {
      result: anyPass,
      ...(unreadable && !anyPass && { unreadable, unreadableReason }),
      trace: { kind: 'any_of', result: anyPass, children },
    };
  }

  if ('not' in predicate) {
    const r = await evaluatePredicate(predicate.not, ctx);
    return {
      result: !r.result,
      ...(r.unreadable && { unreadable: true, unreadableReason: r.unreadableReason }),
      trace: { kind: 'not', result: !r.result, child: r.trace },
    };
  }

  return evaluateAtomic(predicate, ctx);
}

async function evaluateAtomic(
  predicate: { path?: string; content?: string },
  ctx: EvalContext,
): Promise<EvaluationResult> {
  if (predicate.path !== undefined && predicate.content !== undefined) {
    return evaluatePredicate(
      { all_of: [{ path: predicate.path }, { content: predicate.content }] },
      ctx,
    );
  }

  if (predicate.path !== undefined) {
    const matches = minimatch(ctx.repoRelPath, predicate.path, { dot: true });
    return {
      result: matches,
      trace: { kind: 'atom-path', pattern: predicate.path, result: matches },
    };
  }

  if (predicate.content !== undefined) {
    const fileContent = await ctx.cache.read(ctx.absPath);
    if (fileContent.unreadable) {
      return {
        result: false,
        unreadable: true,
        unreadableReason: fileContent.unreadableReason ?? 'unreadable',
        trace: {
          kind: 'atom-content',
          pattern: predicate.content,
          result: false,
          detail: 'file unreadable',
        },
      };
    }
    if (fileContent.isBinary) {
      return {
        result: false,
        trace: {
          kind: 'atom-content',
          pattern: predicate.content,
          result: false,
          detail: 'file is binary (null bytes detected)',
        },
      };
    }
    if (fileContent.tooLarge) {
      return {
        result: false,
        trace: {
          kind: 'atom-content',
          pattern: predicate.content,
          result: false,
          detail: 'file >5MB, content not scanned',
        },
      };
    }
    const regex = new RegExp(predicate.content);
    const { match: matches } = safeRegexTest(regex, fileContent.content!);
    return {
      result: matches,
      trace: { kind: 'atom-content', pattern: predicate.content, result: matches },
    };
  }

  return {
    result: false,
    trace: { kind: 'atom-path', pattern: '<empty>', result: false, detail: 'empty atomic' },
  };
}
