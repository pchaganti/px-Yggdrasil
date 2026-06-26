import { Command } from 'commander';
import chalk from 'chalk';
import { loadGraphOrAbort, abortOnUnexpectedError } from './preamble.js';
import { exitAfterFlush } from './exit-after-flush.js';
import { initDebugLog, debugWrite } from '../utils/debug-log.js';
import { appendToDebugLog } from '../io/debug-log-writer.js';
import { runCheck } from '../core/check.js';
import type { CheckIssue, CheckResult } from '../core/check.js';
import { runFill, FillGatingError } from '../core/fill.js';
import { buildIssueMessage } from '../formatters/message-builder.js';
import { STRUCTURAL_CODES, COMPLETENESS_CODES } from '../core/check-codes.js';
import path from 'node:path';
import { walkRepoFiles } from '../io/repo-scanner.js';
import { groupIssues, type IssueGroup } from './group-issues.js';

export function registerCheckCommand(program: Command): void {
  program
    .command('check')
    .description('Unified graph gate — verification, coverage, completeness')
    .option('--approve', 'Fill every unverified pair (deterministic first, then LLM), then report')
    .option('--only-deterministic', 'With --approve: fill ONLY deterministic pairs (keyless, free); committed locks stay untouched. For CI and pre-commit.')
    .option('--dry-run', 'With --approve: free cost preview — print the budget + per-node/per-aspect breakdown, then exit 0 WITHOUT writing anything or calling the reviewer.')
    .option('--top [n]', 'Read-only triage: print only the N highest-priority issue blocks (bare --top = just the single suggestedNext block). Header counts + exit code stay TRUE.')
    .option('--summary', 'Read-only triage: print per-node counts only (no per-issue blocks). Header counts + exit code stay TRUE.')
    .action(async (opts: { approve?: boolean; onlyDeterministic?: boolean; dryRun?: boolean; top?: boolean | string; summary?: boolean }) => {
      try {
        const cwd = process.cwd();
        const graph = await loadGraphOrAbort(cwd, { tolerateInvalidConfig: true });
        initDebugLog(graph.rootPath, graph.config.debug ?? false, appendToDebugLog);
        const projectRoot = path.dirname(graph.rootPath);
        const gitFiles = await walkRepoFiles(projectRoot);

        // --top and --summary are READ-ONLY triage views over the plain check wall.
        // They are mutually exclusive with each other, and neither combines with
        // --approve (which has its own --dry-run cost preview). Reject the bad
        // combinations with guided errors before any work runs.
        const wantsTop = opts.top !== undefined;
        if (wantsTop && opts.summary) {
          process.stderr.write(chalk.red(buildIssueMessage({
            what: '--top and --summary cannot be combined.',
            why: 'Both are read-only triage VIEWS of the same `yg check` result — --top renders the N highest-priority blocks, --summary renders per-node counts only. Asking for both at once is ambiguous; pick one lens.',
            next: 'Run: yg check --top <n> (priority blocks), or yg check --summary (per-node counts).',
          }) + '\n'));
          await exitAfterFlush(1);
          return;
        }
        if ((wantsTop || opts.summary) && opts.approve) {
          process.stderr.write(chalk.red(buildIssueMessage({
            what: `${wantsTop ? '--top' : '--summary'} cannot be combined with --approve.`,
            why: '--top and --summary triage the READ-ONLY check wall (they narrow the output of plain `yg check`, which writes nothing). --approve is the writer path; its own free cost preview is --dry-run. Mixing a read-only triage view with the writer is contradictory.',
            next: `Run: yg check ${wantsTop ? '--top <n>' : '--summary'} (read-only triage), or yg check --approve --dry-run (preview the writer's cost).`,
          }) + '\n'));
          await exitAfterFlush(1);
          return;
        }

        // Resolve the read-only triage view. undefined --top = absent (full view);
        // a numeric/garbage --top is validated here (a NaN/negative/0-as-garbage
        // value is a guided error, never a silent full dump).
        let view: CheckView = { kind: 'full' };
        if (opts.summary) {
          view = { kind: 'summary' };
        } else if (wantsTop) {
          const n = resolveTopValue(opts.top);
          if (n === null) {
            process.stderr.write(chalk.red(buildIssueMessage({
              what: `--top expects a non-negative whole number; got "${String(opts.top)}".`,
              why: '--top N prints the N highest-priority issue blocks. A negative, fractional, or non-numeric value is meaningless, and printing the full wall instead would silently hide that the flag was ignored — masking the very output you tried to narrow.',
              next: 'Run: yg check --top 5 (top 5 blocks), yg check --top (just the suggestedNext block), or yg check (full output).',
            }) + '\n'));
            await exitAfterFlush(1);
            return;
          }
          view = { kind: 'top', n };
        }

        // --dry-run is a preview MODE of --approve, not a standalone alias for the
        // plain read. Without --approve it is a usage error: steer the agent to the
        // intended command rather than silently behaving like `yg check`.
        if (opts.dryRun && !opts.approve) {
          process.stderr.write(chalk.red(buildIssueMessage({
            what: '--dry-run requires --approve.',
            why: '--dry-run previews what `yg check --approve` would fill (the reviewer-call budget and per-node breakdown) without writing or calling the reviewer; it is a mode of --approve, not a variant of the plain read. Plain `yg check` is already a free, no-write read.',
            next: 'Run: yg check --approve --dry-run (cost preview), or yg check (plain read).',
          }) + '\n'));
          await exitAfterFlush(1);
          return;
        }

        // --approve is the combiner: fill every unverified pair (deterministic first, then
        // LLM), then report. With --only-deterministic it fills only the free deterministic
        // pairs and writes only the gitignored lock. With --dry-run it previews the cost and
        // writes nothing. Plain `yg check` is a pure read that never executes a reviewer or
        // a deterministic check.
        if (opts.approve) {
          try {
            // The CLI layer owns formatting: fill.ts (an engine module) emits
            // structured diagnostics; we render them here via buildIssueMessage.
            const fill = await runFill(graph, {
              gitTrackedFiles: gitFiles,
              onlyDeterministic: opts.onlyDeterministic ?? false,
              dryRun: opts.dryRun ?? false,
              emitIssue: (m) => { process.stdout.write(buildIssueMessage(m) + '\n'); },
            });
            process.stdout.write(formatOutput(fill.checkResult));
            // A dry-run is a cost preview only — it never writes and must never fail
            // the build for unverified/refused pairs it merely previewed. Exit 0 always.
            if (opts.dryRun) {
              await exitAfterFlush(0);
              return;
            }
            // Route EVERY exit through exitAfterFlush — a clean run too — so its
            // drain + unref'd force-exit backstop always runs. The fill stage opens
            // LLM-provider handles (undici keep-alive sockets, per-request
            // AbortSignal timers); without the forced exit a CLEAN --approve would
            // fall through to a bare return and rely on the event loop draining,
            // hanging indefinitely on any lingering handle after the report printed.
            const hasErrors = fill.checkResult.issues.some(i => i.severity === 'error');
            await exitAfterFlush(hasErrors ? 1 : 0);
            return;
          } catch (err) {
            if (err instanceof FillGatingError) {
              // The structural gate already printed the gating details.
              debugWrite(`[check] fill aborted by structural gate: ${err instanceof Error ? err.message : String(err)}`);
              await exitAfterFlush(1);
            }
            throw err;
          }
        }

        const result = await runCheck(graph, gitFiles);
        process.stdout.write(formatOutput(result, view));

        // Exit code is derived from the FULL issue set, OUTSIDE formatOutput and
        // independent of the chosen view — a truncated --top/--summary render must
        // never read as a clean build over errors it merely declined to print.
        // Same as the --approve path: always route the exit through exitAfterFlush
        // so drain + the force-exit backstop run uniformly (plain check opens no
        // reviewer handles, but keeping one exit path means the guarantee can't
        // regress in one branch while holding in the other).
        const hasErrors = result.issues.some(i => i.severity === 'error');
        await exitAfterFlush(hasErrors ? 1 : 0);
      } catch (error) {
        debugWrite(`[check] error: ${(error as Error).message}`);
        abortOnUnexpectedError(error, 'running check');
      }
    });
}

// ── Output formatting ──────────────────────────────────────

/** Code sets for grouping errors by category. STRUCTURAL_CODES and
 *  COMPLETENESS_CODES are shared with the check engine via core/check-codes.ts
 *  so the rendered grouping and the summary tally cannot drift apart. */
const ARCHITECTURE_CODES = new Set(['relation-target-forbidden', 'parent-type-forbidden', 'type-undefined', 'port-missing-aspect', 'port-missing-consumes', 'port-undefined', 'consumes-without-ports']);
// `unmapped-files` renders through renderUnmappedBlock (count + file list).
// `mapping-path-missing` is NOT a coverage code: it carries a nodePath and
// structured messageData, so it falls through to the normal validation-error
// renderer (code + node path + what/why/next) — renderUnmappedBlock would
// otherwise drop both the code and the offending node path.
const COVERAGE_CODES = new Set(['unmapped-files']);
const STRICT_CODES = new Set(['type-strict-orphan', 'type-strict-misplaced', 'strict-overlap-conflict']);

/**
 * Read-only render mode for `yg check`. Selected by --top / --summary; the
 * --approve path always uses `full`. EVERY view renders the same header with the
 * TRUE error/warning counts and keeps the single `Next:` line — only the body
 * (which issue blocks, if any, are rendered) changes. The exit code is computed
 * outside this function from the full issue set, so no view can read as green.
 *   - full    : header + every error/warning block + Next.
 *   - top  n  : header + at most n issue blocks in suggestedNext priority order
 *               + Next. n === 0 (bare --top) renders zero blocks, Next only.
 *   - summary : header + per-node aggregate counts + Next (no per-issue blocks).
 */
export type CheckView = { kind: 'full' } | { kind: 'top'; n: number } | { kind: 'summary' };

/**
 * Parse a raw --top value into a non-negative block count, or null on garbage.
 *   - undefined  → caller treats as absent (full view); tolerated → 0.
 *   - true       → bare `--top` (commander gives boolean true for an optional
 *                  arg supplied with no value) → 0 (suggestedNext-only).
 *   - "<int≥1>"  → that integer (the number of blocks to render).
 *   - "0"        → null (guided error): an EXPLICIT `--top 0` is meaningless
 *                  garbage — to get the suggestedNext-only view, pass bare
 *                  `--top` (which maps to 0 internally). The bare-flag path and
 *                  the explicit-"0" path are deliberately distinct.
 *   - NaN / negative / fractional / non-numeric → null (guided error).
 * NOTE: commander 15 yields boolean `true` (not a registered default) for a bare
 * `--top`, so the caller branches on `typeof opts.top`; this mirrors that here.
 */
export function resolveTopValue(raw: boolean | string | undefined): number | null {
  if (raw === undefined) return 0;
  if (raw === true) return 0; // bare --top → suggestedNext-only
  if (raw === false) return null; // not a shape commander produces here, but be explicit
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null; // rejects negatives, decimals, "abc", ""
  const n = parseInt(trimmed, 10);
  if (Number.isNaN(n) || n < 1) return null; // explicit "0" is garbage; bare --top is the zero-block path
  return n;
}

export function formatOutput(result: CheckResult, view: CheckView = { kind: 'full' }): string {
  const errors = result.issues.filter(i => i.severity === 'error');
  const warnings = result.issues.filter(i => i.severity === 'warning');

  // Header ALWAYS uses the full counts — in every view. Only the body changes.
  const header = renderHeader(result, errors.length, warnings.length);
  const sections: string[] = [header];

  if (view.kind === 'summary' || view.kind === 'top') {
    // Both triage views ALWAYS print the aggregate Errors(N)/Warnings(N)
    // subheaders with the TRUE totals — only the body beneath them changes
    // (per-node counts for summary; up-to-n priority blocks for top). This is
    // what stops a truncated view from reading as a clean build.
    const body = view.kind === 'summary'
      ? renderSummaryBody(errors, warnings)
      : renderTopBody(errors, warnings, view.n);
    if (errors.length > 0) {
      sections.push('');
      sections.push(chalk.red(`Errors (${errors.length}):`));
      if (body.errorLines) sections.push(body.errorLines);
    }
    if (warnings.length > 0) {
      sections.push('');
      sections.push(chalk.yellow(`Warnings (${warnings.length}):`));
      if (body.warningLines) sections.push(body.warningLines);
    }
  } else {
    if (errors.length > 0) {
      sections.push('');
      sections.push(renderErrorSection(errors));
    }
    if (warnings.length > 0) {
      sections.push('');
      sections.push(renderWarningSection(warnings));
    }
  }

  if (result.suggestedNext) {
    // Render the Next line whenever computeSuggestedNext produced one — including a
    // warnings-only PASS, where it falls back to the first advisory aspect-violation
    // warning's `next`. A FULLY-GREEN run (no errors, no warnings) yields a null
    // suggestedNext and prints no Next line — a clean run is self-evidently done.
    // Show only the first line — the actionable command, without annotation text.
    const nextCmd = result.suggestedNext.split('\n')[0];
    sections.push('');
    sections.push(`Next: ${nextCmd}`);
  }

  sections.push('');
  return sections.join('\n');
}

// ── Top view: prioritized blocks ───────────────────────────

/**
 * Priority rank for an issue, mirroring computeSuggestedNext's §6 cascade so the
 * --top view surfaces the same issues the suggestedNext line points at, in the
 * same order. Lower rank = higher priority. Errors always outrank warnings.
 */
const ERROR_CODE_PRIORITY: string[] = [
  'lock-invalid',
  'log-entry-missing',
  'unverified',
  'aspect-violation-enforced',
  'prompt-too-large',
  'aspect-companion-runtime-error',
  'log-conflict',
  'log-integrity',
  'log-format',
  'mapped-file-gitignored',
];

export function issuePriorityRank(issue: CheckIssue): number {
  const idx = ERROR_CODE_PRIORITY.indexOf(issue.code);
  if (idx >= 0) return idx;
  // Unranked errors (structural / architecture / coverage / completeness /
  // strict) sort after the explicitly-ranked ones but before warnings.
  if (issue.severity === 'error') return ERROR_CODE_PRIORITY.length;
  // Warnings always last.
  return ERROR_CODE_PRIORITY.length + 1;
}

/** A triage-view body split by severity, so each block lands under its
 *  aggregate Errors(N)/Warnings(N) subheader (rendered by formatOutput). */
interface ViewBody { errorLines: string; warningLines: string }

/**
 * Render at most `n` issue blocks in priority order (errors before warnings,
 * stable by nodePath within a tier), splitting the chosen blocks by severity.
 * n === 0 renders nothing — the aggregate subheaders and Next line still print.
 */
function renderTopBody(errors: CheckIssue[], warnings: CheckIssue[], n: number): ViewBody {
  if (n <= 0) return { errorLines: '', warningLines: '' };
  const ordered = [...errors, ...warnings].sort((a, b) => {
    const ra = issuePriorityRank(a);
    const rb = issuePriorityRank(b);
    if (ra !== rb) return ra - rb;
    return (a.nodePath ?? '').localeCompare(b.nodePath ?? '', 'en');
  });
  const chosen = ordered.slice(0, n);
  const renderOne = (issue: CheckIssue): string => {
    const lines: string[] = [];
    // Coverage issues (unmapped / uncovered-advisory) render through the compact
    // block; all other issues through the labelled issue block.
    if (issue.code === 'unmapped-files') {
      renderUnmappedBlock(issue, lines);
    } else if (issue.code === 'uncovered-advisory') {
      renderUnmappedBlock(issue, lines, 'uncovered');
    } else {
      renderIssueBlock(issue, lines, issue.severity === 'error' ? 'error' : 'warning');
    }
    return lines.join('\n');
  };
  const errBlocks = chosen.filter(i => i.severity === 'error').map(renderOne);
  const warnBlocks = chosen.filter(i => i.severity === 'warning').map(renderOne);
  // Lead each block with a blank line (separating it from the subheader and
  // from the preceding block), matching the full-view spacing.
  const lead = (blocks: string[]): string => blocks.map(b => `\n${b}`).join('\n');
  return { errorLines: lead(errBlocks), warningLines: lead(warnBlocks) };
}

// ── Summary view: per-node aggregate counts ────────────────

/**
 * Render per-node aggregate counts only — no per-issue blocks, no Why:/Fix:
 * lines. Each node line reports its pair states split by reviewer kind plus a
 * refused tally; NON-PAIR errors (coverage / log / relation / structural — no
 * pairKind) are bucketed per node as "other" so the per-node totals reconcile
 * with the true header Errors(N)/Warnings(N) counts and are NEVER silently
 * dropped. Rows are split by severity so each lands under its aggregate
 * subheader; a node with both error and warning issues appears under both.
 */
function renderSummaryBody(errors: CheckIssue[], warnings: CheckIssue[]): ViewBody {
  return { errorLines: renderSummaryRows(errors), warningLines: renderSummaryRows(warnings) };
}

function renderSummaryRows(issues: CheckIssue[]): string {
  if (issues.length === 0) return '';

  interface NodeAgg {
    unverifiedDet: number;
    unverifiedLlm: number;
    refused: number;
    other: number;
  }
  const byNode = new Map<string, NodeAgg>();
  const agg = (node: string): NodeAgg => {
    let a = byNode.get(node);
    if (!a) {
      a = { unverifiedDet: 0, unverifiedLlm: 0, refused: 0, other: 0 };
      byNode.set(node, a);
    }
    return a;
  };

  for (const issue of issues) {
    const node = issue.nodePath ?? '(repo)';
    const a = agg(node);
    if (issue.code === 'unverified') {
      if (issue.pairKind === 'deterministic') a.unverifiedDet++;
      else if (issue.pairKind === 'llm') a.unverifiedLlm++;
      else a.other++; // unverified without a pairKind should not occur, but never drop it
    } else if (issue.code === 'aspect-violation-enforced' || issue.code === 'aspect-violation-advisory') {
      a.refused++;
    } else {
      // Non-pair errors/warnings (coverage / log / relation / structural /
      // unmapped / uncovered-advisory): bucket as "other" so totals reconcile.
      // Count by ISSUE OBJECT, not file count — the header Errors(N)/Warnings(N)
      // counts each aggregate coverage issue (e.g. one unmapped-files issue with
      // uncoveredCount=7) as ONE, so the per-node "other" bucket must too, or the
      // summary would over-count and not reconcile with the header.
      a.other += 1;
    }
  }

  const lines: string[] = [];
  for (const node of [...byNode.keys()].sort((x, y) => x.localeCompare(y, 'en'))) {
    const a = byNode.get(node)!;
    const unverified = a.unverifiedDet + a.unverifiedLlm;
    const parts: string[] = [];
    parts.push(`${unverified} unverified (${a.unverifiedDet} deterministic-free, ${a.unverifiedLlm} LLM)`);
    parts.push(`${a.refused} refused`);
    if (a.other > 0) parts.push(`${a.other} other`);
    lines.push(`  ${node}  ${parts.join(', ')}`);
  }
  return lines.join('\n');
}

// ── Header ─────────────────────────────────────────────────

function renderHeader(result: CheckResult, errorCount: number, warningCount: number): string {
  let verdict: string;
  if (errorCount > 0) {
    verdict = chalk.red('yg check: FAIL');
  } else if (warningCount > 0) {
    verdict = `${chalk.green('yg check: PASS')} (${warningCount} warning${warningCount === 1 ? '' : 's'})`;
  } else {
    verdict = chalk.green('yg check: PASS');
  }

  const metrics: string[] = [`${result.nodeCount} nodes`];

  if (result.totalFiles > 0) {
    const ratio = `${result.coveredFiles}/${result.totalFiles} files`;
    if (result.coveredFiles < result.totalFiles) {
      const pct = Math.round((result.coveredFiles / result.totalFiles) * 100);
      metrics.push(`${ratio} (${pct}%)`);
    } else {
      metrics.push(ratio);
    }
  }

  metrics.push(`${result.aspectCount} aspects`);
  metrics.push(`${result.flowCount} flows`);

  if (result.draftSkipped > 0) {
    metrics.push(`${result.draftSkipped} draft`);
  }

  return `${verdict}  ${metrics.join(' · ')}`;
}

// ── Error section ──────────────────────────────────────────

function renderErrorSection(errors: CheckIssue[]): string {
  const lines: string[] = [chalk.red(`Errors (${errors.length}):`)];

  // Verdict-lock codes (spec §6/§10): rendered individually as labelled blocks.
  // `unverified` and `prompt-too-large` lead — they are the highest-priority
  // remediations after lock-invalid. `lock-invalid` is in STRUCTURAL_CODES, so
  // it renders in the structural group.
  const verification = errors.filter(i => i.code === 'unverified' || i.code === 'prompt-too-large');
  const unmapped = errors.filter(i => COVERAGE_CODES.has(i.code));
  const structural = errors.filter(i => STRUCTURAL_CODES.has(i.code));
  const architecture = errors.filter(i => ARCHITECTURE_CODES.has(i.code));
  const completeness = errors.filter(i => COMPLETENESS_CODES.has(i.code));
  const strict = errors.filter(i => STRICT_CODES.has(i.code));
  const logErrors = errors.filter(i => i.code === 'log-conflict' || i.code === 'log-integrity' || i.code === 'log-format' || i.code === 'log-entry-missing');
  const aspectErrors = errors.filter(i => i.code === 'aspect-violation-enforced');
  const remaining = errors.filter(i =>
    !verification.includes(i) && !unmapped.includes(i) && !structural.includes(i) &&
    !architecture.includes(i) && !completeness.includes(i) && !strict.includes(i) &&
    !logErrors.includes(i) && !aspectErrors.includes(i),
  );

  for (const group of [verification, aspectErrors, structural, architecture, completeness, strict, logErrors, remaining]) {
    for (const issue of sortByNodePath(group)) {
      lines.push('');
      renderIssueBlock(issue, lines, 'error');
    }
  }

  // Unmapped files — compact block with file list
  for (const issue of unmapped) {
    lines.push('');
    renderUnmappedBlock(issue, lines);
  }

  return lines.join('\n');
}

// ── Warning section ────────────────────────────────────────

function renderWarningSection(warnings: CheckIssue[]): string {
  const lines: string[] = [chalk.yellow(`Warnings (${warnings.length}):`)];
  const coverage = warnings.filter(i => i.code === 'uncovered-advisory');
  const rest = warnings.filter(i => i.code !== 'uncovered-advisory');
  for (const issue of sortByNodePath(rest)) {
    lines.push('');
    renderIssueBlock(issue, lines, 'warning');
  }
  for (const issue of coverage) {
    lines.push('');
    renderUnmappedBlock(issue, lines, 'uncovered');
  }
  return lines.join('\n');
}

// ── Per-issue block ────────────────────────────────────────

/**
 * Codes whose `messageData.what` carries the actionable refusal detail (the
 * reviewer's reason / the deterministic violation list) on lines AFTER the first.
 * For these, the full multi-line `what` is rendered — truncating to line 1 would
 * hide the very thing the agent needs to fix the code, leaving plain `yg check`
 * strictly less informative than `yg aspect-test`. All other codes keep the
 * terse one-line summary.
 */
export const FULL_WHAT_CODES = new Set([
  'aspect-violation-enforced',
  'aspect-violation-advisory',
  // The relation refusal's `what` carries the violation list (each
  // `<file>:<line> → undeclared dependency on <node>`) on lines after the
  // first; truncating to line 1 would hide which import in which file drives
  // the refusal — the very thing the agent needs to declare or remove.
  'relation-undeclared-dependency',
]);

/** Indent applied to continuation lines so they align under the block body. */
const BLOCK_INDENT = '            ';

/**
 * Render a single issue (non-cascade, non-unmapped) as a labelled block:
 *   <label>  <node-path>  <what summary>
 *            <…full what detail for refusal codes…>
 *            Why: <why>
 *            Fix: <next>
 * plus an (advisory — not blocking) note for advisory warnings.
 *
 * For refusal codes (FULL_WHAT_CODES) the complete multi-line `what` is shown:
 * the first line as the block header, every subsequent line indented under it —
 * this is where the reviewer reason / violation list lives. All other codes show
 * only line 1 (terse one-line format preserved for unverified / prompt-too-large
 * / structural issues).
 *
 * Accesses issue.messageData.{what,why,next} directly — the structured renderer
 * pattern permitted by the what-why-next aspect for CLI renderers that need
 * labelled output instead of the flat buildIssueMessage concatenation.
 */
function renderIssueBlock(issue: CheckIssue, lines: string[], mode: 'error' | 'warning'): void {
  const md = issue.messageData;
  const whatLines = md.what.split('\n');
  const label = getIssueLabel(issue);
  const nodePath = issue.nodePath ?? '';

  lines.push(`  ${label}  ${nodePath}  ${whatLines[0]}`);
  // Refusal codes: render the remaining `what` lines (reviewer reason /
  // violation list) indented under the header so the agent sees the full
  // refusal detail in plain `yg check`, not only via `yg aspect-test`.
  if (FULL_WHAT_CODES.has(issue.code)) {
    for (const extra of whatLines.slice(1)) {
      lines.push(`${BLOCK_INDENT}${extra}`);
    }
  }
  if (md.why) {
    lines.push(`${BLOCK_INDENT}Why: ${md.why}`);
  }
  if (md.next) {
    // Advisory warnings never block: advisory aspect violations AND advisory
    // unverified pairs (an unverified pair renders as a warning only when its
    // effective status is advisory) both carry the not-blocking hint.
    const isAdvisory =
      mode === 'warning' &&
      (issue.code === 'aspect-violation-advisory' || issue.code === 'unverified');
    const fixSuffix = isAdvisory ? '  (advisory — not blocking)' : '';
    // `next` may itself be multi-line (cached-refusal "three exits"); keep the
    // full instruction, suffixing only the first line with the advisory hint.
    const nextLines = md.next.split('\n');
    lines.push(`${BLOCK_INDENT}Fix: ${nextLines[0]}${fixSuffix}`);
    for (const extra of nextLines.slice(1)) {
      lines.push(`${BLOCK_INDENT}${extra}`);
    }
  }
}

/**
 * Render unmapped-files error (or uncovered-advisory warning) as a compact block with file list.
 * Derives all rendered content from issue.messageData (what/why/next) as required
 * by the what-why-next aspect. The terse format uses the count from messageData.what
 * and lists files from issue.uncoveredFiles (the structured data parallel to what).
 */
function renderUnmappedBlock(issue: CheckIssue, lines: string[], label = 'unmapped'): void {
  const md = issue.messageData;
  const files = issue.uncoveredFiles ?? [];
  // Use the authoritative structured count; fall back to file list length only
  // if uncoveredCount was never set (should not happen in practice).
  const count = issue.uncoveredCount ?? files.length;
  const countLabel = String(count);
  lines.push(`  ${label} (${countLabel})`);
  // Show file list derived from messageData.what body lines (same data as uncoveredFiles).
  const shown = files.slice(0, 10);
  for (const f of shown) {
    lines.push(`            ${f}`);
  }
  if (files.length > 10) {
    lines.push(`            ... +${files.length - 10}`);
  }
  if (md.why) {
    lines.push(`            Why: ${md.why}`);
  }
  if (md.next) {
    lines.push(`            Fix: ${md.next.split('\n')[0]}`);
  }
}

// ── Grouped block render ───────────────────────────────────

const CAP_NODES = 12;

/** Jargon glosses: machine token first, human gloss in parentheses (parseable by tooling). */
const LABEL_GLOSS: Record<string, string> = { unverified: 'unverified (not yet reviewed)' };

function glossLabel(label: string): string { return LABEL_GLOSS[label] ?? label; }

/**
 * Render a single IssueGroup as a unified block:
 *   <glossLabel(label)>  <P> pairs  <M> nodes[  aspect '<id>']
 *   <sharedWhy>
 *   Fix: <sharedNext> (single-line) or Fix: + indented continuation lines (multi-line)
 *   - <node> (one per member; perMemberReason: includes first detail line from messageData.what)
 *   ... and K more (yg check --aspect <id>)  [TTY-only, when members > CAP_NODES]
 */
export function renderGroup(group: IssueGroup, lines: string[], opts: { isTTY: boolean }): void {
  const aspectSeg = group.aspectId ? `  aspect '${group.aspectId}'` : '';
  lines.push(`  ${glossLabel(group.label)}  ${group.pairCount} pairs  ${group.nodeCount} nodes${aspectSeg}`);
  if (group.sharedWhy) lines.push(`${BLOCK_INDENT}${group.sharedWhy}`);
  if (group.sharedNext) {
    const nextLines = group.sharedNext.split('\n');
    lines.push(`${BLOCK_INDENT}Fix: ${nextLines[0]}`);
    for (const extra of nextLines.slice(1)) lines.push(`${BLOCK_INDENT}${extra}`);
  }
  const members = group.members;
  const truncate = opts.isTTY && members.length > CAP_NODES;
  const shown = truncate ? members.slice(0, CAP_NODES) : members;
  for (const m of shown) {
    const node = m.nodePath ?? '';
    if (group.perMemberReason) {
      // First detail line from messageData.what (line after line 0)
      const detail = (m.messageData.what.split('\n')[1] ?? '').trim();
      lines.push(`${BLOCK_INDENT}- ${node}${detail ? `  ${detail}` : ''}`);
    } else {
      lines.push(`${BLOCK_INDENT}- ${node}`);
    }
  }
  if (truncate) {
    const drill = group.aspectId ? ` (yg check --aspect ${group.aspectId})` : '';
    lines.push(`${BLOCK_INDENT}... and ${members.length - CAP_NODES} more${drill}`);
  }
}

// ── Helpers ────────────────────────────────────────────────

export function getIssueLabel(issue: CheckIssue): string {
  // Verdict-lock states (spec §10).
  if (issue.code === 'unverified') return 'unverified';
  if (issue.code === 'prompt-too-large') return 'prompt-too-large';
  if (issue.code === 'lock-invalid') return 'lock-invalid';
  if (issue.code === 'aspect-violation-advisory') return 'advisory';
  if (issue.code === 'aspect-violation-enforced') return 'enforced';
  if (issue.code === 'log-conflict') return 'log-conflict';
  if (issue.code === 'log-integrity') return 'log-integrity';
  if (issue.code === 'log-format') return 'log-format';
  if (STRUCTURAL_CODES.has(issue.code)) return issue.code;
  if (ARCHITECTURE_CODES.has(issue.code)) return issue.code;
  if (COMPLETENESS_CODES.has(issue.code)) return issue.code;
  if (STRICT_CODES.has(issue.code)) return issue.code;
  return issue.code;
}

function sortByNodePath(issues: CheckIssue[]): CheckIssue[] {
  return [...issues].sort((a, b) => (a.nodePath ?? '').localeCompare(b.nodePath ?? '', 'en'));
}

