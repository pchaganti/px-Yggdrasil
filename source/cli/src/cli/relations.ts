import { Command } from 'commander';

import { loadGraphOrAbort, abortOnUnexpectedError } from './preamble.js';
import { initDebugLog } from '../utils/debug-log.js';
import { appendToDebugLog } from '../io/debug-log-writer.js';
import { projectRootFromGraph } from '../io/paths.js';
import { runRelationPass } from '../relations/pass.js';
import { extractorForLanguage } from '../relations/extractors/registry.js';
import { makeResolvePathToFile } from '../relations/resolve-path.js';
import { relationIndexDir } from '../relations/index-dir.js';
import { allowedRelationTypes } from '../relations/allowed-types.js';
import type { Graph } from '../model/graph.js';
import type { Violation } from '../relations/verifier.js';

/**
 * Render the per-target suggestion lines for one node's violations — the exact
 * `relations:` stanza to add (or a dead-end note pointing at the architecture).
 * Reuses the architecture allow-list logic shared with the refusal message.
 */
function renderSuggestions(graph: Graph, nodeId: string, violations: Violation[]): string {
  const fromType = graph.nodes.get(nodeId)?.meta.type;
  const nodeFile = `.yggdrasil/model/${nodeId}/yg-node.yaml`;

  const targets: string[] = [];
  for (const v of violations) if (!targets.includes(v.ownerNode)) targets.push(v.ownerNode);

  // Show the detected-but-undeclared sites first, then the per-target stanza.
  const sites = violations
    .map((v) => `    ${v.fromFile}:${v.line} → ${v.ownerNode}`)
    .join('\n');

  const blocks: string[] = [];
  for (const target of targets) {
    const toType = graph.nodes.get(target)?.meta.type;
    const allowed =
      fromType !== undefined && toType !== undefined
        ? allowedRelationTypes(graph.architecture, fromType, toType)
        : [];

    if (allowed.length === 0) {
      const fromDesc = fromType ?? '(unknown type)';
      const toDesc = toType ?? '(unknown type)';
      blocks.push(
        `  ${target}: no relation type is allowed from ${fromDesc} to ${toDesc}; ` +
          `either change a node's type or update the allowed relations in ` +
          `.yggdrasil/yg-architecture.yaml (requires confirming the architecture change).`,
      );
    } else {
      blocks.push(
        `  ${target}: allowed relation type(s) [${allowed.join(', ')}]. Add to ${nodeFile}:\n` +
          `    relations:\n` +
          `      - target: ${target}\n` +
          `        type: ${allowed[0]}`,
      );
    }
  }

  return `${nodeId}: undeclared cross-node dependencies detected\n${sites}\n${blocks.join('\n')}`;
}

export function registerRelationsCommand(program: Command): void {
  program
    .command('relations')
    .description('Inspect cross-node dependency relations')
    .option(
      '--suggest',
      'Read-only triage: detect undeclared cross-node dependencies and print the relations: stanza to add for each. Writes nothing.',
    )
    .action(async (options: { suggest?: boolean }) => {
      try {
        const graph = await loadGraphOrAbort(process.cwd());
        initDebugLog(graph.rootPath, graph.config.debug ?? false, appendToDebugLog);
        const projectRoot = projectRootFromGraph(graph.rootPath);

        if (!options.suggest) {
          process.stdout.write(
            'Usage: yg relations --suggest\n' +
              '  --suggest  Detect undeclared cross-node dependencies and print the relations: stanza to add.\n',
          );
          return;
        }

        // Run the relation pass directly and read its verdicts WITHOUT persisting
        // anything — this command never touches the lock (read-only triage). The
        // same deps fill/check build (live extraction; per-language resolution).
        const result = await runRelationPass(graph, projectRoot, {
          extractorFor: extractorForLanguage,
          resolvePathToFile: makeResolvePathToFile(projectRoot),
          symbolIndexDir: relationIndexDir(graph.rootPath),
        });

        const refused = [...result.verdicts.entries()]
          .filter(([, v]) => v.verdict === 'refused' && v.violations.length > 0)
          .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

        if (refused.length === 0) {
          process.stdout.write(
            'No undeclared cross-node dependencies detected. Every detected edge is a declared or sanctioned relation.\n',
          );
          return;
        }

        const sections = refused.map(([nodeId, v]) =>
          renderSuggestions(graph, nodeId, v.violations),
        );
        process.stdout.write(sections.join('\n\n') + '\n');
      } catch (error) {
        abortOnUnexpectedError(error, 'computing relation suggestions');
      }
    });
}
