import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import chalk from 'chalk';
import { loadGraph } from '../core/graph-loader.js';
import { validateNodePath } from '../utils/node-path-validator.js';
import { buildIssueMessage } from '../formatters/message-builder.js';
import { parseLog } from '../io/log-parser.js';
import {
  isMergeCommit,
  getMergeParents,
  getMergeBase,
  getFileAtRef,
} from '../utils/git-introspect.js';
import { readNodeDriftState, writeNodeDriftState } from '../io/drift-state-store.js';
import type { DriftNodeState } from '../model/drift.js';

export interface LogMergeResolveOptions {
  node: string;
}

export async function logMergeResolveCommand(
  options: LogMergeResolveOptions,
  cwd: string = process.cwd(),
): Promise<void> {
  try {
    const graph = await loadGraph(cwd, { tolerateInvalidConfig: true });
    const yggRoot = graph.rootPath;
    const repoRoot = path.dirname(yggRoot);

    const nv = validateNodePath(options.node.trim().replace(/\/$/, ''));
    if (!nv.ok) {
      process.stderr.write(
        chalk.red(
          buildIssueMessage({
            what: `Invalid --node value: ${nv.reason}`,
            why: 'Node path must be POSIX-relative to .yggdrasil/model/ without .. or absolute prefixes.',
            next: 'Use a path like billing/cancel (no leading slash, no model/ prefix).',
          }),
        ) + '\n',
      );
      process.exit(1);
    }
    const nodePath = nv.normalized;

    if (!graph.nodes.has(nodePath)) {
      process.stderr.write(
        chalk.red(
          buildIssueMessage({
            what: `Node not found: ${nodePath}`,
            why: 'Node must exist in the graph before its log can be merge-resolved.',
            next: 'Check the --node argument, or create the node first.',
          }),
        ) + '\n',
      );
      process.exit(1);
    }

    if (!(await isMergeCommit(repoRoot, 'HEAD'))) {
      process.stderr.write(
        chalk.red(
          buildIssueMessage({
            what: 'HEAD is not a merge commit',
            why: 'yg log merge-resolve must run on a merge commit to verify log integrity across branches.',
            next: 'Run this command only after completing a merge (git merge --no-ff).',
          }),
        ) + '\n',
      );
      process.exit(1);
    }

    const logPath = path.join(yggRoot, 'model', nodePath, 'log.md');
    const currentLog = await readFile(logPath, 'utf-8');

    if (/^(<{7}|={7}|>{7})/m.test(currentLog)) {
      process.stderr.write(
        chalk.red(
          buildIssueMessage({
            what: 'log.md still contains conflict markers',
            why: 'Conflict markers indicate the merge conflict was not fully resolved.',
            next: 'Resolve all conflicts in log.md, then run yg log merge-resolve again.',
          }),
        ) + '\n',
      );
      process.exit(1);
    }

    const [parent1, parent2] = await getMergeParents(repoRoot, 'HEAD');
    const ancestorSha = await getMergeBase(repoRoot, parent1, parent2);
    const gitLogPath = `.yggdrasil/model/${nodePath}/log.md`;
    const ancestorLog = await getFileAtRef(repoRoot, ancestorSha, gitLogPath);
    const parent1Log = await getFileAtRef(repoRoot, parent1, gitLogPath);
    const parent2Log = await getFileAtRef(repoRoot, parent2, gitLogPath);

    const ancestorBytes = Buffer.from(ancestorLog, 'utf-8');
    const currentBytes = Buffer.from(currentLog, 'utf-8');
    if (
      currentBytes.length < ancestorBytes.length ||
      !currentBytes.subarray(0, ancestorBytes.length).equals(ancestorBytes)
    ) {
      process.stderr.write(
        chalk.red(
          buildIssueMessage({
            what: 'log.md ancestor prefix does not match merge base',
            why: 'The shared history portion of the log must be preserved byte-for-byte during merge resolution.',
            next: 'Restore the ancestor entries at the start of log.md without modification.',
          }),
        ) + '\n',
      );
      process.exit(1);
    }

    const ancestorEntries = parseLog(ancestorLog);
    const p1New = parseLog(parent1Log).slice(ancestorEntries.length);
    const p2New = parseLog(parent2Log).slice(ancestorEntries.length);
    const currentEntries = parseLog(currentLog);
    const currentNew = currentEntries.slice(ancestorEntries.length);

    const currentNewDatetimes = new Set(currentNew.map(e => e.datetime));
    const missing = [...p1New, ...p2New].filter(e => !currentNewDatetimes.has(e.datetime));
    if (missing.length > 0) {
      process.stderr.write(
        chalk.red(
          buildIssueMessage({
            what: `log.md is missing ${missing.length} entr${missing.length === 1 ? 'y' : 'ies'} from merge parents`,
            why: 'All new log entries from both branches must be preserved in the merge result.',
            next: `Add the missing entries: ${missing.map(e => e.datetime).join(', ')}`,
          }),
        ) + '\n',
      );
      process.exit(1);
    }

    for (let i = 1; i < currentNew.length; i++) {
      if (currentNew[i].datetime <= currentNew[i - 1].datetime) {
        process.stderr.write(
          chalk.red(
            buildIssueMessage({
              what: 'New log entries are not in chronological order',
              why: 'Log entries must be ordered by timestamp to maintain a consistent history.',
              next: 'Sort the new entries by datetime (oldest first) after the ancestor entries.',
            }),
          ) + '\n',
        );
        process.exit(1);
      }
    }

    const stored = await readNodeDriftState(yggRoot, nodePath);
    const lastEntry = currentEntries.at(-1);
    const newLogBaseline = {
      last_entry_datetime: lastEntry?.datetime ?? '',
      prefix_hash: createHash('sha256').update(currentBytes).digest('hex'),
    };
    const newState: DriftNodeState = stored
      ? { ...stored, log: newLogBaseline }
      : { hash: '', files: {}, log: newLogBaseline };
    await writeNodeDriftState(yggRoot, nodePath, newState);

    process.stdout.write(
      chalk.green(
        `Merge-resolve verified for .yggdrasil/model/${nodePath}/log.md\nLog baseline updated.\n`,
      ),
    );
  } catch (error) {
    const msg = (error as Error).message;
    if (msg.includes('No .yggdrasil/ directory found') || msg.includes('does not exist')) {
      process.stderr.write(`Error: No .yggdrasil/ directory found. Run 'yg init' first.\n`);
    } else {
      process.stderr.write(`Error: ${msg}\n`);
    }
    process.exit(1);
  }
}
