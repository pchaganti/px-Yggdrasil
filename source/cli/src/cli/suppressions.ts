import { Command } from 'commander';
import chalk from 'chalk';
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { loadGraphOrAbort, abortOnUnexpectedError } from './preamble.js';
import { initDebugLog, debugWrite } from '../utils/debug-log.js';
import { appendToDebugLog } from '../io/debug-log-writer.js';
import { scanSuppressionMarkers } from '../ast/suppress.js';
import type { SuppressionMarkerInfo } from '../ast/suppress.js';
import { buildIssueMessage } from '../formatters/message-builder.js';
import { toPosixPath } from '../utils/posix.js';

// ── Types ──────────────────────────────────────────────────

interface FileMarkers {
  file: string;
  markers: SuppressionMarkerInfo[];
}

interface SuppressionsReport {
  fileEntries: FileMarkers[];
  totalMarkers: number;
  warnings: string[];
}

// ── Binary detection ───────────────────────────────────────

/**
 * Heuristic: treat a file as binary if it contains a NUL byte in the first
 * 8 KB. This matches git's own binary detection heuristic and avoids feeding
 * compiled artifacts or images to the text scanner.
 */
function isBinaryContent(buf: Buffer): boolean {
  const checkLen = Math.min(buf.length, 8192);
  for (let i = 0; i < checkLen; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

// ── Core scan ─────────────────────────────────────────────

export function runSuppressionsScan(
  projectRoot: string,
  gitTrackedFiles: string[],
  knownAspectIds: Set<string>,
): SuppressionsReport {
  const fileEntries: FileMarkers[] = [];
  const warnings: string[] = [];
  let totalMarkers = 0;

  // Track unbounded disable markers per file (for open-range detection)
  // Map<file, Map<aspectId, disableLineNum[]>>
  const openDisables = new Map<string, Map<string, number[]>>();

  for (const relFile of gitTrackedFiles) {
    const absFile = path.join(projectRoot, relFile);
    if (!existsSync(absFile)) continue;

    let buf: Buffer;
    try {
      buf = readFileSync(absFile);
    } catch (error) {
      debugWrite(`[suppressions] read fallback: ${relFile}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }

    if (isBinaryContent(buf)) continue;

    const text = buf.toString('utf-8');
    const markers = scanSuppressionMarkers(text);
    if (markers.length === 0) continue;

    fileEntries.push({ file: toPosixPath(relFile), markers });
    totalMarkers += markers.length;

    // Collect disable/enable pairs to detect unbounded ranges
    const disableStack = new Map<string, number[]>();
    for (const m of markers) {
      if (m.kind === 'disable') {
        const stack = disableStack.get(m.aspectId) ?? [];
        stack.push(m.line);
        disableStack.set(m.aspectId, stack);
      } else if (m.kind === 'enable') {
        const stack = disableStack.get(m.aspectId);
        if (stack && stack.length > 0) {
          stack.pop();
          if (stack.length === 0) disableStack.delete(m.aspectId);
        }
      }
    }
    // Any aspects still in disableStack have unbounded ranges
    if (disableStack.size > 0) {
      openDisables.set(toPosixPath(relFile), disableStack);
    }
  }

  // ── Generate warnings ──────────────────────────────────

  // Collect all unique (file, aspectId) combos for cross-checks
  const seenWildcard = new Set<string>(); // "file:line"

  for (const { file, markers } of fileEntries) {
    for (const m of markers) {
      // (a) Unknown aspect id — wildcard '*' is exempt
      if (!m.wildcard && !knownAspectIds.has(m.aspectId)) {
        const msg = buildIssueMessage({
          what: `Unknown aspect id "${m.aspectId}" in suppress marker at ${file}:${m.line}.`,
          why: 'The aspect does not exist in the graph. The suppression has no effect and likely refers to a renamed or deleted aspect.',
          next: `Run \`yg aspects\` to list defined aspect ids, then update or remove this marker.`,
        });
        warnings.push(msg);
      }

      // (b) Wildcard '*' usage
      if (m.wildcard && !seenWildcard.has(`${file}:${m.line}`)) {
        seenWildcard.add(`${file}:${m.line}`);
        const msg = buildIssueMessage({
          what: `Wildcard suppression "*" at ${file}:${m.line} silences ALL aspects.`,
          why: 'A wildcard suppresses every current and future aspect check on the affected code — including ones not yet written. This masks problems broadly and is hard to audit.',
          next: `Replace "*" with the specific aspect id(s) you intend to suppress.`,
        });
        warnings.push(msg);
      }
    }
  }

  // (c) Unbounded disable (no matching enable in same file)
  for (const [file, disableMap] of openDisables) {
    for (const [aspectId, lines] of disableMap) {
      for (const lineNum of lines) {
        const msg = buildIssueMessage({
          what: `Unbounded yg-suppress-disable("${aspectId}") at ${file}:${lineNum} has no matching yg-suppress-enable.`,
          why: 'Without a closing enable marker the suppression covers the rest of the file, which is almost always broader than intended and hides future violations added below this line.',
          next: `Add \`yg-suppress-enable(${aspectId})\` at the end of the suppressed block, or convert to a single-line \`yg-suppress(${aspectId}) <reason>\` if only one line needs suppression.`,
        });
        warnings.push(msg);
      }
    }
  }

  return { fileEntries, totalMarkers, warnings };
}

// ── Output formatting ─────────────────────────────────────

export function formatSuppressionsOutput(report: SuppressionsReport): string {
  const lines: string[] = [];

  if (report.fileEntries.length === 0) {
    lines.push('No active suppression markers found.');
    return lines.join('\n') + '\n';
  }

  // Inventory section
  lines.push('Active suppression markers:');
  lines.push('');

  for (const { file, markers } of report.fileEntries) {
    lines.push(`  ${file}`);
    for (const m of markers) {
      const wildcardTag = m.wildcard ? chalk.yellow(' [wildcard]') : '';
      const kindTag = m.kind === 'single' ? 'single' : m.kind === 'disable' ? 'disable' : 'enable';
      const reasonPart = m.reason ? `  — ${m.reason}` : '';
      lines.push(`    line ${m.line}: ${kindTag}(${m.aspectId})${wildcardTag}${reasonPart}`);
    }
    lines.push('');
  }

  // Tally
  const fileCount = report.fileEntries.length;
  lines.push(`Total: ${report.totalMarkers} marker${report.totalMarkers === 1 ? '' : 's'} across ${fileCount} file${fileCount === 1 ? '' : 's'}.`);

  // Warnings
  if (report.warnings.length > 0) {
    lines.push('');
    lines.push(chalk.yellow(`Warnings (${report.warnings.length}):`));
    for (const w of report.warnings) {
      // Indent each line of the warning message
      const indented = w.split('\n').map(l => `  ${l}`).join('\n');
      lines.push(chalk.yellow(indented));
    }
  }

  return lines.join('\n') + '\n';
}

// ── Command registration ───────────────────────────────────

export function registerSuppressionsCommand(program: Command): void {
  program
    .command('suppressions')
    .description('Inventory active yg-suppress waivers and warn about footguns')
    .action(async () => {
      try {
        const cwd = process.cwd();
        const graph = await loadGraphOrAbort(cwd);
        initDebugLog(graph.rootPath, graph.config.debug ?? false, appendToDebugLog);

        const projectRoot = path.dirname(graph.rootPath);

        // Get git-tracked files (same pattern as yg check)
        let gitFiles: string[] = [];
        try {
          const output = execFileSync('git', ['ls-files', '.'], {
            cwd: projectRoot,
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'],
          });
          gitFiles = output.trim().split('\n').filter(f => f.length > 0);
        } catch (error) {
          // Not a git repo or git unavailable — proceed with empty list
          debugWrite(`[suppressions] git ls-files fallback: ${error instanceof Error ? error.message : String(error)}`);
        }

        const knownAspectIds = new Set(graph.aspects.map(a => a.id));
        const report = runSuppressionsScan(projectRoot, gitFiles, knownAspectIds);
        process.stdout.write(formatSuppressionsOutput(report));
        // Always exit 0 — this is a purely informational command
      } catch (error) {
        abortOnUnexpectedError(error, 'scanning suppressions');
      }
    });
}
