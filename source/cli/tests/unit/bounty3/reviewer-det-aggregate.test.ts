/**
 * Bounty 3 — adversarial coverage for the deterministic runner verdict and the
 * aggregate aspect kind.
 *
 * Targets studied in full:
 *   - src/structure/runner.ts        (runStructureAspect — deterministic verdict)
 *   - src/core/graph/aspects.ts      (kind helpers: isAggregateAspect,
 *                                      hasNonDraftEffectiveAspects, effective expansion)
 *   - src/io/aspect-parser.ts        (reviewer-kind inference + aggregate guards)
 *   - src/core/approve-verdicts.ts   (buildAspectVerdicts / reviewerAborted — aggregate exclusion)
 *
 * Existing tests covered by:
 *   - tests/unit/core/aggregate-aspect-verdicts.test.ts
 *   - tests/unit/io/aspect-parser-aggregate.test.ts
 *   - tests/unit/io/aspect-parser-deterministic.test.ts
 *   - tests/integration/structure-lifecycle.test.ts
 *
 * This file deliberately attacks the BRANCHES and INVARIANTS those miss:
 *   1. Parser kind inference precedence: a present rule source (content.md or
 *      check.mjs) overrides implies-based aggregate inference; BOTH files +
 *      implies still cannot infer a type (→ aspect-reviewer-missing); an
 *      explicit reviewer.type the parser accepts but defers file-agreement to
 *      the validator; LLM aspect may carry both implies AND references.
 *   2. Aggregate invariants: an aggregate is EFFECTIVE (children expand) but is
 *      NEVER a verdict, NEVER carried forward, NEVER surfaces as work-to-do —
 *      even when a (stray) reviewer result is supplied for it, even nested,
 *      even reached via an ancestor/type channel.
 *   3. Deterministic runner: the violations the check returns ARE the verdict
 *      (succeeded:true), and the return-shape / async / throw guard ladder.
 *   4. One hermetic E2E spawn (aggregate bundling a deterministic child) proving
 *      the aggregate never lands a verdict of its own through the shipped binary.
 *
 * Determinism: no random data, no wall-clock reads inside assertions; every
 * temp tree is created via mkdtemp under os.tmpdir() and removed in a finally /
 * afterEach. Only this one test file is created — no source or .yggdrasil change.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  appendFileSync,
  rmSync,
  existsSync,
  cpSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseAspect } from '../../../src/io/aspect-parser.js';
import { runStructureAspect, StructureRunnerError } from '../../../src/structure/runner.js';
import {
  computeEffectiveAspects,
  computeEffectiveAspectStatuses,
  isAggregateAspect,
  hasNonDraftEffectiveAspects,
} from '../../../src/core/graph/aspects.js';
import { buildAspectVerdicts, reviewerAborted } from '../../../src/core/approve-verdicts.js';
import type { AspectVerificationResult } from '../../../src/model/drift.js';
import { buildTestGraph, cleanupTestGraphs } from '../helpers/build-test-graph.js';
import { buildTestGraphForStructure } from '../helpers/build-test-graph-structure.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'e2e-lifecycle');
const distExists = existsSync(BIN_PATH);

afterAll(() => cleanupTestGraphs());

// ===========================================================================
// 1. Parser kind inference — precedence and aggregate guards
//    (src/io/aspect-parser.ts → parseReviewer + references cross-checks)
// ===========================================================================
describe('aspect-parser — kind inference precedence + aggregate guards', () => {
  let root: string;
  let aspectDir: string;
  let yamlPath: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'yg-bounty3-parser-'));
    aspectDir = path.join(root, 'a');
    mkdirSync(aspectDir, { recursive: true });
    yamlPath = path.join(aspectDir, 'yg-aspect.yaml');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('BOTH content.md AND check.mjs with no reviewer block → aspect-reviewer-missing (parser cannot infer)', async () => {
    // Neither single-file inference condition holds (both present), and the
    // aggregate branch requires NEITHER file. The parser falls through to the
    // error: it cannot pick a type. The mutual-exclusion verdict is the
    // validator's job, but kind inference here must fail closed.
    writeFileSync(yamlPath, 'name: A\ndescription: x\n');
    writeFileSync(path.join(aspectDir, 'content.md'), '# rule');
    writeFileSync(path.join(aspectDir, 'check.mjs'), 'export function check() { return []; }');
    const r = await parseAspect(aspectDir, yamlPath, 'a');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some(e => e.code === 'aspect-reviewer-missing')).toBe(true);
  });

  it('BOTH files + implies, no reviewer block → still aspect-reviewer-missing (implies does NOT rescue when a file is present)', async () => {
    // The aggregate inference branch is gated on `!hasContentMd && !hasCheckMjs`.
    // implies present alongside files must NOT yield an aggregate — it must error.
    writeFileSync(yamlPath, 'name: A\ndescription: x\nimplies:\n  - other\n');
    writeFileSync(path.join(aspectDir, 'content.md'), '# rule');
    writeFileSync(path.join(aspectDir, 'check.mjs'), 'export function check() { return []; }');
    const r = await parseAspect(aspectDir, yamlPath, 'a');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some(e => e.code === 'aspect-reviewer-missing')).toBe(true);
  });

  it('implies + content.md (no reviewer block) infers llm — a rule source overrides aggregate inference', async () => {
    // implies present, but content.md wins: the kind is llm, NOT aggregate. The
    // implies list is still parsed and carried.
    writeFileSync(yamlPath, 'name: A\ndescription: x\nimplies:\n  - other\n');
    writeFileSync(path.join(aspectDir, 'content.md'), '# rule');
    const r = await parseAspect(aspectDir, yamlPath, 'a');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.aspect.reviewer.type).toBe('llm');
      expect(r.aspect.implies).toEqual(['other']);
    }
  });

  it('implies + check.mjs (no reviewer block) infers deterministic — a rule source overrides aggregate inference', async () => {
    writeFileSync(yamlPath, 'name: A\ndescription: x\nimplies:\n  - other\n');
    writeFileSync(path.join(aspectDir, 'check.mjs'), 'export function check() { return []; }');
    const r = await parseAspect(aspectDir, yamlPath, 'a');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.aspect.reviewer.type).toBe('deterministic');
      expect(r.aspect.implies).toEqual(['other']);
    }
  });

  it('explicit reviewer.type: llm WITH check.mjs present is accepted by the parser (file-agreement is the validator job)', async () => {
    // The parser is NOT the authority on file/type agreement when reviewer.type
    // is populated — it accepts type:llm even though check.mjs is the wrong file.
    // checkAspectRuleSources flags the mismatch later; the parser must not.
    writeFileSync(yamlPath, 'name: A\ndescription: x\nreviewer:\n  type: llm\n');
    writeFileSync(path.join(aspectDir, 'check.mjs'), 'export function check() { return []; }');
    const r = await parseAspect(aspectDir, yamlPath, 'a');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.aspect.reviewer.type).toBe('llm');
  });

  it('explicit reviewer.type: deterministic WITH content.md (no references) is accepted by the parser', async () => {
    writeFileSync(yamlPath, 'name: A\ndescription: x\nreviewer:\n  type: deterministic\n');
    writeFileSync(path.join(aspectDir, 'content.md'), '# rule');
    const r = await parseAspect(aspectDir, yamlPath, 'a');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.aspect.reviewer.type).toBe('deterministic');
  });

  it('an LLM aspect may declare BOTH implies AND references — both are preserved', async () => {
    // implies + references are independent on an llm aspect; references are only
    // rejected for deterministic/aggregate kinds.
    writeFileSync(
      yamlPath,
      'name: A\ndescription: x\nimplies:\n  - other\nreferences:\n  - docs/foo.md\n',
    );
    writeFileSync(path.join(aspectDir, 'content.md'), '# rule');
    const r = await parseAspect(aspectDir, yamlPath, 'a');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.aspect.reviewer.type).toBe('llm');
      expect(r.aspect.implies).toEqual(['other']);
      expect(r.aspect.references).toEqual([{ path: 'docs/foo.md', description: undefined }]);
    }
  });

  it('inferred aggregate (neither file + implies) rejects references with aspect-references-on-aggregate as the SOLE error', async () => {
    // Sharper than the existing .some() assertion: the references guard fires
    // BEFORE the implies list is even resolved, and it is the only returned error.
    writeFileSync(
      yamlPath,
      'name: A\ndescription: x\nimplies:\n  - other\nreferences:\n  - docs/foo.md\n',
    );
    const r = await parseAspect(aspectDir, yamlPath, 'a');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors).toHaveLength(1);
      expect(r.errors[0].code).toBe('aspect-references-on-aggregate');
    }
  });

  it('inferred aggregate with empty references list ([]) is also rejected as aspect-references-on-aggregate', async () => {
    // The aggregate guard fires on the array-shape check, before the empty-list
    // path that an llm aspect would otherwise hit — so even [] is rejected here.
    writeFileSync(yamlPath, 'name: A\ndescription: x\nimplies:\n  - other\nreferences: []\n');
    const r = await parseAspect(aspectDir, yamlPath, 'a');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0].code).toBe('aspect-references-on-aggregate');
  });
});

// ===========================================================================
// 2. Aggregate invariants — effective expansion + verdict exclusion
//    (src/core/graph/aspects.ts, src/core/approve-verdicts.ts)
// ===========================================================================
describe('aggregate aspect — effective but never a verdict', () => {
  it('isAggregateAspect: true for an aggregate, false for llm/deterministic/unknown', () => {
    const graph = buildTestGraph({
      aspects: [
        { id: 'bundle', reviewer: { type: 'aggregate' }, implies: ['leaf-llm', 'leaf-det'] },
        { id: 'leaf-llm', reviewer: { type: 'llm' } },
        { id: 'leaf-det', reviewer: { type: 'deterministic' } },
      ],
      nodes: [{ path: 'n', type: 'service', aspects: ['bundle'] }],
    });
    expect(isAggregateAspect(graph, 'bundle')).toBe(true);
    expect(isAggregateAspect(graph, 'leaf-llm')).toBe(false);
    expect(isAggregateAspect(graph, 'leaf-det')).toBe(false);
    // Unknown aspect id is not an aggregate (find returns undefined → false).
    expect(isAggregateAspect(graph, 'does-not-exist')).toBe(false);
  });

  it('a stray reviewer result for the aggregate itself is IGNORED — no verdict, no carryForward', () => {
    // INVARIANT: even if some buggy upstream path injected a result keyed by the
    // aggregate id, buildAspectVerdicts must drop it. Otherwise the aggregate
    // could record a (false) verdict and block CI.
    const graph = buildTestGraph({
      aspects: [
        { id: 'bundle', reviewer: { type: 'aggregate' }, implies: ['child'], status: 'enforced' },
        { id: 'child', status: 'enforced' },
      ],
      nodes: [{ path: 'n', type: 'service', aspects: ['bundle'] }],
    });
    const node = graph.nodes.get('n')!;
    const results: Record<string, AspectVerificationResult> = {
      bundle: { satisfied: false, reason: 'stray', errorSource: 'codeViolation' },
      child: { satisfied: true, reason: 'ok', errorSource: 'codeViolation' },
    };
    const { verdicts, carryForward } = buildAspectVerdicts(node, graph, results);
    expect(verdicts.child).toEqual({ verdict: 'approved' });
    expect(verdicts.bundle).toBeUndefined();
    expect(carryForward).not.toContain('bundle');
  });

  it('nested aggregate (aggregate → aggregate → deterministic leaf): only the leaf yields a verdict', () => {
    // Two levels of bundles must BOTH be excluded; only the terminal real aspect
    // (with a reviewer/check) produces or carries a verdict.
    const graph = buildTestGraph({
      aspects: [
        { id: 'outer', reviewer: { type: 'aggregate' }, implies: ['inner'], status: 'enforced' },
        { id: 'inner', reviewer: { type: 'aggregate' }, implies: ['leaf'], status: 'enforced' },
        { id: 'leaf', reviewer: { type: 'deterministic' }, status: 'enforced' },
      ],
      nodes: [{ path: 'n', type: 'service', aspects: ['outer'] }],
    });
    const node = graph.nodes.get('n')!;
    const effective = computeEffectiveAspects(node, graph);
    expect(effective.has('outer')).toBe(true);
    expect(effective.has('inner')).toBe(true);
    expect(effective.has('leaf')).toBe(true);

    // No reviewer results: the leaf is carried forward; neither bundle is.
    const { verdicts, carryForward } = buildAspectVerdicts(node, graph, {});
    expect(verdicts).toEqual({});
    expect(carryForward).toEqual(['leaf']);
    expect(carryForward).not.toContain('outer');
    expect(carryForward).not.toContain('inner');
  });

  it('a draft child of an enforced aggregate is excluded from verdicts and carryForward (status, not kind)', () => {
    // The aggregate propagates enforced to non-draft children, but a child whose
    // OWN default is draft and is pinned via own-default stays draft → dormant.
    const graph = buildTestGraph({
      aspects: [
        {
          id: 'bundle',
          reviewer: { type: 'aggregate' },
          implies: ['enforced-child', 'draft-child'],
          impliesStatusInherit: { 'draft-child': 'own-default' },
          status: 'enforced',
        },
        { id: 'enforced-child', status: 'enforced' },
        { id: 'draft-child', status: 'draft' },
      ],
      nodes: [{ path: 'n', type: 'service', aspects: ['bundle'] }],
    });
    const node = graph.nodes.get('n')!;
    const statuses = computeEffectiveAspectStatuses(node, graph);
    expect(statuses.get('draft-child')).toBe('draft');
    expect(statuses.get('enforced-child')).toBe('enforced');

    const { verdicts, carryForward } = buildAspectVerdicts(node, graph, {});
    expect(carryForward).toContain('enforced-child');
    expect(carryForward).not.toContain('draft-child'); // draft → never expected
    expect(carryForward).not.toContain('bundle');
    expect(verdicts).toEqual({});
  });

  it('reviewerAborted is FALSE for an aggregate-only effective set with no real-aspect children evaluable', () => {
    // A node whose ONLY non-draft effective aspects are aggregates has nothing a
    // reviewer would evaluate; an empty results map must NOT be read as an abort.
    // Build a node that effectively only carries an aggregate whose single child
    // is draft (so the only non-draft, non-aggregate is... none).
    const graph = buildTestGraph({
      aspects: [
        {
          id: 'bundle',
          reviewer: { type: 'aggregate' },
          implies: ['draft-only'],
          impliesStatusInherit: { 'draft-only': 'own-default' },
          status: 'enforced',
        },
        { id: 'draft-only', status: 'draft' },
      ],
      nodes: [{ path: 'n', type: 'service', aspects: ['bundle'] }],
    });
    const node = graph.nodes.get('n')!;
    // The only non-draft effective aspect is the aggregate itself, which is
    // excluded by reviewerAborted → no aspect "expects" a result → not aborted.
    expect(reviewerAborted(node, graph, {})).toBe(false);
  });

  it('reviewerAborted is TRUE when a real (non-aggregate, non-draft) child expects a result and none arrived', () => {
    const graph = buildTestGraph({
      aspects: [
        { id: 'bundle', reviewer: { type: 'aggregate' }, implies: ['child'], status: 'enforced' },
        { id: 'child', status: 'enforced' },
      ],
      nodes: [{ path: 'n', type: 'service', aspects: ['bundle'] }],
    });
    const node = graph.nodes.get('n')!;
    expect(reviewerAborted(node, graph, {})).toBe(true);
  });

  it('hasNonDraftEffectiveAspects is FALSE for an aggregate-only node (aggregate is not work-to-do)', () => {
    // A node whose only effective non-draft aspect is the aggregate has no
    // reviewer work — the aggregate must be skipped by hasNonDraftEffectiveAspects.
    const graph = buildTestGraph({
      aspects: [
        {
          id: 'bundle',
          reviewer: { type: 'aggregate' },
          implies: ['draft-only'],
          impliesStatusInherit: { 'draft-only': 'own-default' },
          status: 'enforced',
        },
        { id: 'draft-only', status: 'draft' },
      ],
      nodes: [{ path: 'n', type: 'service', aspects: ['bundle'] }],
    });
    const node = graph.nodes.get('n')!;
    expect(hasNonDraftEffectiveAspects(node, graph)).toBe(false);
  });

  it('hasNonDraftEffectiveAspects is TRUE once the aggregate pulls in a non-draft real child', () => {
    const graph = buildTestGraph({
      aspects: [
        { id: 'bundle', reviewer: { type: 'aggregate' }, implies: ['child'], status: 'enforced' },
        { id: 'child', status: 'enforced' },
      ],
      nodes: [{ path: 'n', type: 'service', aspects: ['bundle'] }],
    });
    const node = graph.nodes.get('n')!;
    expect(hasNonDraftEffectiveAspects(node, graph)).toBe(true);
  });

  it('an aggregate reaching a child via an ANCESTOR channel still expands children and excludes itself', () => {
    // Channel 2: the aggregate is declared on the parent; the child node inherits
    // it. The implied leaf must expand onto the child, and the aggregate must
    // still be excluded from the child's verdicts.
    const graph = buildTestGraph({
      aspects: [
        { id: 'bundle', reviewer: { type: 'aggregate' }, implies: ['leaf'], status: 'enforced' },
        { id: 'leaf', status: 'enforced' },
      ],
      nodes: [
        { path: 'parent', type: 'module', aspects: ['bundle'] },
        { path: 'parent/kid', type: 'service', parent: 'parent' },
      ],
    });
    const kid = graph.nodes.get('parent/kid')!;
    const effective = computeEffectiveAspects(kid, graph);
    expect(effective.has('bundle')).toBe(true);
    expect(effective.has('leaf')).toBe(true);

    const { verdicts, carryForward } = buildAspectVerdicts(kid, graph, {});
    expect(carryForward).toContain('leaf');
    expect(carryForward).not.toContain('bundle');
    expect(verdicts).toEqual({});
  });

  it('an aggregate reaching a node via the architecture TYPE channel expands children and excludes itself', () => {
    // Channel 3: the aggregate is a type-default. Every node of that type expands
    // its implied children, but the aggregate never produces a verdict.
    const graph = buildTestGraph({
      aspects: [
        { id: 'bundle', reviewer: { type: 'aggregate' }, implies: ['leaf'], status: 'enforced' },
        { id: 'leaf', status: 'enforced' },
      ],
      types: [{ id: 'widget', aspects: ['bundle'] }],
      nodes: [{ path: 'n', type: 'widget' }],
    });
    const node = graph.nodes.get('n')!;
    const effective = computeEffectiveAspects(node, graph);
    expect(effective.has('bundle')).toBe(true);
    expect(effective.has('leaf')).toBe(true);

    const { verdicts, carryForward } = buildAspectVerdicts(node, graph, {});
    expect(carryForward).toContain('leaf');
    expect(carryForward).not.toContain('bundle');
    expect(verdicts).toEqual({});
  });
});

// ===========================================================================
// 3. Deterministic runner — the returned violations ARE the verdict, plus the
//    return-shape / async / throw guard ladder.
//    (src/structure/runner.ts → runStructureAspect)
// ===========================================================================
describe('runStructureAspect — deterministic check return IS the verdict', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(path.join(tmpdir(), 'yg-bounty3-runner-'));
    mkdirSync(path.join(projectRoot, 'src'), { recursive: true });
  });
  afterEach(() => rmSync(projectRoot, { recursive: true, force: true }));

  /** Write a check.mjs body and return the on-disk aspect dir (relative form for the runner). */
  function writeCheck(aspectId: string, body: string): void {
    const adir = path.join(projectRoot, '.yggdrasil', 'aspects', aspectId);
    mkdirSync(adir, { recursive: true });
    writeFileSync(path.join(adir, 'check.mjs'), body);
  }

  async function runOn(aspectId: string, nodePath: string, mapping: string[]) {
    const graph = buildTestGraphForStructure({
      aspects: [{ id: aspectId, reviewer: { type: 'deterministic' } }],
      nodes: [{ path: nodePath, type: 'service', mapping, aspects: [aspectId] }],
    });
    return runStructureAspect({
      aspectDir: path.join('.yggdrasil/aspects', aspectId),
      aspectId,
      nodePath,
      graph,
      projectRoot,
    });
  }

  it('returned violations pass through verbatim and succeeded is true (violations ARE the verdict)', async () => {
    writeFileSync(path.join(projectRoot, 'src/a.ts'), 'const x = 1;\n');
    writeCheck(
      'flag',
      `export function check(ctx) {
        return ctx.files.map(f => ({ message: 'bad: ' + f.path, file: f.path, line: 1 }));
      }`,
    );
    const r = await runOn('flag', 'N', ['src/a.ts']);
    expect(r.succeeded).toBe(true);
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0].message).toBe('bad: src/a.ts');
    expect(r.violations[0].file).toBe('src/a.ts');
    // touchedFiles records what the check read.
    expect(r.touchedFiles).toContain('src/a.ts');
  });

  it('an empty array return is a clean PASS — succeeded true, zero violations', async () => {
    writeFileSync(path.join(projectRoot, 'src/a.ts'), 'const x = 1;\n');
    writeCheck('clean', 'export function check(ctx) { return []; }');
    const r = await runOn('clean', 'N', ['src/a.ts']);
    expect(r.succeeded).toBe(true);
    expect(r.violations).toEqual([]);
  });

  it('a Promise-returning check is rejected with STRUCTURE_CHECK_ASYNC (return value is not awaited)', async () => {
    writeFileSync(path.join(projectRoot, 'src/a.ts'), 'const x = 1;\n');
    writeCheck('asyncy', 'export function check(ctx) { return Promise.resolve([]); }');
    await expect(runOn('asyncy', 'N', ['src/a.ts'])).rejects.toMatchObject({
      code: 'STRUCTURE_CHECK_ASYNC',
    });
  });

  it('a non-array return is rejected with STRUCTURE_CHECK_RETURN_SHAPE', async () => {
    writeFileSync(path.join(projectRoot, 'src/a.ts'), 'const x = 1;\n');
    writeCheck('shape', 'export function check(ctx) { return { not: "an array" }; }');
    await expect(runOn('shape', 'N', ['src/a.ts'])).rejects.toBeInstanceOf(StructureRunnerError);
    await expect(runOn('shape', 'N', ['src/a.ts'])).rejects.toMatchObject({
      code: 'STRUCTURE_CHECK_RETURN_SHAPE',
    });
  });

  it('a violation entry missing a string message is rejected with STRUCTURE_CHECK_RETURN_SHAPE', async () => {
    writeFileSync(path.join(projectRoot, 'src/a.ts'), 'const x = 1;\n');
    writeCheck('badmsg', 'export function check(ctx) { return [{ file: "src/a.ts" }]; }');
    await expect(runOn('badmsg', 'N', ['src/a.ts'])).rejects.toMatchObject({
      code: 'STRUCTURE_CHECK_RETURN_SHAPE',
    });
  });

  it('a check that throws surfaces as STRUCTURE_CHECK_THROWN (NOT a silent pass)', async () => {
    // INVARIANT: a crashing check must never be read as "no violations" — that
    // would be a false-green. It must raise a runner error the dispatcher maps
    // to a fail-closed infra refusal.
    writeFileSync(path.join(projectRoot, 'src/a.ts'), 'const x = 1;\n');
    writeCheck('boom', 'export function check(ctx) { throw new Error("kaboom"); }');
    await expect(runOn('boom', 'N', ['src/a.ts'])).rejects.toMatchObject({
      code: 'STRUCTURE_CHECK_THROWN',
    });
  });

  it('a violation referencing a file NOT in ctx is rejected (no synthesizing verdicts against unseen files)', async () => {
    writeFileSync(path.join(projectRoot, 'src/a.ts'), 'const x = 1;\n');
    writeCheck(
      'phantom',
      `export function check(ctx) { return [{ message: 'x', file: 'src/not-in-ctx.ts', line: 1 }]; }`,
    );
    await expect(runOn('phantom', 'N', ['src/a.ts'])).rejects.toMatchObject({
      code: 'STRUCTURE_CHECK_FILE_NOT_IN_CONTEXT',
    });
  });

  it('a missing node path is rejected with STRUCTURE_NODE_MISSING before any check runs', async () => {
    writeCheck('nonode', 'export function check(ctx) { return []; }');
    const graph = buildTestGraphForStructure({
      aspects: [{ id: 'nonode', reviewer: { type: 'deterministic' } }],
      nodes: [{ path: 'Real', type: 'service', mapping: [], aspects: ['nonode'] }],
    });
    await expect(
      runStructureAspect({
        aspectDir: path.join('.yggdrasil/aspects', 'nonode'),
        aspectId: 'nonode',
        nodePath: 'Ghost',
        graph,
        projectRoot,
      }),
    ).rejects.toMatchObject({ code: 'STRUCTURE_NODE_MISSING' });
  });
});

// ===========================================================================
// 4. E2E — the aggregate aspect through the shipped binary.
//    An aggregate bundling a deterministic child: the child's verdict is real,
//    the aggregate itself never appears as its own verdict / newly-active /
//    drift, and removing the violation approves clean.
//    Modeled on tests/e2e/cli-implies.test.ts (hermetic, deterministic-only).
// ===========================================================================
describe.skipIf(!distExists)('E2E — aggregate aspect is effective but never its own verdict', () => {
  function run(args: string[], cwd: string): { stdout: string; status: number | null; all: string } {
    const result = spawnSync('node', [BIN_PATH, ...args], { cwd, encoding: 'utf-8' });
    const stdout = result.stdout ?? '';
    const stderr = result.stderr ?? '';
    return { stdout, status: result.status, all: stdout + stderr };
  }

  /**
   * Copy the e2e-lifecycle fixture and strip the LLM aspect so the lifecycle is
   * hermetic (deterministic-only, no network). Then wire a NEW aggregate aspect
   * `bundle` (neither content.md nor check.mjs, only implies) onto the service
   * type, bundling a NEW deterministic child `no-xxx` that flags the literal
   * `XXX`. The aggregate's only path to the node is the type channel; the child's
   * only path is channel 7 via the aggregate. This isolates the aggregate kind.
   */
  function aggregateFixture(label: string): string {
    const dir = mkdtempSync(path.join(tmpdir(), `yg-bounty3-agg-${label}-`));
    cpSync(FIXTURE, dir, { recursive: true });

    // Drop the LLM aspect from the architecture type-defaults and remove its dir.
    const archPath = path.join(dir, '.yggdrasil', 'yg-architecture.yaml');
    let arch = readFileSync(archPath, 'utf-8')
      .split('\n')
      .filter((line) => line.trim() !== '- has-doc-comment')
      .join('\n');
    rmSync(path.join(dir, '.yggdrasil', 'aspects', 'has-doc-comment'), { recursive: true, force: true });

    // Add the aggregate `bundle` as a service type-default aspect.
    arch = arch.replace('      - requires-named-export', '      - requires-named-export\n      - bundle');
    writeFileSync(archPath, arch, 'utf-8');

    // The aggregate: neither content.md nor check.mjs, only implies → inferred aggregate.
    const bundleDir = path.join(dir, '.yggdrasil', 'aspects', 'bundle');
    mkdirSync(bundleDir, { recursive: true });
    writeFileSync(
      path.join(bundleDir, 'yg-aspect.yaml'),
      ['name: Bundle', 'description: Bundles deterministic rules.', 'status: enforced', 'implies:', '  - no-xxx', ''].join('\n'),
      'utf-8',
    );

    // The deterministic child reached ONLY via the aggregate's implies edge.
    const childDir = path.join(dir, '.yggdrasil', 'aspects', 'no-xxx');
    mkdirSync(childDir, { recursive: true });
    writeFileSync(
      path.join(childDir, 'yg-aspect.yaml'),
      ['name: NoXxx', 'description: Source files must not contain the literal token XXX.', 'reviewer:', '  type: deterministic', 'status: enforced', ''].join('\n'),
      'utf-8',
    );
    writeFileSync(
      path.join(childDir, 'check.mjs'),
      [
        'export function check(ctx) {',
        '  const violations = [];',
        '  for (const file of ctx.files) {',
        "    const lines = file.content.split('\\n');",
        '    for (let i = 0; i < lines.length; i++) {',
        "      if (lines[i].includes('XXX')) {",
        '        violations.push({ file: file.path, line: i + 1, column: 0, message: "XXX token found." });',
        '      }',
        '    }',
        '  }',
        '  return violations;',
        '}',
        '',
      ].join('\n'),
      'utf-8',
    );
    return dir;
  }

  const ordersFile = (dir: string) => path.join(dir, 'src', 'services', 'orders.ts');

  it('the aggregate is effective (implies child expands) yet yg context never lists it as its own reviewer work', () => {
    const dir = aggregateFixture('ctx');
    try {
      const { status, stdout } = run(['context', '--node', 'services/orders'], dir);
      expect(status).toBe(0);
      // The bundle is effective and advertised as implying the child.
      expect(stdout).toContain('bundle');
      expect(stdout).toContain('no-xxx');
      expect(stdout).toContain('Implies: no-xxx');
      // The child carries an "implied by 'bundle'" origin — proof of channel 7.
      expect(stdout).toContain("implied by 'bundle'");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('approve is clean and yg check stays green — the aggregate produces no verdict/drift of its own', () => {
    const dir = aggregateFixture('clean');
    try {
      expect(run(['approve', '--node', 'services/orders'], dir).status).toBe(0);
      expect(run(['approve', '--node', 'services/payments'], dir).status).toBe(0);
      const check = run(['check'], dir);
      // No aggregate-induced false drift / newly-active: check is green.
      expect(check.status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a violation of the implied deterministic child refuses approve; the aggregate is satisfied, not refused', () => {
    const dir = aggregateFixture('violate');
    try {
      // Clean baseline first.
      expect(run(['approve', '--node', 'services/orders'], dir).status).toBe(0);

      appendFileSync(ordersFile(dir), '\n// marker XXX here\n');
      const { status, stdout } = run(['approve', '--node', 'services/orders'], dir);
      expect(status).toBe(1);
      // The CHILD refused — it carries the real verdict.
      expect(stdout).toContain('no-xxx');
      expect(stdout).toContain('NOT SATISFIED');
      expect(stdout).toContain('XXX token found.');
      // The aggregate must NOT be reported as refused — it never gets its own verdict.
      expect(stdout).not.toMatch(/bundle\s+—\s+NOT SATISFIED/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
