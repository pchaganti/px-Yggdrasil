import chalk from 'chalk';
import { buildIssueMessage } from './message-builder.js';
import { loadGraph } from '../core/graph-loader.js';
import type { Graph } from '../model/graph.js';

/**
 * Load the graph from the given root, or print a uniform what/why/next error
 * and exit(1).
 *
 * Centralizes the "No .yggdrasil/ directory found" error that previously
 * appeared inline in every CLI command. On ENOENT-shaped loader failures
 * (root not found, model/ missing) this helper writes a structured message
 * to stderr and calls process.exit(1) — it does not return. Any other error
 * is rethrown so the caller can decide.
 */
export async function loadGraphOrAbort(
  rootPath: string,
  options: { tolerateInvalidConfig?: boolean } = {},
): Promise<Graph> {
  try {
    return await loadGraph(rootPath, options);
  } catch (err) {
    const msg = (err as Error).message ?? '';
    const code = (err as NodeJS.ErrnoException).code;
    if (
      code === 'ENOENT' ||
      msg.includes('No .yggdrasil/ directory found') ||
      msg.includes('does not exist')
    ) {
      const formatted = buildIssueMessage({
        what: 'No .yggdrasil/ directory found in the current project.',
        why: 'Yggdrasil commands require an initialized graph at the project root.',
        next: "Run 'yg init' to bootstrap the graph, then re-run this command.",
      });
      process.stderr.write(chalk.red(`Error: ${formatted}\n`));
      process.exit(1);
    }
    throw err;
  }
}
