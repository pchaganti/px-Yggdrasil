import type { Command } from 'commander';
import chalk from 'chalk';
import { debugWrite } from '../utils/debug-log.js';
import { loadGraphOrAbort } from '../formatters/cli-preamble.js';
import { buildIndex, createMiniSearch } from '../io/find-index.js';
import type { IndexedDocument } from '../io/find-index.js';
import { buildIssueMessage } from '../formatters/message-builder.js';

const TOP_N = 5;

export async function findCommand(query: string, projectRoot: string): Promise<number> {
  if (!query || query.trim() === '') {
    process.stderr.write(
      chalk.red(
        buildIssueMessage({
          what: 'Query is required',
          why: 'yg find needs at least one keyword to search.',
          next: 'Usage: yg find "<query keywords>"',
        }),
      ) + '\n',
    );
    return 1;
  }

  try {
    const graph = await loadGraphOrAbort(projectRoot);
    const docs = await buildIndex(graph);
    if (docs.length === 0) {
      process.stdout.write('Empty graph, nothing to search.\n');
      return 0;
    }

    const ms = createMiniSearch();
    ms.addAll(docs);
    const results = ms.search(query.trim()).slice(0, TOP_N);
    if (results.length === 0) {
      process.stdout.write('No matches.\n');
      return 0;
    }

    process.stdout.write('Top entry points (ranked by relevance):\n\n');
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const doc = docs.find((d) => d.id === r.id) as IndexedDocument | undefined;
      /* v8 ignore next */
      if (!doc) continue;
      const matched = (r.terms ?? []).join(', ');
      const score = (r.score ?? 0).toFixed(2);
      const docPath = doc.path.replace(/\\/g, '/').replace(/\/+$/, '');
      process.stdout.write(`${i + 1}. ${docPath.padEnd(40)} score: ${score}\n`);
      process.stdout.write(`   Kind: ${doc.kind}\n`);
      if (doc.type) process.stdout.write(`   Type: ${doc.type}\n`);
      process.stdout.write(`   Description: "${doc.description}"\n`);
      if (matched) process.stdout.write(`   Matched: ${matched}\n`);
      process.stdout.write('\n');
    }
    return 0;
  } catch (error) {
    debugWrite(`[find] findCommand failed: ${error instanceof Error ? error.message : String(error)}`);
    process.stderr.write(chalk.red(`Error: ${(error as Error).message}\n`));
    return 1;
  }
}

export function registerFindCommand(program: Command): void {
  program
    .command('find')
    .description('Locate entry points (nodes / aspects) by natural-language query')
    .argument('<query>', 'Search keywords (English)')
    .action(async (query: string) => {
      try {
        const exit = await findCommand(query, process.cwd());
        process.exit(exit);
      } catch (error) {
        debugWrite(`[find] registerFindCommand action failed: ${error instanceof Error ? error.message : String(error)}`);
        process.stderr.write(chalk.red(`Error: ${(error as Error).message}\n`));
        process.exit(1);
      }
    });
}
