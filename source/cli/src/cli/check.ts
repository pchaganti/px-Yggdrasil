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
import { execFileSync } from 'node:child_process';
import path from 'node:path';

/** Collect the repo's git-tracked files for the coverage scan (null if unavailable). */
function collectGitFiles(projectRoot: string): string[] | null {
  try {
    const output = execFileSync('git', ['ls-files', '.'], {
      cwd: projectRoot,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return output.trim().split('\n').filter((f) => f.length > 0);
  } catch (e: unknown) {
    debugWrite(`[check] git ls-files failed: ${e instanceof Error ? e.message : String(e)}`);
    // Not a git repo or git not available — skip unmapped-files check.
    return null;
  }
}

export function registerCheckCommand(program: Command): void {
  program
    .command('check')
    .description('Unified graph gate — verification, coverage, completeness')
    .option('--approve', 'Fill every unverified pair (deterministic first, then LLM), then report')
    .option('--only-deterministic', 'With --approve: fill ONLY deterministic pairs (keyless, free); committed locks stay untouched. For CI and pre-commit.')
    .action(async (opts: { approve?: boolean; onlyDeterministic?: boolean }) => {
      try {
        const cwd = process.cwd();
        const graph = await loadGraphOrAbort(cwd, { tolerateInvalidConfig: true });
        initDebugLog(graph.rootPath, graph.config.debug ?? false, appendToDebugLog);
        const projectRoot = path.dirname(graph.rootPath);
        const gitFiles = collectGitFiles(projectRoot);

        // --approve is the combiner: fill every unverified pair (deterministic first, then
        // LLM), then report. With --only-deterministic it fills only the free deterministic
        // pairs and writes only the gitignored lock. Plain `yg check` is a pure read that
        // never executes a reviewer or a deterministic check.
        if (opts.approve) {
          try {
            // The CLI layer owns formatting: fill.ts (an engine module) emits
            // structured diagnostics; we render them here via buildIssueMessage.
            const fill = await runFill(graph, {
              gitTrackedFiles: gitFiles,
              onlyDeterministic: opts.onlyDeterministic ?? false,
              emitIssue: (m) => { process.stdout.write(buildIssueMessage(m) + '\n'); },
            });
            process.stdout.write(formatOutput(fill.checkResult));
            const hasErrors = fill.checkResult.issues.some(i => i.severity === 'error');
            if (hasErrors) await exitAfterFlush(1);
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
        process.stdout.write(formatOutput(result));

        const hasErrors = result.issues.some(i => i.severity === 'error');
        if (hasErrors) await exitAfterFlush(1);
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

export function formatOutput(result: CheckResult): string {
  const errors = result.issues.filter(i => i.severity === 'error');
  const warnings = result.issues.filter(i => i.severity === 'warning');

  const header = renderHeader(result, errors.length, warnings.length);
  const sections: string[] = [header];

  if (errors.length > 0) {
    sections.push('');
    sections.push(renderErrorSection(errors));
  }

  if (warnings.length > 0) {
    sections.push('');
    sections.push(renderWarningSection(warnings));
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
  const logErrors = errors.filter(i => i.code === 'log-integrity' || i.code === 'log-format');
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
const FULL_WHAT_CODES = new Set([
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

// ── Helpers ────────────────────────────────────────────────

function getIssueLabel(issue: CheckIssue): string {
  // Verdict-lock states (spec §10).
  if (issue.code === 'unverified') return 'unverified';
  if (issue.code === 'prompt-too-large') return 'prompt-too-large';
  if (issue.code === 'lock-invalid') return 'lock-invalid';
  if (issue.code === 'aspect-violation-advisory') return 'advisory';
  if (issue.code === 'aspect-violation-enforced') return 'enforced';
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

