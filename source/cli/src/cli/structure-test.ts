import { Command } from 'commander';
import path from 'node:path';
import { loadGraphOrAbort, abortOnUnexpectedError } from '../formatters/cli-preamble.js';
import { debugWrite } from '../utils/debug-log.js';
import { runStructureAspect } from '../structure/runner.js';
import { buildIssueMessage } from '../formatters/message-builder.js';
import type { Violation } from '../structure/types.js';

export function registerStructureTestCommand(program: Command): void {
  program
    .command('structure-test')
    .description('Run a structure aspect check against a graph node (no baseline)')
    .requiredOption('--aspect <id>', 'aspect id to run')
    .requiredOption('--node <path>', 'node path to check')
    .option('--check-determinism', 'run check twice and fail if results differ')
    .action(async (opts) => {
      const projectRoot = process.cwd();
      try {
        const graph = await loadGraphOrAbort(projectRoot);

        const aspect = graph.aspects.find((a) => a.id === opts.aspect);
        if (!aspect) {
          process.stderr.write(
            buildIssueMessage({
              what: `Aspect '${opts.aspect}' not found.`,
              why: `yg structure-test requires an aspect declared in .yggdrasil/aspects/.`,
              next: `Run 'yg aspects' to list available aspects, or check the spelling of '${opts.aspect}'.`,
            }) + '\n',
          );
          process.exit(1);
          return;
        }

        if (aspect.reviewer.type !== 'structure') {
          process.stderr.write(
            buildIssueMessage({
              what: `Aspect '${opts.aspect}' has reviewer '${aspect.reviewer.type}', not 'structure'.`,
              why: `yg structure-test only runs structure aspects (those with check.mjs).`,
              next: `Pick an aspect with 'reviewer: structure' in yg-aspect.yaml, or run yg approve for LLM aspects.`,
            }) + '\n',
          );
          process.exit(1);
          return;
        }

        const nodePath = (opts.node as string).trim().replace(/\/$/, '');
        const node = graph.nodes.get(nodePath);
        if (!node) {
          process.stderr.write(
            buildIssueMessage({
              what: `Node '${nodePath}' not found.`,
              why: `--node requires an existing node path in the graph.`,
              next: `Run 'yg tree' to list nodes.`,
            }) + '\n',
          );
          process.exit(1);
          return;
        }

        const aspectDir = path.join('.yggdrasil', 'aspects', aspect.id);

        const result = await runStructureAspect({
          aspectDir,
          aspectId: aspect.id,
          nodePath,
          graph,
          projectRoot,
        });

        if (opts.checkDeterminism) {
          const result2 = await runStructureAspect({
            aspectDir,
            aspectId: aspect.id,
            nodePath,
            graph,
            projectRoot,
          });

          const sortKey = (v: Violation): string =>
            `${v.file ?? '<graph>'}:${v.line ?? 0}:${v.column ?? 0}:${v.message}`;
          const sorted1 = [...result.violations].sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
          const sorted2 = [...result2.violations].sort((a, b) => sortKey(a).localeCompare(sortKey(b)));

          if (JSON.stringify(sorted1) !== JSON.stringify(sorted2)) {
            process.stderr.write(
              buildIssueMessage({
                what: `Structure aspect '${opts.aspect}' produced non-deterministic results.`,
                why: `Two consecutive runs returned different violations. This indicates the check.mjs has side effects or depends on non-deterministic state.`,
                next: `Review check.mjs to ensure it depends only on ctx inputs and produces stable output.`,
              }) + '\n',
            );
            process.stderr.write('Run 1:\n');
            process.stderr.write(JSON.stringify(sorted1, null, 2) + '\n');
            process.stderr.write('Run 2:\n');
            process.stderr.write(JSON.stringify(sorted2, null, 2) + '\n');
            process.exit(1);
            return;
          }
        }

        if (result.violations.length === 0) {
          process.stdout.write('No violations.\n');
          return;
        }

        printViolations(result.violations);
        process.exit(1);
      } catch (e: unknown) {
        debugWrite(`[structure-test] run failed: ${e instanceof Error ? e.message : String(e)}`);
        abortOnUnexpectedError(e, 'running structure-test');
      }
    });
}

function printViolations(violations: Violation[]): void {
  const withFile: Violation[] = [];
  const withoutFile: Violation[] = [];

  for (const v of violations) {
    if (typeof v.file === 'string') {
      withFile.push(v);
    } else {
      withoutFile.push(v);
    }
  }

  // Print graph-level violations first (no file)
  for (const v of withoutFile) {
    process.stdout.write(`<graph>: ${v.message}\n`);
  }

  // Group file violations by file, sorted alphabetically
  const byFile = new Map<string, Violation[]>();
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
