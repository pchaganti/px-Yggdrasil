import { Command } from 'commander';
import path from 'node:path';
import { loadGraphOrAbort, abortOnUnexpectedError } from './preamble.js';
import { exitAfterFlush } from './exit-after-flush.js';
import { debugWrite } from '../utils/debug-log.js';
import { runAstAspect } from '../ast/runner.js';
import { runStructureAspect } from '../structure/runner.js';
import { buildIssueMessage } from '../formatters/message-builder.js';
import type { Violation as AstViolation } from '../ast/types.js';
import type { Violation as StructureViolation } from '../structure/types.js';
import { computeExpectedPairs } from '../core/pairs.js';
import { buildPairPrompt } from '../llm/prompt.js';
import type { PromptReferenceInput, PromptFileInput } from '../llm/prompt.js';
import { verifyWithConsensus } from '../llm/aspect-verifier.js';
import { createLlmProvider } from '../llm/index.js';
import { selectTierForAspect } from '../core/tier-selection.js';
import { contentFor, nodeDescriptionFor } from '../core/pair-inputs.js';
import { readTextFile } from '../io/graph-fs.js';
import { toPosixPath } from '../utils/posix.js';

/** Footer printed after every run (det, LLM, and --dry-run). */
const DIAGNOSTIC_FOOTER =
  'diagnostic only — lock unchanged; yg check still reports the stored verdict\n';

export function registerAspectTestCommand(program: Command): void {
  program
    .command('aspect-test')
    .description(
      'Run an aspect check without modifying the lock — against a graph node (--node) or ad-hoc files (--files, deterministic only). ' +
      'For LLM aspects, --dry-run prints the assembled prompt(s) without making any provider calls.',
    )
    .requiredOption('--aspect <id>', 'aspect id to run')
    .option('--node <path>', 'graph node to check (uses the node mapping and graph-aware ctx)')
    .option('--files <paths...>', 'ad-hoc source files to check (deterministic aspects only; no graph attachment)')
    .option('--check-determinism', 'run the check twice and fail if results differ (deterministic aspects only)')
    .option('--dry-run', 'for LLM aspects: print the assembled prompt(s) to stdout, make NO provider calls')
    .action(async (opts) => {
      const projectRoot = process.cwd();
      try {
        const graph = await loadGraphOrAbort(projectRoot);

        const aspect = graph.aspects.find((a) => a.id === opts.aspect);
        if (!aspect) {
          process.stderr.write(
            buildIssueMessage({
              what: `Aspect '${opts.aspect}' not found.`,
              why: `yg aspect-test requires an aspect declared in .yggdrasil/aspects/.`,
              next: `Run 'yg aspects' to list available aspects, or check the spelling of '${opts.aspect}'.`,
            }) + '\n',
          );
          process.exit(1);
          return;
        }

        const hasNode = typeof opts.node === 'string';
        const hasFiles = Array.isArray(opts.files) && opts.files.length > 0;

        // ── LLM aspect path ──────────────────────────────────────────────────
        if (aspect.reviewer.type === 'llm') {
          // --files is not supported for LLM aspects: they need graph context.
          if (hasFiles) {
            process.stderr.write(
              buildIssueMessage({
                what: `--files cannot be used with LLM aspect '${opts.aspect}'.`,
                why: `LLM reviews require graph context (node mapping, effective aspects, tier config). Ad-hoc file lists have none of these.`,
                next: `Use --node <node-path> instead, or switch to a deterministic aspect for --files mode.`,
              }) + '\n',
            );
            process.exit(1);
            return;
          }
          if (!hasNode) {
            process.stderr.write(
              buildIssueMessage({
                what: `Neither --node nor --files was provided for LLM aspect '${opts.aspect}'.`,
                why: `yg aspect-test runs in exactly one mode: --node (graph-scoped) or --files (ad-hoc, deterministic only).`,
                next: `Pass --node <node-path> to run an LLM aspect.`,
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

          await runLlmAspectTest(graph, projectRoot, aspect, nodePath, opts.dryRun ?? false);
          process.stdout.write(DIAGNOSTIC_FOOTER);
          return;
        }

        // ── Deterministic aspect path ────────────────────────────────────────
        if (aspect.reviewer.type !== 'deterministic') {
          process.stderr.write(
            buildIssueMessage({
              what: `Aspect '${opts.aspect}' has reviewer '${aspect.reviewer.type}', not 'deterministic' or 'llm'.`,
              why: `yg aspect-test supports deterministic aspects (check.mjs) and LLM aspects (content.md).`,
              next: `Pick an aspect with a supported reviewer type, or run 'yg aspects' to list available aspects.`,
            }) + '\n',
          );
          process.exit(1);
          return;
        }

        // --dry-run on a deterministic aspect is not meaningful.
        if (opts.dryRun) {
          process.stderr.write(
            buildIssueMessage({
              what: `--dry-run is not supported for deterministic aspect '${opts.aspect}'.`,
              why: `Deterministic checks run locally without any provider calls — there is no prompt to print.`,
              next: `Remove --dry-run to run the deterministic check, or use --node / --files as normal.`,
            }) + '\n',
          );
          process.exit(1);
          return;
        }

        if (hasNode === hasFiles) {
          process.stderr.write(
            buildIssueMessage({
              what: hasNode
                ? `Both --node and --files were provided.`
                : `Neither --node nor --files was provided.`,
              why: `yg aspect-test runs in exactly one mode: --node (graph-scoped) or --files (ad-hoc).`,
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
              process.stdout.write(DIAGNOSTIC_FOOTER);
              await exitAfterFlush(1);
            }
          }
          if (result.violations.length === 0) {
            process.stdout.write('No violations.\n');
            process.stdout.write(DIAGNOSTIC_FOOTER);
            return;
          }
          printStructureViolations(result.violations);
          process.stdout.write(DIAGNOSTIC_FOOTER);
          await exitAfterFlush(1);
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
            process.stdout.write(DIAGNOSTIC_FOOTER);
            await exitAfterFlush(1);
          }
        }
        if (result.violations.length === 0) {
          process.stdout.write('No violations.\n');
          process.stdout.write(DIAGNOSTIC_FOOTER);
          return;
        }
        printAstViolations(result.violations);
        process.stdout.write(DIAGNOSTIC_FOOTER);
        await exitAfterFlush(1);
      } catch (e: unknown) {
        debugWrite(`[aspect-test] run failed: ${e instanceof Error ? e.message : String(e)}`);
        abortOnUnexpectedError(e, 'running aspect-test');
      }
    });
}

// ============================================================
// LLM aspect test
// ============================================================

/**
 * Run (or dry-run) an LLM aspect against a graph node. Builds pair prompts via
 * computeExpectedPairs filtered to the given aspect+node, runs verifyWithConsensus
 * per prompt, and prints results. The lock is NEVER written.
 */
async function runLlmAspectTest(
  graph: import('../model/graph.js').Graph,
  projectRoot: string,
  aspect: import('../model/graph.js').AspectDef,
  nodePath: string,
  dryRun: boolean,
): Promise<void> {
  // Resolve the tier for this aspect.
  const reviewer = graph.config.reviewer;
  if (!reviewer) {
    process.stderr.write(
      buildIssueMessage({
        what: `No reviewer is configured for aspect '${aspect.id}'.`,
        why: `LLM aspects need a reviewer tier in .yggdrasil/yg-config.yaml.`,
        next: `Add a reviewer tier, then retry.`,
      }) + '\n',
    );
    process.exit(1);
    return;
  }
  const tierResult = selectTierForAspect(aspect, reviewer);
  if (!tierResult.ok) {
    process.stderr.write(
      buildIssueMessage(tierResult.error) + '\n',
    );
    process.exit(1);
    return;
  }
  const { tier, tierName } = tierResult;

  // Compute the expected pairs filtered to this aspect+node.
  const { pairs } = await computeExpectedPairs(graph);
  const myPairs = pairs.filter(
    (p) => p.aspectId === aspect.id && p.nodePath === nodePath && p.kind === 'llm',
  );

  if (myPairs.length === 0) {
    process.stdout.write(
      `No pairs for aspect '${aspect.id}' on node '${nodePath}' — the aspect may be draft, have an empty subject set, or not apply to this node.\n`,
    );
    return;
  }

  // Load references once.
  const refInputs = aspect.references ?? [];
  const referencesForPrompt: PromptReferenceInput[] = [];
  for (const ref of refInputs) {
    const absRef = path.resolve(projectRoot, ref.path);
    let content: string;
    try {
      content = await readTextFile(absRef);
    } catch (e) {
      debugWrite(`[aspect-test] reference file read failed for ${absRef}: ${e instanceof Error ? e.message : String(e)}`);
      process.stderr.write(
        buildIssueMessage({
          what: `Reference '${toPosixPath(ref.path)}' for aspect '${aspect.id}' could not be read.`,
          why: `The file does not exist or is not readable.`,
          next: `Check the reference path in yg-aspect.yaml.`,
        }) + '\n',
      );
      process.exit(1);
      return;
    }
    referencesForPrompt.push({ path: ref.path, description: ref.description, content });
  }

  const nodeDescription = nodeDescriptionFor(graph, nodePath);
  const aspectContent = contentFor(aspect, 'content.md');

  if (!dryRun) {
    // Tier config already includes the yg-secrets overlay (applied at parse time).
    const mergedTier = tier;
    const provider = createLlmProvider(mergedTier);

    // Availability check.
    let available: boolean;
    try {
      available = await provider.isAvailable();
    } catch (e) {
      debugWrite(`[aspect-test] provider.isAvailable threw for tier ${tierName}: ${e instanceof Error ? e.message : String(e)}`);
      available = false;
    }
    if (!available) {
      process.stderr.write(
        buildIssueMessage({
          what: `Reviewer provider '${mergedTier.provider}' (tier '${tierName}') is unreachable.`,
          why: `The configured reviewer endpoint did not respond. No provider calls were made.`,
          next: `Check the provider endpoint, network, and credentials, then retry.`,
        }) + '\n',
      );
      process.exit(1);
      return;
    }

    for (const pair of myPairs) {
      // Load subject files for this pair.
      const files: PromptFileInput[] = [];
      for (const rel of pair.subjectFiles) {
        let content: string;
        try {
          const bytes = await import('node:fs/promises').then((fs) => fs.readFile(path.resolve(projectRoot, rel)));
          content = bytes.toString('utf8');
        } catch (e) {
          debugWrite(`[aspect-test] subject file read failed for ${rel} on ${pair.unitKey}: ${e instanceof Error ? e.message : String(e)}`);
          content = '';
        }
        files.push({ path: rel, content });
      }

      const prompt = buildPairPrompt({
        aspect: { id: aspect.id, description: aspect.description ?? '', content: aspectContent },
        references: referencesForPrompt,
        nodePath,
        nodeDescription,
        files,
        scope: aspect.scope,
      });

      let response;
      try {
        response = await verifyWithConsensus(provider, prompt, mergedTier.consensus ?? 1);
      } catch (e) {
        debugWrite(`[aspect-test] reviewer threw for ${aspect.id} on ${pair.unitKey}: ${e instanceof Error ? e.message : String(e)}`);
        process.stderr.write(
          buildIssueMessage({
            what: `Reviewer threw an error for aspect '${aspect.id}' on ${pair.unitKey}.`,
            why: `The reviewer returned an unparseable or errored response: ${e instanceof Error ? e.message : String(e)}`,
            next: `Check the reviewer configuration and retry.`,
          }) + '\n',
        );
        continue;
      }

      const verdict = response.satisfied ? 'satisfied' : 'refused';
      process.stdout.write(`${pair.unitKey}: ${verdict} — ${response.reason}\n`);
    }
  } else {
    // --dry-run: print assembled prompt(s), no provider calls.
    for (const pair of myPairs) {
      const files: PromptFileInput[] = [];
      for (const rel of pair.subjectFiles) {
        let content: string;
        try {
          const bytes = await import('node:fs/promises').then((fs) => fs.readFile(path.resolve(projectRoot, rel)));
          content = bytes.toString('utf8');
        } catch (e) {
          debugWrite(`[aspect-test] subject file read failed for ${rel} on ${pair.unitKey}: ${e instanceof Error ? e.message : String(e)}`);
          content = '';
        }
        files.push({ path: rel, content });
      }

      const prompt = buildPairPrompt({
        aspect: { id: aspect.id, description: aspect.description ?? '', content: aspectContent },
        references: referencesForPrompt,
        nodePath,
        nodeDescription,
        files,
        scope: aspect.scope,
      });

      process.stdout.write(`=== prompt for ${pair.unitKey} ===\n`);
      process.stdout.write(prompt + '\n');
    }
  }
}

// ============================================================
// Determinism check (shared by both deterministic modes)
// ============================================================

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

// ============================================================
// Renderers (kept separate: AST has required line, structure does not)
// ============================================================

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
