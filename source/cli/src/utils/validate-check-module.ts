import type { IssueMessage } from '../model/validation.js';

export interface ValidateCheckModuleOptions {
  /** Error-code namespace — 'AST' or 'STRUCTURE'. */
  codePrefix: string;
  /** Human phrase identifying the aspect, e.g. "aspect 'foo'". */
  runnerLabel: string;
}

export type ValidateCheckModuleResult =
  | { ok: true }
  | { ok: false; code: string; message: IssueMessage };

/**
 * Shared guard ladder for a user-authored check.mjs module's export shape.
 * Both the AST runner and the structure runner import an ESM module and must
 * confirm it exposes a named, single-arg, callable `check` before invoking it.
 * Returning a discriminated result (rather than throwing) lets each runner
 * raise its own error class while sharing the detection logic and the
 * what/why/next vocabulary.
 */
export function validateCheckModuleExport(
  mod: Record<string, unknown>,
  opts: ValidateCheckModuleOptions,
): ValidateCheckModuleResult {
  const { codePrefix, runnerLabel } = opts;

  if (mod.check === undefined) {
    const defaultExport = mod.default;
    if (typeof defaultExport === 'function' && (defaultExport as { name?: string }).name === 'check') {
      return {
        ok: false,
        code: `${codePrefix}_CHECK_DEFAULT_EXPORT`,
        message: {
          what: `check.mjs exports 'check' as default, but a NAMED export is required (${runnerLabel}).`,
          why: `The runner imports the named export. A default export is invisible to it.`,
          next: `Change 'export default function check(...)' to 'export function check(...)'.`,
        },
      };
    }
    return {
      ok: false,
      code: `${codePrefix}_CHECK_NOT_EXPORTED`,
      message: {
        what: `check.mjs does not export a function named 'check' (${runnerLabel}).`,
        why: `The runner expects 'export function check(ctx) { ... }'.`,
        next: `Add a named export 'check' in check.mjs.`,
      },
    };
  }

  if (typeof mod.check !== 'function') {
    return {
      ok: false,
      code: `${codePrefix}_CHECK_NOT_FUNCTION`,
      message: {
        what: `'check' is exported but is not a function (got ${typeof mod.check}).`,
        why: `The runner calls check(ctx).`,
        next: `Re-export check as a function.`,
      },
    };
  }

  const checkFn = mod.check as (...args: unknown[]) => unknown;
  if (checkFn.length !== 1) {
    return {
      ok: false,
      code: `${codePrefix}_CHECK_WRONG_ARITY`,
      message: {
        what: `'check' must accept exactly 1 parameter (ctx); declared arity is ${checkFn.length}.`,
        why: `The runner invokes check(ctx).`,
        next: `Change the signature to function check(ctx).`,
      },
    };
  }

  return { ok: true };
}
