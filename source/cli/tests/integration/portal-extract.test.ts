import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadGraph } from '../../src/core/graph-loader.js';
import { runCheck, type CheckResult } from '../../src/core/check.js';
import { computeExpectedPairs, type ExpectedPair } from '../../src/core/pairs.js';
import { walkRepoFiles } from '../../src/io/repo-scanner.js';
import { extractPortalData, buildCounts } from '../../src/portal/extract.js';
import {
  computePortalBoundary,
  scanPortalSuppressions,
} from '../../src/portal/engine-api.js';
import type { PortalData } from '../../src/portal/contract.js';
import type { VerifiedPair, PairState } from '../../src/core/verify-lock.js';
import type { Graph } from '../../src/model/graph.js';
import { nodeUnit } from '../../src/model/lock.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// The REAL repo root (real .yggdrasil/ graph + real source). tests/integration → cli → source → repo.
const REPO_ROOT = path.resolve(__dirname, '../../../..');

// The acceptance invariant (the count-parity GATE): every count the portal emits is
// DERIVED by reusing the CLI's own read-only functions — never a literal, never a
// re-implementation — so it can never diverge from `yg check`. Asserted on the REAL
// repo graph: this is an integration test against a real .yggdrasil/ + real source.
// runCheck over the whole repo (parse + relation pass) is heavy, so the extraction and
// the independent recomputation are each done once and shared.

describe('portal extraction — count parity with yg check (the trust core)', () => {
  let data: PortalData;
  let errors: number;
  let warnings: number;
  let checkCovered: number;
  let checkTotal: number;
  let expectedPairCount: number;
  let nodeCount: number;
  let aspectCount: number;
  let flowCount: number;
  // Independent live boundary + suppression inventory, recomputed via the SAME facade
  // functions the pipeline reuses — never hardcoded counts.
  let liveBoundary: Awaited<ReturnType<typeof computePortalBoundary>>;
  let liveSuppressionCount: number;

  beforeAll(async () => {
    data = await extractPortalData(REPO_ROOT, { writeEnabled: false });

    // Independent recomputation via the SAME read-only functions the portal reuses.
    const graph = await loadGraph(REPO_ROOT);
    const gitFiles = await walkRepoFiles(REPO_ROOT);
    const check = await runCheck(graph, gitFiles);
    const expected = await computeExpectedPairs(graph);

    errors = check.issues.filter((i) => i.severity === 'error').length;
    warnings = check.issues.filter((i) => i.severity === 'warning').length;
    checkCovered = check.coveredFiles;
    checkTotal = check.totalFiles;
    expectedPairCount = expected.pairs.length;
    nodeCount = graph.nodes.size;
    aspectCount = graph.aspects.length;
    flowCount = graph.flows.length;

    // The live boundary + suppression inventory, derived from the SAME facade functions
    // the pipeline calls — so the asserted counts come from the engine, not a literal.
    liveBoundary = await computePortalBoundary(graph, REPO_ROOT);
    const liveMarkers = await scanPortalSuppressions(graph, REPO_ROOT, gitFiles);
    liveSuppressionCount = liveMarkers.length;
  }, 180_000);

  it('severities equal yg check', () => {
    expect(data.meta.counts.errors).toBe(errors);
    expect(data.meta.counts.warnings).toBe(warnings);
  });

  it('coverage equals yg check', () => {
    expect(data.meta.counts.coveredFiles).toBe(checkCovered);
    expect(data.meta.counts.totalFiles).toBe(checkTotal);
  });

  it('verified + refused + unverified covers every expected pair', () => {
    expect(
      data.meta.counts.verified + data.meta.counts.refused + data.meta.counts.unverified,
    ).toBe(expectedPairCount);
    expect(data.meta.counts.pairsTotal).toBe(expectedPairCount);
    expect(data.meta.counts.pairsLLM + data.meta.counts.pairsDet).toBe(expectedPairCount);
  });

  it('catalogue counts are derived, not literals', () => {
    expect(data.meta.counts.nodes).toBe(nodeCount);
    expect(data.meta.counts.aspects).toBe(aspectCount);
    expect(data.meta.counts.flows).toBe(flowCount);
  });

  it('stamps generatedAt after generation (ISO, non-empty)', () => {
    expect(data.meta.generatedAt).not.toBe('');
    expect(Number.isNaN(Date.parse(data.meta.generatedAt))).toBe(false);
  });

  it('reflects writeEnabled and a derived schemaSupported / projectName', () => {
    expect(data.meta.writeEnabled).toBe(false);
    expect(data.meta.schemaSupported.length).toBeGreaterThan(0);
    expect(data.meta.projectName.length).toBeGreaterThan(0);
  });

  // ── Live FULL boundary — derived from the SAME facade/engine functions ──────
  //
  // The portal now carries a LIVE boundary computed by the facade (computePortalBoundary):
  // phantom (undeclared dependency), declared-only (declared relation with no static code
  // backing), and forbidden-type (a dependency the architecture matrix forbids by type).
  // We assert the portal's boundary equals an INDEPENDENT run of the same facade function —
  // never a hardcoded count — so the audit boundary can never drift from the engine.

  it('carries a live FULL boundary (not unknown) on the real repo', () => {
    expect(liveBoundary).not.toBeNull();
    expect(data.boundary.unknown).toBe(false);
  });

  it('boundary phantom/declared-only/forbidden-type counts equal an independent facade run', () => {
    // Dedupe the independent run the same way buildBoundary does, then compare lengths.
    const dedupe = (edges: Array<{ source: string; target: string }>): number => {
      const seen = new Set<string>();
      for (const e of edges) seen.add(`${e.source} ${e.target}`);
      return seen.size;
    };
    expect(data.boundary.phantom.length).toBe(dedupe(liveBoundary!.phantom));
    expect(data.boundary.declaredOnly.length).toBe(dedupe(liveBoundary!.declaredOnly));
    expect(data.boundary.forbiddenType.length).toBe(dedupe(liveBoundary!.forbiddenType));
  });

  it('phantom equals yg check relation errors (zero when the build has none)', () => {
    // The relation-conformance check is the phantom source; on a green repo it is zero, and
    // the portal must report zero phantom edges — never fabricate an undeclared dependency.
    const relationErrors = data.worklist
      .filter((g) => g.rule === 'relation-undeclared-dependency')
      .reduce((n, g) => n + g.nodes.length, 0);
    expect(data.boundary.phantom.length).toBe(relationErrors);
  });

  it('forbidden-type equals zero when the architecture has no relation violations', () => {
    // forbidden-type is a detected edge the matrix forbids; on a graph with no
    // relation-target-forbidden errors, a detected edge that resolved cleanly is always
    // type-allowed (a forbidden code edge would already be an undeclared phantom OR a
    // declared, validator-rejected relation — neither is silently green here).
    expect(data.boundary.forbiddenType.length).toBe(0);
  });

  // ── Live suppression inventory — same scan the command runs ─────────────────

  it('carries a live suppression inventory derived from the same facade scan', () => {
    expect(data.suppressions.length).toBe(liveSuppressionCount);
    // Each entry is well-formed (file + 1-based line + aspect id), never fabricated.
    for (const s of data.suppressions) {
      expect(s.file.length).toBeGreaterThan(0);
      expect(s.line).toBeGreaterThanOrEqual(1);
      expect(typeof s.aspectId).toBe('string');
    }
  });

  it('suppression inventory is sorted by file then line', () => {
    for (let i = 1; i < data.suppressions.length; i++) {
      const prev = data.suppressions[i - 1];
      const cur = data.suppressions[i];
      const byFile = prev.file.localeCompare(cur.file, 'en');
      expect(byFile <= 0).toBe(true);
      if (byFile === 0) expect(prev.line <= cur.line).toBe(true);
    }
  });

  it('per-node suppressions are a subset of the flat inventory keyed by mapped files', () => {
    const flatKeys = new Set(data.suppressions.map((s) => `${s.file}:${s.line}:${s.aspectId}`));
    for (const node of data.nodes) {
      for (const s of node.suppressions) {
        expect(flatKeys.has(`${s.file}:${s.line}:${s.aspectId}`)).toBe(true);
        // The suppression's file must be one the node maps.
        expect(node.mapping.includes(s.file)).toBe(true);
      }
    }
  });
});

// ── buildCounts bucketing — synthetic, exhaustive over every pair-state kind ──────
//
// The integration tests above prove count parity on the REAL repo, but the real lock
// happens to be all-green, so the bucketing SWITCH in buildCounts (verified / refused /
// default→unverified) is exercised only on its `verified` arm. This unit-level block
// drives buildCounts directly with a SYNTHETIC pair list carrying AT LEAST ONE of EACH
// PairState.kind — including the two fail-closed gate states (prompt-too-large,
// companion-error) that must never read as green and never as a code "no". It pins the
// invariant the portal's honesty rests on: every expected pair lands in exactly one of
// verified / refused / unverified, and the two gate states fall into unverified.

/** One ExpectedPair per synthetic state; unitKey is unique so they are distinct pairs. */
function expectedPair(aspectId: string, kind: 'llm' | 'deterministic', i: number): ExpectedPair {
  const nodePath = `synthetic/node-${i}`;
  return {
    aspectId,
    kind,
    unitKey: nodeUnit(nodePath),
    nodePath,
    status: 'enforced',
    subjectFiles: [`source/synthetic/file-${i}.ts`],
  };
}

function verifiedPair(pair: ExpectedPair, state: PairState): VerifiedPair {
  return { pair, state };
}

/** A minimal Graph carrying only the three catalogue sizes buildCounts reads. */
function syntheticGraph(nodes: number, aspects: number, flows: number): Graph {
  return {
    nodes: new Map(Array.from({ length: nodes }, (_, i) => [`n${i}`, {} as never])),
    aspects: Array.from({ length: aspects }, () => ({}) as never),
    flows: Array.from({ length: flows }, () => ({}) as never),
  } as unknown as Graph;
}

/** A minimal CheckResult carrying only the severity + coverage fields buildCounts reads. */
function syntheticCheck(opts: {
  errors: number;
  warnings: number;
  coveredFiles: number;
  totalFiles: number;
  draftSkipped: number;
}): CheckResult {
  const issues = [
    ...Array.from({ length: opts.errors }, () => ({ severity: 'error' as const })),
    ...Array.from({ length: opts.warnings }, () => ({ severity: 'warning' as const })),
  ];
  return {
    projectName: 'synthetic',
    coveredFiles: opts.coveredFiles,
    totalFiles: opts.totalFiles,
    draftSkipped: opts.draftSkipped,
    issues,
  } as unknown as CheckResult;
}

describe('buildCounts — pair-state bucketing over every kind (the honesty switch)', () => {
  // One pair per PairState.kind. The two gate states carry their full payload so we are
  // exercising the REAL state shapes, not a stripped stand-in.
  const states: PairState[] = [
    { kind: 'verified' },
    { kind: 'refused', reason: 'a reviewer said no' },
    { kind: 'unverified' },
    { kind: 'prompt-too-large', chars: 99_999, limit: 40_000, tierName: 'default' },
    {
      kind: 'companion-error',
      messageData: { what: 'companion hook threw', why: 'infra', next: 'fix the hook' },
    },
  ];

  // Distinct expected pairs (alternating kind so the LLM/det split is also non-trivial),
  // and a verified-pair list of the same length keyed 1:1 to the synthetic states.
  const expected: ExpectedPair[] = states.map((_, i) =>
    expectedPair(`synthetic/aspect-${i}`, i % 2 === 0 ? 'llm' : 'deterministic', i),
  );
  const pairs: VerifiedPair[] = states.map((state, i) => verifiedPair(expected[i], state));

  const graph = syntheticGraph(7, 3, 2);
  const check = syntheticCheck({ errors: 4, warnings: 1, coveredFiles: 9, totalFiles: 11, draftSkipped: 6 });
  const counts = buildCounts(graph, check, pairs, expected);

  it('verified + refused + unverified === total expected pairs (identity holds)', () => {
    expect(counts.verified + counts.refused + counts.unverified).toBe(expected.length);
    expect(counts.pairsTotal).toBe(expected.length);
    expect(counts.pairsLLM + counts.pairsDet).toBe(expected.length);
  });

  it('the two fail-closed gate states land in UNVERIFIED — not refused, not dropped', () => {
    // states: 1 verified, 1 refused, and 3 unverified-bucket (unverified + the two gates).
    expect(counts.verified).toBe(1);
    expect(counts.refused).toBe(1);
    // prompt-too-large AND companion-error each fall into unverified (the default arm),
    // alongside the plain unverified pair → 3 total. They are NOT green and NOT a code "no".
    expect(counts.unverified).toBe(3);
  });

  it('derives catalogue, coverage, and severity counts off the engine results, not literals', () => {
    expect(counts.nodes).toBe(7);
    expect(counts.aspects).toBe(3);
    expect(counts.flows).toBe(2);
    expect(counts.errors).toBe(4);
    expect(counts.warnings).toBe(1);
    expect(counts.coveredFiles).toBe(9);
    expect(counts.totalFiles).toBe(11);
    expect(counts.uncoveredFiles).toBe(2);
    expect(counts.draft).toBe(6);
    // pairs alternate llm/det across 5 synthetic pairs → 3 llm, 2 det.
    expect(counts.pairsLLM).toBe(3);
    expect(counts.pairsDet).toBe(2);
  });
});
