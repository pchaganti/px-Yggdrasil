import { readFile, lstat, stat } from 'node:fs/promises';
import path from 'node:path';
import chalk from 'chalk';
import { loadGraph } from '../core/graph-loader.js';
import { validateNodePath } from '../utils/node-path-validator.js';
import { atomicWriteFile } from '../utils/atomic-write.js';
import { buildIssueMessage } from '../formatters/message-builder.js';
import { parseLog } from '../io/log-parser.js';

export interface LogAddOptions {
  node: string;
  reason?: string;
  reasonFile?: string;
}

export async function logAddCommand(
  options: LogAddOptions,
  cwd: string = process.cwd(),
): Promise<void> {
  try {
    const graph = await loadGraph(cwd, { tolerateInvalidConfig: true });
    const yggRoot = graph.rootPath;

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
            why: 'Node must exist in the graph before log entries can be added.',
            next: 'Create yg-node.yaml first, or fix the --node argument.',
          }),
        ) + '\n',
      );
      process.exit(1);
    }

    if ((options.reason !== undefined) === (options.reasonFile !== undefined)) {
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
    if (options.reasonFile !== undefined) {
      try {
        const s = await stat(options.reasonFile);
        if (!s.isFile()) {
          process.stderr.write(
            chalk.red(
              buildIssueMessage({
                what: `--reason-file is not a regular file: ${options.reasonFile}`,
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
          process.stderr.write(
            chalk.red(
              buildIssueMessage({
                what: `Cannot stat --reason-file: ${e.message}`,
                why: 'File must exist and be accessible.',
                next: `Check path: ${options.reasonFile}`,
              }),
            ) + '\n',
          );
          process.exit(1);
        }
        throw err;
      }
      reasonText = await readFile(options.reasonFile, 'utf-8');
    } else {
      reasonText = options.reason!;
    }

    const trimmed = reasonText.trim();
    if (trimmed === '') {
      process.stderr.write(
        chalk.red(
          buildIssueMessage({
            what: 'Reason cannot be empty after trim',
            why: 'A log entry must carry justification text.',
            next: 'Provide --reason "<non-empty text>" or a non-empty --reason-file.',
          }),
        ) + '\n',
      );
      process.exit(1);
    }

    if (reasonHasLevel2HeaderOutsideFence(reasonText)) {
      process.stderr.write(
        chalk.red(
          buildIssueMessage({
            what: 'Reason contains `## ` (level-2 header) outside a code fence',
            why: 'Level-2 headers are reserved for entry headers and would corrupt log structure.',
            next: 'Use ### or deeper for sub-headings, or wrap in ``` fences.',
          }),
        ) + '\n',
      );
      process.exit(1);
    }

    const logPath = path.join(yggRoot, 'model', nodePath, 'log.md');
    let existing = '';
    try {
      const st = await lstat(logPath);
      if (st.isSymbolicLink()) {
        process.stderr.write(
          chalk.red(
            buildIssueMessage({
              what: 'log.md is a symbolic link',
              why: 'Symlinks bypass append-only guarantees and break integrity hashing.',
              next: 'Remove the symlink and let yg log add create a regular file.',
            }),
          ) + '\n',
        );
        process.exit(1);
      }
      if (st.nlink > 1) {
        process.stderr.write(
          chalk.red(
            buildIssueMessage({
              what: 'log.md has multiple hard links (st_nlink > 1)',
              why: 'Hardlinks would orphan integrity baselines on atomic rename.',
              next: 'Copy to a unique file and replace the hardlink.',
            }),
          ) + '\n',
        );
        process.exit(1);
      }
      existing = await readFile(logPath, 'utf-8');
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== 'ENOENT') throw err;
    }

    const lastEntry = lastEntryDatetime(existing);
    const datetime = monotonicNow(lastEntry);

    const body = reasonText.endsWith('\n') ? reasonText : reasonText + '\n';
    const entry = `## [${datetime}]\n${body}`;
    const newContent =
      existing === ''
        ? entry
        : `${existing.endsWith('\n') ? existing : existing + '\n'}${entry}`;

    await atomicWriteFile(logPath, newContent);

    process.stdout.write(
      chalk.green(`Added log entry to .yggdrasil/model/${nodePath}/log.md\nTimestamp: ${datetime}\n`),
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

function lastEntryDatetime(content: string): string | null {
  const entries = parseLog(content);
  if (entries.length === 0) return null;
  return entries[entries.length - 1].datetime;
}

function monotonicNow(lastEntry: string | null): string {
  let now = Date.now();
  if (lastEntry !== null) {
    const lastMs = Date.parse(lastEntry);
    if (!Number.isNaN(lastMs) && now <= lastMs) {
      now = lastMs + 1;
    }
  }
  return new Date(now).toISOString();
}

function reasonHasLevel2HeaderOutsideFence(reason: string): boolean {
  const lines = reason.split('\n');
  let fenceOpen = false;
  let fenceLen = 0;
  for (const line of lines) {
    const m = /^(`{3,})(.*)$/.exec(line);
    if (fenceOpen) {
      if (m && m[2].trim() === '' && m[1].length >= fenceLen) fenceOpen = false;
      continue;
    }
    if (m) {
      fenceOpen = true;
      fenceLen = m[1].length;
      continue;
    }
    if (line.startsWith('## ')) return true;
  }
  return false;
}
