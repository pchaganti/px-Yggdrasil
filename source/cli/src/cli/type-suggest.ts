import { Command } from 'commander';
import chalk from 'chalk';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadGraph } from '../core/graph-loader.js';
import { classifyFile } from '../core/type-classifier.js';
import { FileContentCache } from '../core/file-content-cache.js';
import { renderTrace } from '../formatters/predicate-trace.js';
import { loadRootGitignoreStack, isIgnoredByStack } from '../utils/repo-scan.js';
import { projectRootFromGraph, resolveFileArg } from '../utils/paths.js';

/**
 * Core logic for `yg type-suggest --file <path>`.
 * Exported for testability.
 */
export async function typeSuggestCommand(file: string, projectRoot: string): Promise<void> {
  const graph = await loadGraph(projectRoot, { tolerateInvalidConfig: true });
  const repoRoot = projectRootFromGraph(graph.rootPath);
  const repoRelPath = resolveFileArg(repoRoot, file.trim()).replace(/\/+$/, '');
  const absPath = resolve(repoRoot, repoRelPath);
  const cache = new FileContentCache();

  if (repoRelPath.startsWith('.yggdrasil/')) {
    process.stdout.write(
      `\nThis path is inside .yggdrasil/ — auto-exempt from classification.\n` +
        `Type matching does not apply here.\n\n`,
    );
    return;
  }

  const gitignoreStack = await loadRootGitignoreStack(projectRoot);
  if (existsSync(absPath) && isIgnoredByStack(absPath, gitignoreStack)) {
    process.stderr.write(
      chalk.yellow(
        `\nWarning: '${repoRelPath}' is matched by .gitignore.\n` +
          `Classification will run, but a node mapping this file would fire\n` +
          `file-mapping-gitignored. Proceeding with classification for context.\n\n`,
      ),
    );
  }

  if (!existsSync(absPath)) {
    process.stdout.write(`\n(File does not exist — evaluating path predicates only)\n\n`);
    const result = await classifyFile(absPath, repoRelPath, graph, cache);
    if (result.matches.length > 0) {
      process.stdout.write(`Matching types (path-only check):\n`);
      for (const m of result.matches) {
        process.stdout.write(`  ${chalk.dim('?')} ${m.typeId}\n`);
        const traced = renderTrace(m.trace, '      ');
        if (traced) process.stdout.write(traced + '\n');
      }
    } else {
      process.stdout.write(`No type's path predicate matches this file path.\n`);
    }
    process.stdout.write(
      `\nNEXT\n  Create the file, then re-run yg type-suggest for full validation.\n\n`,
    );
    return;
  }

  const result = await classifyFile(absPath, repoRelPath, graph, cache);

  if (result.matches.length === 0) {
    process.stdout.write(`\nNo type's \`when\` matches this file.\n\n`);
    if (result.closest.length > 0) {
      process.stdout.write(`Closest types (top 3, ranked by satisfied-fraction):\n`);
      for (const c of result.closest) {
        process.stdout.write(
          `  ${c.typeId} — predicate evaluates to false (score: ${c.score.toFixed(2)})\n`,
        );
        const traced = renderTrace(c.trace, '      ');
        if (traced) process.stdout.write(traced + '\n');
      }
    }
    process.stdout.write(
      `\nNEXT\n  Three options:\n` +
        `  1. Move file under a path matching an existing type's when\n` +
        `  2. Refactor file to satisfy a type's content predicate\n` +
        `  3. Add a new type to yg-architecture.yaml that fits this file\n\n`,
    );
    return;
  }

  if (result.matches.length === 1) {
    process.stdout.write(`\nMatching types:\n`);
    process.stdout.write(`  ${chalk.green('✓')} ${result.matches[0].typeId}\n`);
    const traced = renderTrace(result.matches[0].trace, '      ');
    if (traced) process.stdout.write(traced + '\n');
    process.stdout.write('\n');
    return;
  }

  process.stdout.write(`\nMultiple types match:\n`);
  for (const m of result.matches) {
    process.stdout.write(`  ${chalk.green('✓')} ${m.typeId} — full when satisfied\n`);
  }
  process.stdout.write(
    `\nNEXT\n  Architecture has overlapping when between types.\n` +
      `  Check each type's description and aspects in yg-architecture.yaml.\n\n`,
  );
}

export function registerTypeSuggestCommand(program: Command): void {
  program
    .command('type-suggest')
    .description('Suggest which node_type a file fits, based on architecture `when` predicates')
    .requiredOption('--file <path>', 'File path (relative to repo or absolute)')
    .action(async (options: { file: string }) => {
      try {
        await typeSuggestCommand(options.file, process.cwd());
      } catch (error) {
        const msg = (error as Error).message;
        if (msg.includes('No .yggdrasil/ directory found') || msg.includes('does not exist')) {
          process.stderr.write(
            chalk.red(`Error: No .yggdrasil/ directory found. Run 'yg init' first.\n`),
          );
        } else {
          process.stderr.write(chalk.red(`Error: ${msg}\n`));
        }
        process.exit(1);
      }
    });
}
