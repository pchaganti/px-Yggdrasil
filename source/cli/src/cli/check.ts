import { Command } from 'commander';
import chalk from 'chalk';
import { loadGraphOrAbort, abortOnUnexpectedError } from './preamble.js';
import { initDebugLog, debugWrite } from '../utils/debug-log.js';
import { appendToDebugLog } from '../io/debug-log-writer.js';
import { runCheck } from '../core/check.js';
import type { CheckIssue, CheckResult } from '../core/check.js';
import { STRUCTURAL_CODES, COMPLETENESS_CODES } from '../core/check-codes.js';
import { buildIssueMessage } from '../formatters/message-builder.js';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

export function registerCheckCommand(program: Command): void {
  program
    .command('check')
    .description('Unified graph gate — errors, drift, coverage, completeness')
    .action(async () => {
      try {
        const cwd = process.cwd();
        const graph = await loadGraphOrAbort(cwd, { tolerateInvalidConfig: true });
        initDebugLog(graph.rootPath, graph.config.debug ?? false, appendToDebugLog);

        // Get git-tracked files for unmapped-files check
        let gitFiles: string[] | null = null;
        try {
          const projectRoot = path.dirname(graph.rootPath);
          const output = execFileSync('git', ['ls-files', '.'], {
            cwd: projectRoot,
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'],
          });
          gitFiles = output.trim().split('\n').filter(f => f.length > 0);
        } catch (e: unknown) {
          debugWrite(`[check] git ls-files failed: ${e instanceof Error ? e.message : String(e)}`);
          // Not a git repo or git not available — skip unmapped-files check
        }

        const result = await runCheck(graph, gitFiles);
        process.stdout.write(formatOutput(result));

        const hasErrors = result.issues.some(i => i.severity === 'error');
        if (hasErrors) process.exit(1);
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

  if (result.suggestedNext && errors.length > 0) {
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

  const cascade = errors.filter(i => i.code === 'upstream-drift');
  const nonCascade = errors.filter(i => i.code !== 'upstream-drift');

  // Group cascade errors by upstream cause
  if (cascade.length > 0) {
    const groups = groupCascadeErrors(cascade);
    for (const [causeKey, { causeDesc, nodeSet }] of groups) {
      void causeKey; // used as map key only
      const count = nodeSet.size;
      const nodeList = formatNodeList([...nodeSet].sort(), 6);
      // Determine the Fix command — if cause is an aspect, use --aspect flag
      const aspectMatch = causeDesc.match(/^aspect '([^']+)'/);
      const fixCmd = aspectMatch
        ? `yg approve --aspect ${aspectMatch[1]}`
        : `yg approve --node ${[...nodeSet].sort()[0]}`;
      // Use buildIssueMessage to satisfy the what-why-next aspect requirement for CLI renderers.
      const cascadeMsg = buildIssueMessage({
        what: `cascade (${count})  ${causeDesc}`,
        why: `${count} node${count === 1 ? '' : 's'} share this upstream cause`,
        next: fixCmd,
      });
      // Render the cascade group as a compact block: cause on first line, → nodes, Fix.
      // `cascadeMsg` (what/why/next concatenated) is the source; we present it with labels.
      const [cascadeWhat] = cascadeMsg.split('\n');
      lines.push('');
      lines.push(`  ${cascadeWhat}`);
      lines.push(`            → ${nodeList}`);
      lines.push(`            Fix: ${fixCmd}`);
    }
  }

  // Non-cascade errors: rendered individually
  if (nonCascade.length > 0) {
    const drift = nonCascade.filter(i => i.code === 'source-drift' || i.code === 'unapproved');
    const unmapped = nonCascade.filter(i => COVERAGE_CODES.has(i.code));
    const structural = nonCascade.filter(i => STRUCTURAL_CODES.has(i.code));
    const architecture = nonCascade.filter(i => ARCHITECTURE_CODES.has(i.code));
    const completeness = nonCascade.filter(i => COMPLETENESS_CODES.has(i.code));
    const strict = nonCascade.filter(i => STRICT_CODES.has(i.code));
    const logErrors = nonCascade.filter(i => i.code === 'log-integrity' || i.code === 'log-format');
    const aspectErrors = nonCascade.filter(i => i.code === 'aspect-newly-active' || i.code === 'aspect-violation-enforced');
    const remaining = nonCascade.filter(i =>
      !drift.includes(i) && !unmapped.includes(i) && !structural.includes(i) &&
      !architecture.includes(i) && !completeness.includes(i) && !strict.includes(i) &&
      !logErrors.includes(i) && !aspectErrors.includes(i),
    );

    for (const group of [drift, structural, architecture, completeness, strict, logErrors, aspectErrors, remaining]) {
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
 * Render a single issue (non-cascade, non-unmapped) as a 3-line block:
 *   <label>  <node-path>  <one-line what>
 *            Why: <why>
 *            Fix: <next>
 * plus an (advisory — not blocking) note for advisory warnings.
 *
 * Accesses issue.messageData.{what,why,next} directly — the structured renderer
 * pattern permitted by the what-why-next aspect for CLI renderers that need
 * labelled output instead of the flat buildIssueMessage concatenation.
 */
function renderIssueBlock(issue: CheckIssue, lines: string[], mode: 'error' | 'warning'): void {
  const md = issue.messageData;
  const what = md.what.split('\n')[0];
  const label = getIssueLabel(issue);
  const nodePath = issue.nodePath ?? '';

  lines.push(`  ${label}  ${nodePath}  ${what}`);
  if (md.why) {
    lines.push(`            Why: ${md.why}`);
  }
  if (md.next) {
    const isAdvisory = mode === 'warning' && issue.code === 'aspect-violation-advisory';
    const fixSuffix = isAdvisory ? '  (advisory — not blocking)' : '';
    lines.push(`            Fix: ${md.next}${fixSuffix}`);
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

// ── Cascade grouping ───────────────────────────────────────

interface CauseGroup {
  causeDesc: string;
  nodeSet: Set<string>;
}

/**
 * Group upstream-drift issues by their upstream cause.
 * Returns ordered map: causeKey → { causeDesc, nodeSet }.
 * Ordering: groups with most nodes first (so primary aspect change is prominent).
 */
function groupCascadeErrors(cascade: CheckIssue[]): Map<string, CauseGroup> {
  const groups = new Map<string, CauseGroup>();

  for (const issue of cascade) {
    for (const cause of issue.cascadeCauses ?? []) {
      // Primary key: the first sentence of the description (before any parenthetical)
      const key = cause.description.split('\n')[0].trim();
      const existing = groups.get(key);
      if (existing) {
        if (issue.nodePath) existing.nodeSet.add(issue.nodePath);
      } else {
        const nodeSet = new Set<string>();
        if (issue.nodePath) nodeSet.add(issue.nodePath);
        groups.set(key, { causeDesc: key, nodeSet });
      }
    }
  }

  // Sort groups by node count descending
  return new Map([...groups.entries()].sort((a, b) => b[1].nodeSet.size - a[1].nodeSet.size));
}

/**
 * Format a list of node paths compactly, showing path tails (last segment after final /).
 * Shows up to `max` names; if more exist, appends `... +N`.
 * Example: cli/commands/{approve, aspects, check, ... +9}
 */
function formatNodeList(paths: string[], max: number): string {
  if (paths.length === 0) return '{}';

  // Determine common prefix for compact display
  const tails = paths.map(p => {
    const parts = p.split('/');
    return parts[parts.length - 1];
  });

  const prefix = longestCommonPrefix(paths);
  // Trim back to the last directory boundary: drop any trailing partial segment,
  // then strip the trailing slash so re-appending '/' below yields exactly one
  // separator (the common prefix often already ends in '/').
  const trimmedPrefix = prefix.replace(/\/?[^/]+$/, '').replace(/\/+$/, '');

  const shown = tails.slice(0, max);
  const extra = paths.length - shown.length;

  const nameList = extra > 0
    ? `${shown.join(', ')}, ... +${extra}`
    : shown.join(', ');

  // If there's a meaningful common directory prefix, show it
  if (trimmedPrefix.length > 3 && paths.length > 1) {
    return `${trimmedPrefix}/{${nameList}}`;
  }

  return paths.length > 1 ? `{${nameList}}` : paths[0];
}

function longestCommonPrefix(strs: string[]): string {
  if (strs.length === 0) return '';
  let prefix = strs[0];
  for (let i = 1; i < strs.length; i++) {
    while (!strs[i].startsWith(prefix)) {
      prefix = prefix.slice(0, -1);
      if (!prefix) return '';
    }
  }
  return prefix;
}

// ── Helpers ────────────────────────────────────────────────

function getIssueLabel(issue: CheckIssue): string {
  if (issue.code === 'source-drift') return 'drift';
  if (issue.code === 'unapproved') return 'unapproved';
  if (issue.code === 'upstream-drift') return 'cascade';
  if (issue.code === 'aspect-violation-advisory') return 'advisory';
  if (issue.code === 'aspect-violation-enforced') return 'enforced';
  if (issue.code === 'aspect-newly-active') return 'aspect-newly-active';
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

