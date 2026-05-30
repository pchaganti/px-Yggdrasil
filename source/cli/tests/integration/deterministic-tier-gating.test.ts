import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { loadGraph } from '../../src/core/graph-loader.js';
import { validate } from '../../src/core/validator.js';
import { APPROVE_GATING_CODES } from '../../src/cli/approve.js';

// Phase 4 invariant: a deterministic aspect that carries a tier: is a hard
// parser error (aspect-tier-on-deterministic). That code is a member of
// APPROVE_GATING_CODES, so `yg approve` aborts BEFORE creating any LLM
// provider — a deterministic aspect can never trigger a paid call, even when
// mis-configured. We prove the two halves: the validator emits the code, and
// the approve gate set contains it.
async function fixture(aspectYaml: string): Promise<{ projectRoot: string; cleanup: () => Promise<void> }> {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'det-tier-gating-'));
  const ygDir = path.join(projectRoot, '.yggdrasil');
  await mkdir(path.join(ygDir, 'aspects', 't'), { recursive: true });
  await mkdir(path.join(ygDir, 'model'), { recursive: true });
  await mkdir(path.join(ygDir, 'flows'), { recursive: true });
  await mkdir(path.join(ygDir, 'schemas'), { recursive: true });
  await writeFile(path.join(ygDir, 'schemas', 'yg-aspect.yaml'), 'type: aspect\n');
  await writeFile(
    path.join(ygDir, 'yg-architecture.yaml'),
    `node_types:\n  module:\n    description: Logical grouping\n`,
  );
  await writeFile(
    path.join(ygDir, 'yg-config.yaml'),
    'reviewer:\n  tiers:\n    standard:\n      provider: ollama\n      consensus: 1\n      config:\n        model: llama3\n',
  );
  await writeFile(path.join(ygDir, 'aspects', 't', 'yg-aspect.yaml'), aspectYaml);
  await writeFile(path.join(ygDir, 'aspects', 't', 'check.mjs'), 'export function check() { return []; }');
  return { projectRoot, cleanup: () => rm(projectRoot, { recursive: true, force: true }) };
}

describe('deterministic aspect with invalid tier gates approve with no LLM call', () => {
  it('validator emits aspect-tier-on-deterministic and the code is an approve gating code', async () => {
    const f = await fixture('name: T\ndescription: x\nreviewer:\n  type: deterministic\n  tier: deep\n');
    try {
      const graph = await loadGraph(f.projectRoot);
      const result = await validate(graph);
      expect(result.issues.some(i => i.code === 'aspect-tier-on-deterministic')).toBe(true);
      expect(APPROVE_GATING_CODES.has('aspect-tier-on-deterministic')).toBe(true);
    } finally {
      await f.cleanup();
    }
  });
});
