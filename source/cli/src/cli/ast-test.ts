import { Command } from 'commander';
import path from 'node:path';
import { loadGraph } from '../core/graph-loader.js';
import { runAstAspect, AstRunnerError, SuppressMarkerError } from '../ast/runner.js';
import { buildIssueMessage } from '../formatters/message-builder.js';
import { normalizeMappingPaths } from '../utils/paths.js';
import { expandMappingPaths } from '../utils/hash.js';
import type { Violation } from '../ast/types.js';

export function registerAstTestCommand(program: Command): void {
  program
    .command('ast-test')
    .description('Run an AST aspect check against ad-hoc files (no graph attachment, no baseline)')
    .requiredOption('--aspect <id>', 'aspect id to run')
    .option('--files <paths...>', 'source files to check')
    .option('--node <path>', "use the node's mapping as the file list")
    .action(async (opts) => {
      const projectRoot = process.cwd();
      let graph;
      try {
        graph = await loadGraph(projectRoot);
      } catch (e: any) {
        process.stderr.write(
          buildIssueMessage({
            what: `Failed to load graph.`,
            why: e.message,
            next: `Run 'yg init' if .yggdrasil/ does not exist.`,
          }) + '\n',
        );
        process.exit(2);
        return;
      }

      const aspect = graph.aspects.find((a) => a.id === opts.aspect);
      if (!aspect) {
        process.stderr.write(
          buildIssueMessage({
            what: `Aspect '${opts.aspect}' not found.`,
            why: `yg ast-test requires an aspect declared in .yggdrasil/aspects/.`,
            next: `Run 'yg aspects' to list available aspects, or check the spelling of '${opts.aspect}'.`,
          }) + '\n',
        );
        process.exit(2);
        return;
      }

      if (aspect.reviewer !== 'ast') {
        process.stderr.write(
          buildIssueMessage({
            what: `Aspect '${opts.aspect}' has reviewer '${aspect.reviewer ?? 'llm'}', not 'ast'.`,
            why: `yg ast-test only runs AST aspects (those with check.mjs).`,
            next: `Pick an aspect with 'reviewer: ast' in yg-aspect.yaml, or run yg approve for LLM aspects.`,
          }) + '\n',
        );
        process.exit(2);
        return;
      }

      let filePaths: string[];
      if (opts.files) {
        filePaths = opts.files as string[];
      } else if (opts.node) {
        const node = graph.nodes.get(opts.node as string);
        if (!node) {
          process.stderr.write(
            buildIssueMessage({
              what: `Node '${opts.node}' not found.`,
              why: `--node alias requires an existing node path in the graph.`,
              next: `Run 'yg tree' to list nodes.`,
            }) + '\n',
          );
          process.exit(2);
          return;
        }
        const mappingPaths = normalizeMappingPaths(node.meta.mapping);
        filePaths = await expandMappingPaths(projectRoot, mappingPaths);
      } else {
        process.stderr.write(
          buildIssueMessage({
            what: `Neither --files nor --node was provided.`,
            why: `yg ast-test needs to know which source files to run check.mjs against.`,
            next: `Pass --files <path...> for ad-hoc files, or --node <node-path> to use the node's mapping.`,
          }) + '\n',
        );
        process.exit(2);
        return;
      }

      const aspectDir = path.join('.yggdrasil', 'aspects', aspect.id);
      try {
        const result = await runAstAspect({
          aspectDir,
          aspectId: aspect.id,
          files: filePaths.map((f) => ({ path: f })),
          projectRoot,
        });

        if (result.violations.length === 0) {
          process.stdout.write('No violations.\n');
          process.exit(0);
          return;
        }

        printViolations(result.violations);
        process.exit(1);
      } catch (e: any) {
        if (e instanceof AstRunnerError || e instanceof SuppressMarkerError) {
          process.stderr.write(e.message + '\n');
        } else {
          process.stderr.write(
            buildIssueMessage({
              what: `Unexpected error running AST check for aspect '${aspect.id}'.`,
              why: e.message,
              next: `Check the check.mjs file for syntax errors.`,
            }) + '\n',
          );
        }
        process.exit(2);
      }
    });
}

function printViolations(violations: Violation[]): void {
  const byFile = new Map<string, Violation[]>();
  for (const v of violations) {
    if (!byFile.has(v.file)) byFile.set(v.file, []);
    byFile.get(v.file)!.push(v);
  }
  const entries = [...byFile.entries()].sort(([a], [b]) => a.localeCompare(b));
  for (const [file, vs] of entries) {
    process.stdout.write(file + '\n');
    for (const v of vs.sort((a, b) => a.line - b.line)) {
      process.stdout.write(`  L${v.line}: ${v.message}\n`);
    }
  }
}
