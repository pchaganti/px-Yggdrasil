import type { Command } from 'commander';
import { logAddCommand } from './log-add.js';
import { logReadCommand } from './log-read.js';
import { logMergeResolveCommand } from './log-merge-resolve.js';

export function registerLogCommand(program: Command): void {
  const log = program
    .command('log')
    .description('Per-node business log (append-only history of decisions and reasoning)');

  log
    .command('add')
    .description('Append a log entry to a node')
    .requiredOption('--node <path>', 'Node path (relative to .yggdrasil/model/, no model/ prefix)')
    .option('--reason <text>', 'Justification text (one of --reason or --reason-file required)')
    .option('--reason-file <path>', 'Read justification from a file (alternative to --reason)')
    .action((opts: { node: string; reason?: string; reasonFile?: string }) =>
      logAddCommand({ node: opts.node, reason: opts.reason, reasonFile: opts.reasonFile }),
    );

  log
    .command('read')
    .description('Print log entries newest-first (default: top 10)')
    .requiredOption('--node <path>', 'Node path (relative to .yggdrasil/model/)')
    .option('--top <n>', 'Limit to N newest entries (default 10)', (v) => parseInt(v, 10))
    .option('--all', 'Return all entries (cannot combine with --top)')
    .action((opts: { node: string; top?: number; all?: boolean }) => logReadCommand(opts));

  log
    .command('merge-resolve')
    .description('Reconcile log.md after a git merge (HEAD must be a merge commit)')
    .requiredOption('--node <path>', 'Node path (relative to .yggdrasil/model/)')
    .action((opts: { node: string }) => logMergeResolveCommand(opts));
}
