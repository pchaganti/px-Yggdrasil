import { readFile } from 'node:fs/promises';
import path from 'node:path';
import chalk from 'chalk';
import { loadGraph } from '../core/graph-loader.js';
import { validateNodePath } from '../utils/node-path-validator.js';
import { buildIssueMessage } from '../formatters/message-builder.js';
import { parseLog } from '../core/parsing/log-parser.js';
import { validateFormat } from '../core/log-format.js';

export interface LogReadOptions {
  node: string;
  top?: number;
  all?: boolean;
}

const DEFAULT_TOP = 10;

export async function logReadCommand(
  options: LogReadOptions,
  cwd: string = process.cwd(),
): Promise<void> {
  try {
    const graph = await loadGraph(cwd, { tolerateInvalidConfig: true });
    const yggRoot = graph.rootPath;

    if (options.top !== undefined && options.all === true) {
      process.stderr.write(
        chalk.red(
          buildIssueMessage({
            what: 'Cannot combine --top with --all',
            why: '--all overrides --top; provide one or the other.',
            next: 'Drop one of the flags and retry.',
          }),
        ) + '\n',
      );
      process.exit(1);
    }
    if (options.top !== undefined && (!Number.isInteger(options.top) || options.top <= 0)) {
      process.stderr.write(
        chalk.red(
          buildIssueMessage({
            what: `Invalid --top value: ${options.top}`,
            why: '--top must be a positive integer.',
            next: 'Use --top 10 or --all.',
          }),
        ) + '\n',
      );
      process.exit(1);
    }

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
            why: 'Node must exist in the graph before its log can be read.',
            next: 'Check the --node argument, or create the node first.',
          }),
        ) + '\n',
      );
      process.exit(1);
    }

    const logPath = path.join(yggRoot, 'model', nodePath, 'log.md');
    let content = '';
    try {
      content = await readFile(logPath, 'utf-8');
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== 'ENOENT') throw err;
    }

    if (content === '') {
      process.stdout.write('No log entries.\n');
      return;
    }

    const violations = validateFormat(content);
    if (violations.length > 0) {
      for (const v of violations) {
        process.stderr.write(
          chalk.red(
            buildIssueMessage({
              what: `log.md format violation at line ${v.line}: ${v.reason}`,
              why: v.detail,
              next: `Fix log.md for node ${nodePath} and retry.`,
            }),
          ) + '\n',
        );
      }
      process.exit(1);
    }

    const entries = parseLog(content);
    const limit = options.all ? entries.length : (options.top ?? DEFAULT_TOP);
    const selected = entries.slice(-limit).reverse();

    for (const entry of selected) {
      process.stdout.write(`## [${entry.datetime}]\n${entry.body}`);
    }
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
