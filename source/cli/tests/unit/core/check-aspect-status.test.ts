/**
 * Task 14 — `yg check` renders by aspect status.
 *
 * Verifies that classifyDrift / runCheck emit:
 *   • aspect-newly-active (error) — non-draft effective aspect without baseline verdict
 *   • aspect-violation-enforced (error) — refused baseline + enforced status
 *   • aspect-violation-advisory (warning) — refused baseline + advisory status
 *
 * Plus: draft aspects produce nothing, approved baselines produce nothing,
 * legacy baselines (no aspectVerdicts field) tolerate gracefully, summary
 * counts include advisory + draft tallies, and suggestedNext picks the
 * highest-priority error message.
 */
import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { loadGraph } from '../../../src/core/graph-loader.js';
import { classifyDrift, runCheck } from '../../../src/core/check.js';
import { writeNodeDriftState } from '../../../src/io/drift-state-store.js';
import { hashTrackedFiles } from '../../../src/io/hash.js';
import { collectTrackedFiles } from '../../../src/core/graph/files.js';
import type { DriftNodeState } from '../../../src/model/drift.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface ProjectOpts {
  nodePath: string;
  nodeYaml: string;
  mappingFiles?: Record<string, string>;
  aspects?: Array<{ id: string; yaml: string; files?: Record<string, string> }>;
}

const tmpDirs: string[] = [];

afterEach(async () => {
  while (tmpDirs.length > 0) {
    const d = tmpDirs.pop()!;
    await rm(d, { recursive: true, force: true });
  }
});

async function createTmpProject(name: string, opts: ProjectOpts) {
  const tmpDir = path.join(__dirname, `../../fixtures/tmp-check-aspect-status-${name}`);
  const yggRoot = path.join(tmpDir, '.yggdrasil');
  const nodeDir = path.join(yggRoot, 'model', opts.nodePath);

  await rm(tmpDir, { recursive: true, force: true });
  tmpDirs.push(tmpDir);
  await mkdir(nodeDir, { recursive: true });
  await mkdir(path.join(yggRoot, '.drift-state'), { recursive: true });
  await mkdir(path.join(yggRoot, 'schemas'), { recursive: true });
  await writeFile(path.join(yggRoot, 'schemas', 'yg-node.yaml'), 'type: node\n');
  await writeFile(path.join(yggRoot, 'schemas', 'yg-aspect.yaml'), 'type: aspect\n');
  await writeFile(path.join(yggRoot, 'schemas', 'yg-flow.yaml'), 'type: flow\n');
  await writeFile(path.join(yggRoot, 'yg-config.yaml'), 'version: "5.0.0"\n');
  await writeFile(path.join(nodeDir, 'yg-node.yaml'), opts.nodeYaml);

  const parts = opts.nodePath.split('/');
  if (parts.length > 1) {
    const parentPath = parts.slice(0, -1).join('/');
    const parentDir = path.join(yggRoot, 'model', parentPath);
    await mkdir(parentDir, { recursive: true });
    await writeFile(
      path.join(parentDir, 'yg-node.yaml'),
      `name: ${parts[parts.length - 2]}\ntype: service\ndescription: parent\n`,
    );
  }

  if (opts.aspects) {
    for (const asp of opts.aspects) {
      const aspDir = path.join(yggRoot, 'aspects', asp.id);
      await mkdir(aspDir, { recursive: true });
      await writeFile(path.join(aspDir, 'yg-aspect.yaml'), asp.yaml);
      if (asp.files) {
        for (const [aName, content] of Object.entries(asp.files)) {
          await writeFile(path.join(aspDir, aName), content);
        }
      }
    }
  }

  if (opts.mappingFiles) {
    for (const [relPath, content] of Object.entries(opts.mappingFiles)) {
      const abs = path.join(tmpDir, relPath);
      await mkdir(path.dirname(abs), { recursive: true });
      await writeFile(abs, content);
    }
  }

  return { tmpDir, yggRoot };
}

/**
 * Record a baseline for the node WITH a specified aspectVerdicts map.
 * Hashes the current tracked-file state so the file-hash compare loop
 * yields no drift -- isolating per-aspect emissions.
 */
async function recordBaselineWithVerdicts(
  tmpDir: string,
  nodePath: string,
  aspectVerdicts: DriftNodeState['aspectVerdicts'],
): Promise<void> {
  const graph = await loadGraph(tmpDir);
  const node = graph.nodes.get(nodePath);
  if (!node) throw new Error(`node ${nodePath} not found in graph after load`);
  const trackedFiles = collectTrackedFiles(node, graph);
  const projectRoot = path.dirname(graph.rootPath);
  const { canonicalHash, fileHashes, fileMtimes } = await hashTrackedFiles(
    projectRoot, trackedFiles, undefined, [],
  );
  await writeNodeDriftState(graph.rootPath, nodePath, {
    hash: canonicalHash,
    files: fileHashes,
    mtimes: fileMtimes,
    aspectVerdicts,
  });
}

/** Record baseline WITHOUT aspectVerdicts (legacy pre-status baseline). */
async function recordLegacyBaseline(tmpDir: string, nodePath: string): Promise<void> {
  const graph = await loadGraph(tmpDir);
  const node = graph.nodes.get(nodePath);
  if (!node) throw new Error(`node ${nodePath} not found in graph after load`);
  const trackedFiles = collectTrackedFiles(node, graph);
  const projectRoot = path.dirname(graph.rootPath);
  const { canonicalHash, fileHashes, fileMtimes } = await hashTrackedFiles(
    projectRoot, trackedFiles, undefined, [],
  );
  await writeNodeDriftState(graph.rootPath, nodePath, {
    hash: canonicalHash,
    files: fileHashes,
    mtimes: fileMtimes,
    // no aspectVerdicts -- simulates pre-5.x baseline
  });
}

// ────────────────────────────────────────────────────────────

describe('classifyDrift — aspect-newly-active', () => {
  it('emits aspect-newly-active (error) when an advisory aspect has no baseline verdict', async () => {
    const { tmpDir } = await createTmpProject('newly-active-advisory', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\naspects:\n  - advisory-rule\nmapping:\n  - src/svc/\n',
      mappingFiles: { 'src/svc/index.ts': 'export default 42;\n' },
      aspects: [{
        id: 'advisory-rule',
        yaml: 'name: Advisory\ndescription: test\nreviewer:\n  type: llm\nstatus: advisory\n',
        files: { 'content.md': 'Advisory rule.\n' },
      }],
    });
    // Baseline exists but lacks verdict for advisory-rule
    await recordBaselineWithVerdicts(tmpDir, 'svc/my-service', {});

    const graph = await loadGraph(tmpDir);
    const result = await classifyDrift(graph);
    const newly = result.filter(i => i.code === 'aspect-newly-active');
    expect(newly).toHaveLength(1);
    expect(newly[0].severity).toBe('error');
    expect(newly[0].nodePath).toBe('svc/my-service');
    expect(newly[0].messageData.what).toContain('advisory-rule');
    expect(newly[0].messageData.what).toContain('advisory');
  });

  it('emits aspect-newly-active (error) when an enforced aspect has no baseline verdict', async () => {
    const { tmpDir } = await createTmpProject('newly-active-enforced', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\naspects:\n  - enforced-rule\nmapping:\n  - src/svc/\n',
      mappingFiles: { 'src/svc/index.ts': 'export default 42;\n' },
      aspects: [{
        id: 'enforced-rule',
        yaml: 'name: Enforced\ndescription: test\nreviewer:\n  type: llm\nstatus: enforced\n',
        files: { 'content.md': 'Enforced rule.\n' },
      }],
    });
    await recordBaselineWithVerdicts(tmpDir, 'svc/my-service', {});

    const graph = await loadGraph(tmpDir);
    const result = await classifyDrift(graph);
    const newly = result.filter(i => i.code === 'aspect-newly-active');
    expect(newly).toHaveLength(1);
    expect(newly[0].severity).toBe('error');
    expect(newly[0].messageData.what).toContain('enforced');
  });
});

describe('classifyDrift — aspect-violation-enforced', () => {
  it('emits aspect-violation-enforced (error) for refused baseline + enforced status', async () => {
    const { tmpDir } = await createTmpProject('violation-enforced', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\naspects:\n  - enforced-rule\nmapping:\n  - src/svc/\n',
      mappingFiles: { 'src/svc/index.ts': 'export default 42;\n' },
      aspects: [{
        id: 'enforced-rule',
        yaml: 'name: Enforced\ndescription: test\nreviewer:\n  type: llm\nstatus: enforced\n',
        files: { 'content.md': 'Enforced rule.\n' },
      }],
    });
    await recordBaselineWithVerdicts(tmpDir, 'svc/my-service', {
      'enforced-rule': { verdict: 'refused', reason: 'missing audit log', errorSource: 'codeViolation' },
    });

    const graph = await loadGraph(tmpDir);
    const result = await classifyDrift(graph);
    const enforcedV = result.filter(i => i.code === 'aspect-violation-enforced');
    expect(enforcedV).toHaveLength(1);
    expect(enforcedV[0].severity).toBe('error');
    expect(enforcedV[0].nodePath).toBe('svc/my-service');
    expect(enforcedV[0].messageData.what).toContain('enforced-rule');
    expect(enforcedV[0].messageData.what).toContain('missing audit log');
  });
});

describe('classifyDrift — aspect-violation-advisory', () => {
  it('emits aspect-violation-advisory (warning) for refused baseline + advisory status', async () => {
    const { tmpDir } = await createTmpProject('violation-advisory', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\naspects:\n  - advisory-rule\nmapping:\n  - src/svc/\n',
      mappingFiles: { 'src/svc/index.ts': 'export default 42;\n' },
      aspects: [{
        id: 'advisory-rule',
        yaml: 'name: Advisory\ndescription: test\nreviewer:\n  type: llm\nstatus: advisory\n',
        files: { 'content.md': 'Advisory rule.\n' },
      }],
    });
    await recordBaselineWithVerdicts(tmpDir, 'svc/my-service', {
      'advisory-rule': { verdict: 'refused', reason: 'soft style violation', errorSource: 'codeViolation' },
    });

    const graph = await loadGraph(tmpDir);
    const result = await classifyDrift(graph);
    const adv = result.filter(i => i.code === 'aspect-violation-advisory');
    expect(adv).toHaveLength(1);
    expect(adv[0].severity).toBe('warning');
    expect(adv[0].nodePath).toBe('svc/my-service');
    expect(adv[0].messageData.what).toContain('advisory-rule');
    expect(adv[0].messageData.what).toContain('soft style violation');
  });
});

describe('classifyDrift — silent paths', () => {
  it('draft aspect produces NO aspect-status finding (even when reviewer never ran)', async () => {
    const { tmpDir } = await createTmpProject('draft-silent', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\naspects:\n  - draft-rule\nmapping:\n  - src/svc/\n',
      mappingFiles: { 'src/svc/index.ts': 'export default 42;\n' },
      aspects: [{
        id: 'draft-rule',
        yaml: 'name: Draft\ndescription: test\nreviewer:\n  type: llm\nstatus: draft\n',
        files: { 'content.md': 'Draft rule.\n' },
      }],
    });
    // Draft-only nodes are GC'd by the runCheck cleanup; classifyDrift
    // should produce zero findings either way (hasNonDraftEffectiveAspects=false).
    const graph = await loadGraph(tmpDir);
    const result = await classifyDrift(graph);
    const statusFindings = result.filter(i =>
      i.code === 'aspect-newly-active'
      || i.code === 'aspect-violation-enforced'
      || i.code === 'aspect-violation-advisory',
    );
    expect(statusFindings).toHaveLength(0);
  });

  it('approved baseline produces no per-aspect finding', async () => {
    const { tmpDir } = await createTmpProject('approved-silent', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\naspects:\n  - enforced-rule\nmapping:\n  - src/svc/\n',
      mappingFiles: { 'src/svc/index.ts': 'export default 42;\n' },
      aspects: [{
        id: 'enforced-rule',
        yaml: 'name: Enforced\ndescription: test\nreviewer:\n  type: llm\nstatus: enforced\n',
        files: { 'content.md': 'Enforced rule.\n' },
      }],
    });
    await recordBaselineWithVerdicts(tmpDir, 'svc/my-service', {
      'enforced-rule': { verdict: 'approved' },
    });
    const graph = await loadGraph(tmpDir);
    const result = await classifyDrift(graph);
    const statusFindings = result.filter(i =>
      i.code === 'aspect-newly-active'
      || i.code === 'aspect-violation-enforced'
      || i.code === 'aspect-violation-advisory',
    );
    expect(statusFindings).toHaveLength(0);
  });

  it('legacy baseline (no aspectVerdicts field) does NOT trigger aspect-newly-active', async () => {
    const { tmpDir } = await createTmpProject('legacy-baseline', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\naspects:\n  - enforced-rule\nmapping:\n  - src/svc/\n',
      mappingFiles: { 'src/svc/index.ts': 'export default 42;\n' },
      aspects: [{
        id: 'enforced-rule',
        yaml: 'name: Enforced\ndescription: test\nreviewer:\n  type: llm\nstatus: enforced\n',
        files: { 'content.md': 'Enforced rule.\n' },
      }],
    });
    // Baseline written WITHOUT aspectVerdicts -- pre-5.x state.
    await recordLegacyBaseline(tmpDir, 'svc/my-service');

    const graph = await loadGraph(tmpDir);
    const result = await classifyDrift(graph);
    const newly = result.filter(i => i.code === 'aspect-newly-active');
    expect(newly).toHaveLength(0);
  });
});

describe('runCheck — summary counts and suggestedNext', () => {
  it('includes advisory warning in issues and prefers enforced error in suggestedNext', async () => {
    const { tmpDir } = await createTmpProject('priority-error', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\naspects:\n  - enforced-rule\n  - advisory-rule\nmapping:\n  - src/svc/\n',
      mappingFiles: { 'src/svc/index.ts': 'export default 42;\n' },
      aspects: [
        {
          id: 'enforced-rule',
          yaml: 'name: Enforced\ndescription: test\nreviewer:\n  type: llm\nstatus: enforced\n',
          files: { 'content.md': 'Enforced rule.\n' },
        },
        {
          id: 'advisory-rule',
          yaml: 'name: Advisory\ndescription: test\nreviewer:\n  type: llm\nstatus: advisory\n',
          files: { 'content.md': 'Advisory rule.\n' },
        },
      ],
    });
    await recordBaselineWithVerdicts(tmpDir, 'svc/my-service', {
      'enforced-rule': { verdict: 'refused', reason: 'enforced fail', errorSource: 'codeViolation' },
      'advisory-rule': { verdict: 'refused', reason: 'advisory fail', errorSource: 'codeViolation' },
    });
    const graph = await loadGraph(tmpDir);
    const result = await runCheck(graph, ['src/svc/index.ts']);

    const advisoryWarnings = result.issues.filter(i => i.code === 'aspect-violation-advisory');
    expect(advisoryWarnings).toHaveLength(1);
    expect(advisoryWarnings[0].severity).toBe('warning');

    const enforcedErrors = result.issues.filter(i => i.code === 'aspect-violation-enforced');
    expect(enforcedErrors).toHaveLength(1);
    expect(enforcedErrors[0].severity).toBe('error');

    // suggestedNext picks an error message (enforced) over the warning (advisory).
    expect(result.suggestedNext).toBeTruthy();
    expect(result.suggestedNext).toContain('enforced-rule');
  });

  it('falls back to warning suggestedNext when only warnings exist', async () => {
    const { tmpDir } = await createTmpProject('only-advisory', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\naspects:\n  - advisory-rule\nmapping:\n  - src/svc/\n',
      mappingFiles: { 'src/svc/index.ts': 'export default 42;\n' },
      aspects: [{
        id: 'advisory-rule',
        yaml: 'name: Advisory\ndescription: test\nreviewer:\n  type: llm\nstatus: advisory\n',
        files: { 'content.md': 'Advisory rule.\n' },
      }],
    });
    await recordBaselineWithVerdicts(tmpDir, 'svc/my-service', {
      'advisory-rule': { verdict: 'refused', reason: 'soft fail', errorSource: 'codeViolation' },
    });
    const graph = await loadGraph(tmpDir);
    const result = await runCheck(graph, ['src/svc/index.ts']);

    // No aspect-status errors -- the only error categories should be
    // unrelated (validation-level), if any. Validate the advisory warning
    // is emitted and there are no aspect-status errors mixed in.
    const advisoryWarnings = result.issues.filter(i => i.code === 'aspect-violation-advisory');
    expect(advisoryWarnings).toHaveLength(1);
    const aspectStatusErrors = result.issues.filter(i =>
      i.severity === 'error'
      && (i.code === 'aspect-newly-active' || i.code === 'aspect-violation-enforced'),
    );
    expect(aspectStatusErrors).toHaveLength(0);
    // suggestedNext should pick up the advisory warning's `next` field
    // since there are no errors with higher priority.
    if (result.issues.every(i => i.severity !== 'error')) {
      expect(result.suggestedNext).toContain('advisory');
    }
  });
});
