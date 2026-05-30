import { Command } from 'commander';
import path from 'node:path';
import { loadGraphOrAbort, abortOnUnexpectedError } from '../formatters/cli-preamble.js';
import { debugWrite } from '../utils/debug-log.js';
import { runAstAspect } from '../ast/runner.js';
import { runStructureAspect } from '../structure/runner.js';
import { buildIssueMessage } from '../formatters/message-builder.js';
import type { Violation as AstViolation } from '../ast/types.js';
import type { Violation as StructureViolation } from '../structure/types.js';

export function registerDeterministicTestCommand(program: Command): void {
  program
    .command('deterministic-test')
    .description(
      'Run a deterministic aspect check (check.mjs) without approving — against a graph node (--node) or ad-hoc files (--files). No baseline is written.',
    )
    .requiredOption('--aspect <id>', 'aspect id to run')
    .option('--node <path>', 'graph node to check (uses the node mapping and graph-aware ctx)')
    .option('--files <paths...>', 'ad-hoc source files to check (no graph attachment)')
    .option('--check-determinism', 'run the check twice and fail if results differ')
    .action(async (opts) => {
      const projectRoot = process.cwd();
      try {
        const graph = await loadGraphOrAbort(projectRoot);

        const aspect = graph.aspects.find((a) => a.id === opts.aspect);
        if (!aspect) {
          process.stderr.write(
            buildIssueMessage({
              what: `Aspect '${opts.aspect}' not found.`,
              why: `yg deterministic-test requires an aspect declared in .yggdrasil/aspects/.`,
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
              why: `yg deterministic-test only runs deterministic aspects (those with check.mjs).`,
              next: `Pick an aspect with 'reviewer: deterministic' in yg-aspect.yaml, or run yg approve for LLM aspects.`,
            }) + '\n',
          );
          process.exit(1);
          return;
        }

        const hasNode = typeof opts.node === 'string';
        const hasFiles = Array.isArray(opts.files) && opts.files.length > 0;
        if (hasNode === hasFiles) {
          process.stderr.write(
            buildIssueMessage({
              what: hasNode
                ? `Both --node and --files were provided.`
                : `Neither --node nor --files was provided.`,
              why: `yg deterministic-test runs in exactly one mode: --node (graph-scoped) or --files (ad-hoc).`,
              next: `Pass --node <node-path> to use the node's mapping, or --files <path...> for ad-hoc files — not both.`,
            }) + '\n',
          );
          process.exit(1);
          return;
        }

        const aspectDir = path.join('.yggdrasil', 'aspects', aspect.id);

        // --node: graph-scoped, matches real approve (always node-scoped). The
        // structure runner resolves the node's own mapping and graph-aware ctx.
        if (hasNode) {
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
          // Return type is inferred from the runner (RunStructureAspectResult);
          // do not re-annotate it, so the shape stays in sync with the runner.
          const runOnce = () =>
            runStructureAspect({ aspectDir, aspectId: aspect.id, nodePath, graph, projectRoot });
          const result = await runOnce();
          if (opts.checkDeterminism) {
            const result2 = await runOnce();
            if (!determinismMatches(result.violations, result2.violations)) {
              writeNonDeterministicError(opts.aspect, result.violations, result2.violations);
              process.exit(1);
              return;
            }
          }
          if (result.violations.length === 0) {
            process.stdout.write('No violations.\n');
            return;
          }
          printStructureViolations(result.violations);
          process.exit(1);
          return;
        }

        // --files: ad-hoc mode has no node and thus no approve equivalent; it
        // stays on the AST runner (a fileless structure path is out of scope).
        const filePaths = opts.files as string[];
        // Return type is inferred from the runner; do not re-annotate it.
        const runOnce = () =>
          runAstAspect({
            aspectDir,
            aspectId: aspect.id,
            files: filePaths.map((f) => ({ path: f })),
            projectRoot,
          });
        const result = await runOnce();
        if (opts.checkDeterminism) {
          const result2 = await runOnce();
          if (!determinismMatches(result.violations, result2.violations)) {
            writeNonDeterministicError(opts.aspect, result.violations, result2.violations);
            process.exit(1);
            return;
          }
        }
        if (result.violations.length === 0) {
          process.stdout.write('No violations.\n');
          return;
        }
        printAstViolations(result.violations);
        process.exit(1);
      } catch (e: unknown) {
        debugWrite(`[deterministic-test] run failed: ${e instanceof Error ? e.message : String(e)}`);
        abortOnUnexpectedError(e, 'running deterministic-test');
      }
    });
}

// --- determinism check (shared by both modes) -----------------------------

type AnyViolation = { file?: string; line?: number; column?: number; message: string };

function sortKey(v: AnyViolation): string {
  return `${v.file ?? '<graph>'}:${v.line ?? 0}:${v.column ?? 0}:${v.message}`;
}

function determinismMatches(a: AnyViolation[], b: AnyViolation[]): boolean {
  const sa = [...a].sort((x, y) => sortKey(x).localeCompare(sortKey(y)));
  const sb = [...b].sort((x, y) => sortKey(x).localeCompare(sortKey(y)));
  return JSON.stringify(sa) === JSON.stringify(sb);
}

function writeNonDeterministicError(aspectId: string, run1: AnyViolation[], run2: AnyViolation[]): void {
  const sorted1 = [...run1].sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
  const sorted2 = [...run2].sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
  process.stderr.write(
    buildIssueMessage({
      what: `Deterministic aspect '${aspectId}' produced non-deterministic results.`,
      why: `Two consecutive runs returned different violations. This indicates the check.mjs has side effects or depends on non-deterministic state.`,
      next: `Review check.mjs to ensure it depends only on its inputs and produces stable output.`,
    }) + '\n',
  );
  process.stderr.write('Run 1:\n');
  process.stderr.write(JSON.stringify(sorted1, null, 2) + '\n');
  process.stderr.write('Run 2:\n');
  process.stderr.write(JSON.stringify(sorted2, null, 2) + '\n');
}

// --- renderers (kept separate: AST has required line, structure does not) --

function printAstViolations(violations: AstViolation[]): void {
  const byFile = new Map<string, AstViolation[]>();
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
