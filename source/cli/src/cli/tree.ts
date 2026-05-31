import { Command, InvalidArgumentError } from 'commander';
import chalk from 'chalk';
import { loadGraphOrAbort, abortOnUnexpectedError } from './preamble.js';
import { initDebugLog } from '../utils/debug-log.js';
import { appendToDebugLog } from '../io/debug-log-writer.js';
import { buildIssueMessage } from '../formatters/message-builder.js';
import type { GraphNode } from '../model/graph.js';

export function registerTreeCommand(program: Command): void {
  program
    .command('tree')
    .description('Display graph structure as a flat list')
    .option('--root <path>', 'Show only subtree rooted at this path')
    .option('--depth <n>', 'Maximum depth', (v) => {
      const n = parseInt(v, 10);
      if (Number.isNaN(n) || n < 0) {
        throw new InvalidArgumentError('--depth must be a non-negative integer.');
      }
      return n;
    })
    .action(async (options: { root?: string; depth?: number }) => {
      try {
        const graph = await loadGraphOrAbort(process.cwd());
        initDebugLog(graph.rootPath, graph.config.debug ?? false, appendToDebugLog);

        let roots: GraphNode[];

        if (options.root?.trim()) {
          const path = options.root.trim().replace(/\/$/, '');
          const node = graph.nodes.get(path);
          if (!node) {
            process.stderr.write(chalk.red(buildIssueMessage({
              what: `Node '${path}' not found.`,
              why: `The --root path must be a valid node path in the graph.`,
              next: `Run yg tree (no --root) to list all nodes, then pick a valid path.`,
            }) + '\n'));
            process.exit(1);
          }
          roots = [node];
        } else {
          roots = [...graph.nodes.values()]
            .filter((n) => n.parent === null)
            .sort((a, b) => a.path.localeCompare(b.path));
        }

        const lines: string[] = [];
        for (const root of roots) {
          collectNodes(root, lines, 0, options.depth);
        }

        for (const line of lines) {
          process.stdout.write(line + '\n');
        }
      } catch (error) {
        abortOnUnexpectedError(error, 'building the tree');
      }
    });
}

function collectNodes(
  node: GraphNode,
  lines: string[],
  depth: number,
  maxDepth: number | undefined,
): void {
  const desc = node.meta.description?.trim();
  const line = desc
    ? `${node.path} [${node.meta.type}] — ${desc}`
    : `${node.path} [${node.meta.type}]`;
  lines.push(line);

  if (maxDepth !== undefined && depth >= maxDepth) return;

  const children = [...node.children].sort((a, b) => a.path.localeCompare(b.path));
  for (const child of children) {
    collectNodes(child, lines, depth + 1, maxDepth);
  }
}
