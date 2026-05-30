import { Command } from 'commander';
import path from 'node:path';
import { loadGraphOrAbort, abortOnUnexpectedError } from '../formatters/cli-preamble.js';
import { debugWrite } from '../utils/debug-log.js';
import { runAstAspect } from '../ast/runner.js';
import { runStructureAspect } from '../structure/runner.js';
import { buildIssueMessage } from '../formatters/message-builder.js';
import type { Violation } from '../ast/types.js';
import type { Violation as StructureViolation } from '../structure/types.js';

export function registerAstTestCommand(program: Command): void {
  program
    .command('ast-test')
    .description('Run an AST aspect check against ad-hoc files (no graph attachment, no baseline)')
    .requiredOption('--aspect <id>', 'aspect id to run')
    .option('--files <paths...>', 'source files to check')
    .option('--node <path>', "use the node's mapping as the file list")
    .action(async (opts) => {
      const projectRoot = process.cwd();
      try {
        const graph = await loadGraphOrAbort(projectRoot);

        const aspect = graph.aspects.find((a) => a.id === opts.aspect);
        if (!aspect) {
          process.stderr.write(
            buildIssueMessage({
              what: `Aspect '${opts.aspect}' not found.`,
              why: `yg ast-test requires an aspect declared in .yggdrasil/aspects/.`,
              next: `Run 'yg aspects' to list available aspects, or check the spelling of '${opts.aspect}'.`,
            }) + '\n',
          );
          process.exit(1);
          return;
        }

        if (aspect.reviewer.type !== 'deterministic') {
          process.stderr.write(
            buildIssueMessage({
              what: `Aspect '${opts.aspect}' has reviewer '${aspect.reviewer.type}', not 'deterministic'.`,
              why: `yg ast-test only runs deterministic aspects (those with check.mjs).`,
              next: `Pick an aspect with 'reviewer: deterministic' in yg-aspect.yaml, or run yg approve for LLM aspects.`,
            }) + '\n',
          );
          process.exit(1);
          return;
        }

        const aspectDir = path.join('.yggdrasil', 'aspects', aspect.id);

        // --node: route through the structure runner so the node-scoped preview
        // matches real approve (which is always node-scoped). The structure
        // runner resolves the node's own mapping and graph-aware ctx itself.
        if (opts.node) {
          const nodePath = (opts.node as string).trim().replace(/\/$/, '');
          const node = graph.nodes.get(nodePath);
          if (!node) {
            process.stderr.write(
              buildIssueMessage({
                what: `Node '${nodePath}' not found.`,
                why: `--node alias requires an existing node path in the graph.`,
                next: `Run 'yg tree' to list nodes.`,
              }) + '\n',
            );
            process.exit(1);
            return;
          }
          const structResult = await runStructureAspect({
            aspectDir,
            aspectId: aspect.id,
            nodePath,
            graph,
            projectRoot,
          });
          if (structResult.violations.length === 0) {
            process.stdout.write('No violations.\n');
            return;
          }
          printStructureViolations(structResult.violations);
          process.exit(1);
          return;
        }

        // --files: ad-hoc mode has no node and thus no approve equivalent; it
        // stays on the AST runner.
        if (!opts.files) {
          process.stderr.write(
            buildIssueMessage({
              what: `Neither --files nor --node was provided.`,
              why: `yg ast-test needs to know which source files to run check.mjs against.`,
              next: `Pass --files <path...> for ad-hoc files, or --node <node-path> to use the node's mapping.`,
            }) + '\n',
          );
          process.exit(1);
          return;
        }

        const filePaths = opts.files as string[];
        const result = await runAstAspect({
          aspectDir,
          aspectId: aspect.id,
          files: filePaths.map((f) => ({ path: f })),
          projectRoot,
        });

        if (result.violations.length === 0) {
          process.stdout.write('No violations.\n');
          return;
        }

        printViolations(result.violations);
        process.exit(1);
      } catch (e: unknown) {
        debugWrite(`[ast-test] run failed: ${e instanceof Error ? e.message : String(e)}`);
        abortOnUnexpectedError(e, 'running ast-test');
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

// Structure violations carry optional file/line (graph-level violations have
// neither), so they are rendered separately from AST violations.
function printStructureViolations(violations: StructureViolation[]): void {
  const withFile: StructureViolation[] = [];
  const withoutFile: StructureViolation[] = [];
  for (const v of violations) {
    if (typeof v.file === 'string') withFile.push(v);
    else withoutFile.push(v);
  }
  for (const v of withoutFile) {
    process.stdout.write(`<graph>: ${v.message}\n`);
  }
  const byFile = new Map<string, StructureViolation[]>();
  for (const v of withFile) {
    if (!byFile.has(v.file!)) byFile.set(v.file!, []);
    byFile.get(v.file!)!.push(v);
  }
  const entries = [...byFile.entries()].sort(([a], [b]) => a.localeCompare(b));
  for (const [file, vs] of entries) {
    process.stdout.write(file + '\n');
    for (const v of vs.sort((a, b) => (a.line ?? 0) - (b.line ?? 0))) {
      process.stdout.write(`  L${v.line ?? '?'}: ${v.message}\n`);
    }
  }
}
