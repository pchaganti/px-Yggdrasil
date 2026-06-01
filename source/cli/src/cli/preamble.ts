import chalk from 'chalk';
import { buildIssueMessage } from '../formatters/message-builder.js';
import { loadGraph, UnsupportedSchemaVersionError, OutdatedSchemaVersionError } from '../core/graph-loader.js';
import { OutdatedDriftBaselineError, CorruptDriftBaselineError } from '../io/drift-state-store.js';
import type { Graph } from '../model/graph.js';

/**
 * Format and emit an unexpected error from a generic catch block, then
 * process.exit(1). Used as the fallback path after specific error
 * classifications have failed. The `context` string describes what was
 * being attempted, so the message reads "Unexpected error while <context>".
 */
export function abortOnUnexpectedError(error: unknown, context: string): never {
  // Recoverable drift-state errors are an expected STATE problem (corrupt or
  // outdated baseline), not an unclassified CLI bug. They already carry a
  // fully-formed what/why/next message with concrete recovery steps — render
  // it directly instead of wrapping it as "Unexpected error ... file an issue".
  if (error instanceof OutdatedDriftBaselineError || error instanceof CorruptDriftBaselineError) {
    process.stderr.write(chalk.red(`Error: ${error.message}\n`));
    process.exit(1);
  }
  const message = error instanceof Error ? error.message : String(error);
  const formatted = buildIssueMessage({
    what: `Unexpected error while ${context}: ${message}`,
    why: 'The CLI encountered an error it does not classify.',
    next: 'This is a bug — please file an issue with the command you ran and the full error output.',
  });
  process.stderr.write(chalk.red(`Error: ${formatted}\n`));
  process.exit(1);
}

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
    if (err instanceof UnsupportedSchemaVersionError) {
      const formatted = buildIssueMessage({
        what: `Graph schema version ${err.detectedVersion} is newer than this CLI supports (max: ${err.maxSupportedVersion}).`,
        why: 'This CLI cannot safely read a graph written for a newer schema — it may misinterpret or skip fields it does not understand.',
        next: `Upgrade the yg CLI to a version that supports schema ${err.detectedVersion} (e.g. \`npm i -g @chrisdudek/yg\`), then re-run this command.`,
      });
      process.stderr.write(chalk.red(`Error: ${formatted}\n`));
      process.exit(1);
    }
    if (err instanceof OutdatedSchemaVersionError) {
      const formatted = buildIssueMessage({
        what: `the .yggdrasil graph is at version ${err.detectedVersion}, older than this CLI (${err.minSupportedVersion}).`,
        why: `${err.minSupportedVersion} reads only the current on-disk format; older formats are upgraded by a migration, not parsed directly.`,
        next: `run \`yg init --upgrade\` to migrate the graph to ${err.minSupportedVersion}, then re-run.`,
      });
      process.stderr.write(chalk.red(`Error: ${formatted}\n`));
      process.exit(1);
    }
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
