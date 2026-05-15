import type { Command } from 'commander';
import chalk from 'chalk';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { loadGraph } from '../core/graph-loader.js';
import { debugWrite } from '../utils/debug-log.js';
import { buildIssueMessage } from '../formatters/message-builder.js';
import { logAdd } from '../core/log/log-add.js';
import { logRead } from '../core/log/log-read.js';
import { logMergeResolve } from '../core/log/log-merge-resolve.js';

function handleError(error: unknown): never {
  const msg = (error as Error).message;
  debugWrite(`[log] command failed: ${msg}`);
  if (msg.includes('No .yggdrasil/ directory found') || msg.includes('does not exist')) {
    process.stderr.write(`Error: No .yggdrasil/ directory found. Run 'yg init' first.\n`);
  } else {
    process.stderr.write(`Error: ${msg}\n`);
  }
  process.exit(1);
}

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
    .action(async (opts: { node: string; reason?: string; reasonFile?: string }) => {
      try {
        const graph = await loadGraph(process.cwd(), { tolerateInvalidConfig: true });

        if ((opts.reason !== undefined) === (opts.reasonFile !== undefined)) {
          process.stderr.write(
            chalk.red(
              buildIssueMessage({
                what: 'Exactly one of --reason or --reason-file is required',
                why: 'Cannot provide both, cannot provide neither.',
                next: 'Pass --reason "<text>" OR --reason-file <path>.',
              }),
            ) + '\n',
          );
          process.exit(1);
        }

        let reasonText: string;
        if (opts.reasonFile !== undefined) {
          try {
            const s = await stat(opts.reasonFile);
            if (!s.isFile()) {
              process.stderr.write(
                chalk.red(
                  buildIssueMessage({
                    what: `--reason-file is not a regular file: ${opts.reasonFile}`,
                    why: 'Directory, device, socket, or named pipe is not a valid source for log entry body.',
                    next: 'Provide a path to a regular text file containing the justification.',
                  }),
                ) + '\n',
              );
              process.exit(1);
            }
          } catch (err) {
            const e = err as NodeJS.ErrnoException;
            if (e.code === 'ENOENT' || !e.code) {
              debugWrite(`[log] reason-file not found: ${e.message}`);
              process.stderr.write(
                chalk.red(
                  buildIssueMessage({
                    what: `Cannot stat --reason-file: ${e.message}`,
                    why: 'File must exist and be accessible.',
                    next: `Check path: ${opts.reasonFile}`,
                  }),
                ) + '\n',
              );
              process.exit(1);
            }
            throw err;
          }
          reasonText = await readFile(opts.reasonFile, 'utf-8');
        } else {
          reasonText = opts.reason!;
        }

        const nodePath = opts.node.trim().replace(/\\/g, '/').replace(/\/$/, '');
        const result = await logAdd({ graph, nodePath, reasonText, nowMs: Date.now() });
        if (!result.ok) {
          process.stderr.write(chalk.red(buildIssueMessage(result.error)) + '\n');
          process.exit(1);
        }
        process.stdout.write(
          chalk.green(
            `Added log entry to .yggdrasil/model/${result.nodePath}/log.md\nTimestamp: ${result.datetime}\n`,
          ),
        );
      } catch (error) {
        handleError(error);
      }
    });

  log
    .command('read')
    .description('Print log entries newest-first (default: top 10)')
    .requiredOption('--node <path>', 'Node path (relative to .yggdrasil/model/)')
    .option('--top <n>', 'Limit to N newest entries (default 10)', (v) => parseInt(v, 10))
    .option('--all', 'Return all entries (cannot combine with --top)')
    .action(async (opts: { node: string; top?: number; all?: boolean }) => {
      try {
        const graph = await loadGraph(process.cwd(), { tolerateInvalidConfig: true });
        const nodePath = opts.node.trim().replace(/\\/g, '/').replace(/\/$/, '');
        const result = await logRead({ graph, nodePath, top: opts.top, all: opts.all });
        if (!result.ok) {
          process.stderr.write(chalk.red(buildIssueMessage(result.error)) + '\n');
          process.exit(1);
        }
        if (result.entries.length === 0) {
          process.stdout.write('No log entries.\n');
          return;
        }
        for (const entry of result.entries) {
          process.stdout.write(`## [${entry.datetime}]\n${entry.body}`);
        }
      } catch (error) {
        handleError(error);
      }
    });

  log
    .command('merge-resolve')
    .description('Reconcile log.md after a git merge (HEAD must be a merge commit)')
    .requiredOption('--node <path>', 'Node path (relative to .yggdrasil/model/)')
    .action(async (opts: { node: string }) => {
      try {
        const graph = await loadGraph(process.cwd(), { tolerateInvalidConfig: true });
        const repoRoot = path.dirname(graph.rootPath);
        const nodePath = opts.node.trim().replace(/\\/g, '/').replace(/\/$/, '');
        const result = await logMergeResolve({ graph, nodePath, repoRoot });
        if (!result.ok) {
          process.stderr.write(chalk.red(buildIssueMessage(result.error)) + '\n');
          process.exit(1);
        }
        process.stdout.write(
          chalk.green(
            `Merge-resolve verified for .yggdrasil/model/${result.nodePath}/log.md\nLog baseline updated.\n`,
          ),
        );
      } catch (error) {
        handleError(error);
      }
    });
}
