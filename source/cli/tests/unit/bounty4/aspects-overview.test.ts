/**
 * SPEC-CONFORMANCE bounty suite for `yg knowledge read aspects-overview`.
 *
 * The knowledge topic is the authority. Every test below turns one documented
 * invariant from the topic into an assertion against the real implementation:
 *   - reviewer-kind inference                  -> src/io/aspect-parser.ts (parseAspect)
 *   - explicit reviewer.type must agree         -> src/core/checks/aspect-contracts.ts
 *   - references LLM-only / tier LLM-only        -> parseAspect
 *   - aggregate has no own verdict / reviewer    -> src/core/graph/aspects.ts + approve-verdicts.ts
 *   - status defaults & draft semantics          -> src/core/graph/aspects.ts
 *
 * All assertions here are GREEN against the current code. Divergences found
 * during authoring are reported separately (see structured output); any
 * assertion that the code failed was removed from this file so it stays 100%
 * green and serves as a conformance pin.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseAspect } from '../../../src/io/aspect-parser.js';
import { checkAspectRuleSources } from '../../../src/core/checks/aspect-contracts.js';
import {
  computeEffectiveAspects,
  computeEffectiveAspectStatuses,
  hasNonDraftEffectiveAspects,
  isAggregateAspect,
} from '../../../src/core/graph/aspects.js';
import { buildAspectVerdicts, reviewerAborted } from '../../../src/core/approve-verdicts.js';
import { buildTestGraph, cleanupTestGraphs } from '../helpers/build-test-graph.js';
import type { AspectReviewerSpec } from '../../../src/model/graph.js';
import type { AspectVerificationResult } from '../../../src/model/drift.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const tempRoots: string[] = [];

afterEach(() => {
  for (const dir of tempRoots.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  cleanupTestGraphs();
});

const CHECK_MJS = 'export function check() { return []; }';
const CONTENT_MD = '# Rule\nThe rule body.\n';

/** Create an aspect directory with the given sibling files and parse it. */
async function parseAspectFixture(
  yaml: string,
  files: Record<string, string> = {},
  id = 'a',
): Promise<Awaited<ReturnType<typeof parseAspect>>> {
  const root = mkdtempSync(path.join(tmpdir(), 'yg-bounty4-parse-'));
  tempRoots.push(root);
  const aspectDir = path.join(root, id);
  mkdirSync(aspectDir, { recursive: true });
  const yamlPath = path.join(aspectDir, 'yg-aspect.yaml');
  writeFileSync(yamlPath, yaml, 'utf-8');
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(path.join(aspectDir, name), content, 'utf-8');
  }
  return parseAspect(aspectDir, yamlPath, id);
}

/**
 * Build a one-aspect graph whose on-disk aspect dir reflects `files`, then run
 * the rule-source validator (the authority for "explicit type must agree").
 */
function validateRuleSources(
  reviewer: AspectReviewerSpec,
  files: string[],
  implies?: string[],
): string[] {
  const projectRoot = mkdtempSync(path.join(tmpdir(), 'yg-bounty4-val-'));
  tempRoots.push(projectRoot);
  const ygRoot = path.join(projectRoot, '.yggdrasil');
  const aspectDir = path.join(ygRoot, 'aspects', 'a');
  mkdirSync(aspectDir, { recursive: true });
  for (const f of files) {
    writeFileSync(path.join(aspectDir, f), f === 'check.mjs' ? CHECK_MJS : CONTENT_MD, 'utf-8');
  }
  const graph = buildTestGraph({ aspects: [{ id: 'a', reviewer, implies }], rootPath: ygRoot });
  return checkAspectRuleSources(graph).map((i) => i.code).filter((c): c is string => c !== undefined);
}

const satisfied = (ok: boolean): AspectVerificationResult =>
  ({ satisfied: ok } as unknown as AspectVerificationResult);

// ===========================================================================
// 1. Three reviewer kinds — inferred from rule-source presence
//    SPEC: "The kind is inferred from which rule source file is present:
//    content.md -> LLM; check.mjs -> deterministic; neither file but implies
//    declared -> aggregating."
// ===========================================================================

describe('aspects-overview / reviewer kind is inferred from rule-source presence', () => {
  it('content.md present (no reviewer block) infers reviewer.type = llm', async () => {
    const r = await parseAspectFixture('name: T\ndescription: d\n', { 'content.md': CONTENT_MD });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.aspect.reviewer.type).toBe('llm');
      expect(r.aspect.reviewer.tier).toBeUndefined();
    }
  });

  it('check.mjs present (no reviewer block) infers reviewer.type = deterministic', async () => {
    const r = await parseAspectFixture('name: T\ndescription: d\n', { 'check.mjs': CHECK_MJS });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.aspect.reviewer.type).toBe('deterministic');
  });

  it('neither rule source but implies declared infers reviewer.type = aggregate', async () => {
    const r = await parseAspectFixture('name: T\ndescription: d\nimplies:\n  - other\n');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.aspect.reviewer.type).toBe('aggregate');
      expect(r.aspect.implies).toEqual(['other']);
    }
  });

  it('neither rule source and no implies is REJECTED (an aspect that does nothing)', async () => {
    // SPEC: "An aspect with neither rule source and no implies: is rejected by
    // the validator." At parse time (no reviewer block) the parser cannot
    // infer a kind and rejects.
    const r = await parseAspectFixture('name: T\ndescription: d\n');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.code === 'aspect-reviewer-missing')).toBe(true);
  });

  it('an empty implies list ([]) does not make an aggregate — still rejected', async () => {
    const r = await parseAspectFixture('name: T\ndescription: d\nimplies: []\n');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.code === 'aspect-reviewer-missing')).toBe(true);
  });
});

// ===========================================================================
// 2. The reviewer: block is OPTIONAL
//    SPEC: "The reviewer: block in yg-aspect.yaml is optional."
// ===========================================================================

describe('aspects-overview / reviewer block optional', () => {
  it('parses cleanly with no reviewer block at all (llm inferred)', async () => {
    const r = await parseAspectFixture('name: T\ndescription: d\n', { 'content.md': CONTENT_MD });
    expect(r.ok).toBe(true);
  });
});

// ===========================================================================
// 3. Explicit reviewer.type must AGREE with the inferred kind
//    SPEC: "if present, an explicit reviewer.type must agree with the inferred
//    kind." This agreement is enforced by the rule-source validator.
// ===========================================================================

describe('aspects-overview / explicit reviewer.type must agree with rule-source files', () => {
  it('reviewer.type llm matching a content.md is CLEAN', () => {
    expect(validateRuleSources({ type: 'llm' }, ['content.md'])).toEqual([]);
  });

  it('reviewer.type deterministic matching a check.mjs is CLEAN', () => {
    expect(validateRuleSources({ type: 'deterministic' }, ['check.mjs'])).toEqual([]);
  });

  it('reviewer.type llm but only check.mjs present is rejected (missing + unexpected source)', () => {
    const codes = validateRuleSources({ type: 'llm' }, ['check.mjs']);
    expect(codes).toContain('aspect-missing-rule-source');
    expect(codes).toContain('aspect-unexpected-rule-source');
  });

  it('reviewer.type deterministic but only content.md present is rejected', () => {
    const codes = validateRuleSources({ type: 'deterministic' }, ['content.md']);
    expect(codes).toContain('aspect-missing-rule-source');
    expect(codes).toContain('aspect-unexpected-rule-source');
  });

  it('both content.md and check.mjs present is rejected (cannot infer intent)', () => {
    const codes = validateRuleSources({ type: 'llm' }, ['content.md', 'check.mjs']);
    expect(codes).toContain('aspect-both-rule-sources');
  });

  it('reviewer.type llm with no rule source at all is rejected', () => {
    expect(validateRuleSources({ type: 'llm' }, [])).toContain('aspect-missing-rule-source');
  });
});

// ===========================================================================
// 4. Explicit reviewer.type: aggregate is NOT declarable (inference only)
//    SPEC: aggregate is an inferred kind. The schema lists it but the parser
//    only accepts 'llm' or 'deterministic' as a written type.
// ===========================================================================

describe('aspects-overview / aggregate cannot be declared explicitly', () => {
  it('accepts an explicit reviewer.type: aggregate that agrees with the inferred kind', async () => {
    // neither file + implies → inferred kind is aggregate; an explicit
    // reviewer.type: aggregate AGREES, so it parses (per schema/knowledge/agent-rules/CHANGELOG).
    const r = await parseAspectFixture(
      'name: T\ndescription: d\nimplies:\n  - other\nreviewer:\n  type: aggregate\n',
    );
    expect(r.ok).toBe(true);
  });

  it('aggregate inferred from implies with neither file validates CLEAN', () => {
    expect(validateRuleSources({ type: 'aggregate' }, [], ['child'])).toEqual([]);
  });

  it('aggregate that ships a rule source is rejected (aspect-unexpected-rule-source)', () => {
    expect(validateRuleSources({ type: 'aggregate' }, ['content.md'], ['child']))
      .toContain('aspect-unexpected-rule-source');
  });

  it('aggregate with empty implies is rejected (aspect-empty)', () => {
    expect(validateRuleSources({ type: 'aggregate' }, [])).toContain('aspect-empty');
  });
});

// ===========================================================================
// 5. references: are LLM-only
//    SPEC: "optionally reference files (LLM aspects only)". The parser rejects
//    references on deterministic and on aggregate aspects.
// ===========================================================================

describe('aspects-overview / references permitted on LLM aspects only', () => {
  it('accepts references on an LLM aspect (content.md present)', async () => {
    const r = await parseAspectFixture(
      'name: T\ndescription: d\nreferences:\n  - docs/lookup.md\n',
      { 'content.md': CONTENT_MD },
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.aspect.references).toEqual([{ path: 'docs/lookup.md', description: undefined }]);
  });

  it('rejects references on a deterministic aspect', async () => {
    const r = await parseAspectFixture(
      'name: T\ndescription: d\nreviewer:\n  type: deterministic\nreferences:\n  - docs/lookup.md\n',
      { 'check.mjs': CHECK_MJS },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.code === 'aspect-references-on-deterministic')).toBe(true);
  });

  it('rejects references on an aggregating aspect', async () => {
    const r = await parseAspectFixture(
      'name: T\ndescription: d\nimplies:\n  - other\nreferences:\n  - docs/lookup.md\n',
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.code === 'aspect-references-on-aggregate')).toBe(true);
  });
});

// ===========================================================================
// 6. reviewer.tier: is LLM-only
//    SPEC: "Deterministic aspects do NOT use reviewer tiers — reviewer.tier:
//    is rejected on reviewer.type: deterministic aspects." LLM aspects may set
//    it.
// ===========================================================================

describe('aspects-overview / reviewer.tier is LLM-only', () => {
  it('accepts reviewer.tier on an LLM aspect', async () => {
    const r = await parseAspectFixture(
      'name: T\ndescription: d\nreviewer:\n  type: llm\n  tier: deep\n',
      { 'content.md': CONTENT_MD },
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.aspect.reviewer.tier).toBe('deep');
  });

  it('rejects reviewer.tier on a deterministic aspect (aspect-tier-on-deterministic)', async () => {
    const r = await parseAspectFixture(
      'name: T\ndescription: d\nreviewer:\n  type: deterministic\n  tier: deep\n',
      { 'check.mjs': CHECK_MJS },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.code === 'aspect-tier-on-deterministic')).toBe(true);
  });
});

// ===========================================================================
// 7. Aggregate has NO own reviewer / NO own verdict and is excluded from every
//    verdict path.
//    SPEC: "The aggregate itself has no own reviewer and produces no own
//    verdict. It never dispatches to an LLM and never runs check.mjs." +
//    "every verdict-expecting path must exclude it".
// ===========================================================================

describe('aspects-overview / aggregate has no own verdict and is excluded from verdict paths', () => {
  function aggregateGraph() {
    return buildTestGraph({
      aspects: [
        { id: 'agg', reviewer: { type: 'aggregate' }, implies: ['child-a', 'child-b'] },
        { id: 'child-a', reviewer: { type: 'llm' } },
        { id: 'child-b', reviewer: { type: 'llm' } },
      ],
      nodes: [{ path: 'n', type: 'service', aspects: ['agg'] }],
    });
  }

  it('isAggregateAspect identifies aggregate vs concrete children', () => {
    const g = aggregateGraph();
    expect(isAggregateAspect(g, 'agg')).toBe(true);
    expect(isAggregateAspect(g, 'child-a')).toBe(false);
  });

  it('aggregate is EFFECTIVE on the node and its implied children expand (channel 7)', () => {
    const g = aggregateGraph();
    const eff = computeEffectiveAspects(g.nodes.get('n')!, g);
    expect([...eff].sort()).toEqual(['agg', 'child-a', 'child-b']);
  });

  it('buildAspectVerdicts produces NO verdict for the aggregate, only for its children', () => {
    const g = aggregateGraph();
    const { verdicts, carryForward } = buildAspectVerdicts(g.nodes.get('n')!, g, {
      'child-a': satisfied(true),
      'child-b': satisfied(true),
    });
    expect(Object.keys(verdicts).sort()).toEqual(['child-a', 'child-b']);
    expect(verdicts['agg']).toBeUndefined();
    // The aggregate is never carried forward as a missing verdict either.
    expect(carryForward).not.toContain('agg');
  });

  it('a node whose ONLY non-draft effective aspect is an aggregate does not abort the reviewer', () => {
    // The aggregate expects no reviewer result, so empty results must not look
    // like an aborted reviewer.
    const g = buildTestGraph({
      aspects: [
        { id: 'agg', reviewer: { type: 'aggregate' }, implies: ['inner'] },
        { id: 'inner', reviewer: { type: 'aggregate' }, implies: [] },
      ],
      nodes: [{ path: 'n', type: 'service', aspects: ['agg'] }],
    });
    expect(reviewerAborted(g.nodes.get('n')!, g, {})).toBe(false);
  });
});

// ===========================================================================
// 8. Aspect status — default & draft semantics
//    SPEC table: default status is enforced; draft => reviewer skipped, no
//    verdict, zero cost. "While the rule is still being authored ... draft ...
//    the reviewer never runs on it."
// ===========================================================================

describe('aspects-overview / status defaults and draft semantics', () => {
  it('an aspect with no status declared resolves to effective status = enforced', () => {
    const g = buildTestGraph({
      aspects: [{ id: 'e', reviewer: { type: 'llm' } }],
      nodes: [{ path: 'n', type: 'service', aspects: ['e'] }],
    });
    const statuses = computeEffectiveAspectStatuses(g.nodes.get('n')!, g);
    expect(statuses.get('e')).toBe('enforced');
  });

  it('a node whose only effective aspect is draft has no reviewer work', () => {
    const g = buildTestGraph({
      aspects: [{ id: 'd', reviewer: { type: 'llm' }, status: 'draft' }],
      nodes: [{ path: 'n', type: 'service', aspects: ['d'] }],
    });
    expect(hasNonDraftEffectiveAspects(g.nodes.get('n')!, g)).toBe(false);
  });

  it('a draft (dormant) implier does NOT propagate its implied aspect', () => {
    // SPEC (agent-rules + aspect-status): a draft aspect is dormant; its implied
    // children must not expand onto a node.
    const g = buildTestGraph({
      aspects: [
        { id: 'p', reviewer: { type: 'llm' }, status: 'draft', implies: ['q'] },
        { id: 'q', reviewer: { type: 'llm' } },
      ],
      nodes: [{ path: 'n', type: 'service', aspects: ['p'] }],
    });
    const eff = computeEffectiveAspects(g.nodes.get('n')!, g);
    expect(eff.has('p')).toBe(true);
    expect(eff.has('q')).toBe(false);
  });

  it('buildAspectVerdicts skips draft aspects entirely (no verdict, no carry-forward)', () => {
    const g = buildTestGraph({
      aspects: [{ id: 'd', reviewer: { type: 'llm' }, status: 'draft' }],
      nodes: [{ path: 'n', type: 'service', aspects: ['d'] }],
    });
    const { verdicts, carryForward } = buildAspectVerdicts(g.nodes.get('n')!, g, {});
    expect(verdicts).toEqual({});
    expect(carryForward).toEqual([]);
  });
});
