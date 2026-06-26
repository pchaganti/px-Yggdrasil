/**
 * Integration tests for collectInvalidatedPairs — cold companion-LLM resolution.
 *
 * Uses the e2e-companion fixture: the `scenarios` node has a per:file companion-LLM
 * aspect (`scenario-matches-test`), a `uses -> specs` relation, and a companion.mjs
 * that reads ONE paired spec via ctx.fs.read (the spec path is in the scenario's
 * frontmatter `test:` key). Editing the paired spec must admit the scenario pair as
 * `observe-companion / precise`; editing an unrelated spec must not.
 *
 * These are COLD tests: the lock is empty, so there are no warm lock entries. The
 * companion resolver is run live to find the paired spec.
 */

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadGraph } from '../../src/core/graph-loader.js';
import { collectInvalidatedPairs } from '../../src/cli/impact-handlers.js';
import type { LockFile } from '../../src/model/lock.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, '..', 'fixtures', 'e2e-companion');

async function loadE2eCompanionFixture(): Promise<{ graph: Awaited<ReturnType<typeof loadGraph>>; projectRoot: string }> {
  const projectRoot = FIXTURE;
  const graph = await loadGraph(projectRoot);
  return { graph, projectRoot };
}

const emptyLock = (): LockFile => ({ version: 1, verdicts: {}, nodes: {} });

describe('collectInvalidatedPairs — cold companion-LLM', () => {
  it('cold: editing the paired spec admits the scenario pair as observe-companion (precise)', async () => {
    const { graph, projectRoot } = await loadE2eCompanionFixture();
    const lock = emptyLock();
    // checkout.md's companion reads checkout.spec.ts; editing it should admit that pair.
    const F = 'apps/e2e/tests/checkout.spec.ts';
    const set = await collectInvalidatedPairs(graph, F, lock, projectRoot);
    const hit = set.pairs.find(
      (p) => p.aspectId === 'scenario-matches-test' && p.reasons.includes('observe-companion'),
    );
    expect(hit).toBeDefined();
    expect(hit?.mode).toBe('precise');
    expect(set.unresolved).toHaveLength(0);
  });

  it('cold: editing a non-paired spec does NOT admit the scenario units whose companion does not read it', async () => {
    const { graph, projectRoot } = await loadE2eCompanionFixture();
    const lock = emptyLock();
    // login.spec.ts is paired with login.md, NOT with checkout.md.
    // So editing login.spec.ts must not admit the checkout.md pair.
    const F = 'apps/e2e/tests/login.spec.ts';
    const set = await collectInvalidatedPairs(graph, F, lock, projectRoot);
    const admittedUnits = set.pairs
      .filter((p) => p.aspectId === 'scenario-matches-test')
      .map((p) => p.unitKey);
    // checkout scenario's companion reads ONLY checkout.spec.ts; editing login.spec.ts must not admit it.
    expect(admittedUnits).not.toContain('file:references/e2e-test-scenarios/checkout.md');
  });
});
