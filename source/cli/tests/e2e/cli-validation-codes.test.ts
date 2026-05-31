import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, cpSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Hermetic E2E harness — `yg check` VALIDATION ERROR-CODE matrix.
//
// Companion to cli-check-validation.test.ts. That suite already pins
// oversized-node, mapping-path-missing, yaml-invalid, aspect-undefined,
// aspect-implies-cycle, aspect-reference-broken, aspect-references-on-
// deterministic, and flow-node-broken. THIS suite covers the REMAINING
// blocking validation codes a user can trip through the spawned binary — the
// aspect-reference parser family, the reviewer-spec parser family, the
// architecture/relation structural codes, and the sizeExempt opt-out — none of
// which are exercised elsewhere in the E2E corpus.
//
// Codes deliberately SKIPPED here because another E2E suite already covers
// them (verified by grep across tests/e2e/):
//   - relation-broken, event-unpaired, relation-target-forbidden  → cli-relations.test.ts
//   - aspect-status-downgrade                                     → cli-status-suppress.test.ts / cli-channels.test.ts
//   - consumes-without-ports, port-missing-aspect/consumes,
//     port-undefined                                              → cli-ports*.test.ts
//   - the 8 codes named above                                    → cli-check-validation.test.ts
//
// Determinism guarantees (same as the companion suite):
//   - No test reads the network, the wall clock, or any random source. The
//     scaffolded config points its reviewer tier at a loopback address that
//     `yg check` never dials.
//   - Committed fixtures are never mutated — only the schemas/ directory is
//     COPIED out of the committed sample-project; every node/aspect/flow/source
//     byte is authored inside a per-test mkdtemp and removed in a finally block.
//   - Every code string and the offending-entity substring asserted below was
//     verified against the validator / checks / parser source before being
//     pinned (src/core/checks/*, src/io/aspect-parser.ts, src/io/node-parser.ts).
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const SAMPLE_FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'sample-project');
const SCHEMAS_DIR = path.join(SAMPLE_FIXTURE, '.yggdrasil', 'schemas');

const distExists = existsSync(BIN_PATH);

function run(
  args: string[],
  cwd: string,
): {
  stdout: string;
  stderr: string;
  status: number | null;
  all: string;
} {
  const result = spawnSync('node', [BIN_PATH, ...args], { cwd, encoding: 'utf-8' });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  return { stdout, stderr, status: result.status, all: stdout + stderr };
}

// A loopback reviewer endpoint that is never dialed by `yg check` — present only
// so the scaffolded config carries a syntactically valid reviewer tier.
const LOOPBACK_ENDPOINT = 'http://127.0.0.1:11434';

interface GraphOptions {
  /** Full yg-architecture.yaml body. Defaults to a single permissive `service` type. */
  architecture?: string;
  /** Extra lines appended under `quality:` in yg-config.yaml (e.g. max_node_chars). */
  qualityExtra?: string[];
  /** Extra YAML appended to the `standard` tier (e.g. a `references:` cap block). */
  tierExtra?: string[];
}

const DEFAULT_ARCHITECTURE = [
  'node_types:',
  '  service:',
  "    description: 'A service'",
  '    log_required: false',
  '    when:',
  '      path: "**"',
  '',
].join('\n');

/**
 * Scaffold a minimal but structurally-complete graph in a fresh temp dir:
 * the three required schemas (copied from the committed fixture so
 * `schema-missing` never adds noise), an architecture file, a config with one
 * loopback reviewer tier, and empty model/aspects/flows directories.
 *
 * The `build` callback writes the scenario-specific nodes/aspects/flows/source.
 * Returns the temp dir; caller is responsible for rmSync cleanup.
 */
function minimalGraph(
  label: string,
  build: (ctx: { ygRoot: string; projectRoot: string }) => void,
  opts: GraphOptions = {},
): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-valcodes-${label}-`));
  const ygRoot = path.join(dir, '.yggdrasil');
  mkdirSync(path.join(ygRoot, 'model'), { recursive: true });
  mkdirSync(path.join(ygRoot, 'aspects'), { recursive: true });
  mkdirSync(path.join(ygRoot, 'flows'), { recursive: true });
  cpSync(SCHEMAS_DIR, path.join(ygRoot, 'schemas'), { recursive: true });

  writeFileSync(
    path.join(ygRoot, 'yg-architecture.yaml'),
    opts.architecture ?? DEFAULT_ARCHITECTURE,
    'utf-8',
  );
  writeFileSync(
    path.join(ygRoot, 'yg-config.yaml'),
    [
      'quality:',
      '  max_direct_relations: 10',
      ...(opts.qualityExtra ?? []),
      'reviewer:',
      '  tiers:',
      '    standard:',
      '      provider: ollama',
      '      consensus: 1',
      '      config:',
      '        model: test',
      `        endpoint: ${LOOPBACK_ENDPOINT}`,
      ...(opts.tierExtra ?? []),
      '',
    ].join('\n'),
    'utf-8',
  );

  build({ ygRoot, projectRoot: dir });
  return dir;
}

/** Write a yg-node.yaml under model/<nodePath>/. */
function writeNode(ygRoot: string, nodePath: string, yaml: string): void {
  const nodeDir = path.join(ygRoot, 'model', ...nodePath.split('/'));
  mkdirSync(nodeDir, { recursive: true });
  writeFileSync(path.join(nodeDir, 'yg-node.yaml'), yaml, 'utf-8');
}

/** Write an aspect (yg-aspect.yaml + optional rule-source file) under aspects/<id>/. */
function writeAspect(
  ygRoot: string,
  id: string,
  yaml: string,
  ruleSource: { file: 'content.md' | 'check.mjs'; body: string } | null,
): void {
  const aspectDir = path.join(ygRoot, 'aspects', ...id.split('/'));
  mkdirSync(aspectDir, { recursive: true });
  writeFileSync(path.join(aspectDir, 'yg-aspect.yaml'), yaml, 'utf-8');
  if (ruleSource) {
    writeFileSync(path.join(aspectDir, ruleSource.file), ruleSource.body, 'utf-8');
  }
}

/** Write a repo source file (creating parent dirs) at projectRoot-relative path. */
function writeSource(projectRoot: string, relPath: string, body: string): void {
  const abs = path.join(projectRoot, ...relPath.split('/'));
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, body, 'utf-8');
}

// An LLM aspect carrying its own content.md, attached so it participates in the
// graph. Tests that target reference/parser errors reuse this skeleton and
// override only the `references:` block via the supplied tail lines.
function llmAspectYaml(tail: string[]): string {
  return ['name: RefAspect', 'description: An LLM aspect under test', 'reviewer:', '  type: llm', ...tail, ''].join(
    '\n',
  );
}

const WIDGET_WITH_REF_ASPECT = [
  'name: Widget',
  'description: A widget node',
  'type: service',
  'aspects:',
  '  - ref-aspect',
  '',
].join('\n');

// ===========================================================================

describe.skipIf(!distExists)('CLI E2E — yg check validation code matrix (remaining codes)', () => {
  // -------------------------------------------------------------------------
  // GROUP A — aspect `references:` parser errors (io/aspect-parser.ts).
  // Each is a parse-time error surfaced via graph.aspectParseErrors → the
  // validator re-emits with the same code. The first offending entry aborts the
  // parse, so each scenario isolates exactly one code.
  // -------------------------------------------------------------------------

  it('A1: a reference path escaping the repo root yields aspect-reference-escape (exit 1)', () => {
    const dir = minimalGraph('ref-escape', ({ ygRoot }) => {
      writeAspect(ygRoot, 'ref-aspect', llmAspectYaml(['references:', '  - ../outside.md']), {
        file: 'content.md',
        body: 'Rule.\n',
      });
      writeNode(ygRoot, 'widget', WIDGET_WITH_REF_ASPECT);
    });
    try {
      const { status, all } = run(['check'], dir);
      expect(status).toBe(1);
      expect(all).toContain('aspect-reference-escape');
      expect(all).toContain('../outside.md');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('A2: a duplicated reference path yields aspect-reference-duplicate (exit 1)', () => {
    const dir = minimalGraph('ref-dup', ({ ygRoot }) => {
      writeAspect(
        ygRoot,
        'ref-aspect',
        llmAspectYaml(['references:', '  - docs/table.md', '  - docs/table.md']),
        { file: 'content.md', body: 'Rule.\n' },
      );
      writeNode(ygRoot, 'widget', WIDGET_WITH_REF_ASPECT);
    });
    try {
      const { status, all } = run(['check'], dir);
      expect(status).toBe(1);
      expect(all).toContain('aspect-reference-duplicate');
      expect(all).toContain('docs/table.md');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('A3: a non-string/non-object reference entry yields aspect-reference-invalid-form (exit 1)', () => {
    const dir = minimalGraph('ref-invalid-form', ({ ygRoot }) => {
      // A bare number is neither a string path nor a { path, description } object.
      writeAspect(ygRoot, 'ref-aspect', llmAspectYaml(['references:', '  - 42']), {
        file: 'content.md',
        body: 'Rule.\n',
      });
      writeNode(ygRoot, 'widget', WIDGET_WITH_REF_ASPECT);
    });
    try {
      const { status, all } = run(['check'], dir);
      expect(status).toBe(1);
      expect(all).toContain('aspect-reference-invalid-form');
      expect(all).toContain('ref-aspect');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('A4: a whitespace-only reference path yields aspect-reference-blank-path (exit 1)', () => {
    const dir = minimalGraph('ref-blank', ({ ygRoot }) => {
      writeAspect(ygRoot, 'ref-aspect', llmAspectYaml(['references:', '  - "   "']), {
        file: 'content.md',
        body: 'Rule.\n',
      });
      writeNode(ygRoot, 'widget', WIDGET_WITH_REF_ASPECT);
    });
    try {
      const { status, all } = run(['check'], dir);
      expect(status).toBe(1);
      expect(all).toContain('aspect-reference-blank-path');
      expect(all).toContain('ref-aspect');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // NOTE: aspect-references-empty-array is a WARNING, not an error. `yg check`
  // therefore PASSES (exit 0) and renders it in the Warnings block — this pins
  // that non-blocking severity, distinguishing it from the error-form parser
  // codes above. (Verified: io/aspect-parser.ts emits it via checkAspectReferences
  // in core/checks/aspect-contracts.ts with severity 'warning'.)
  it('A5: an empty references array is a non-blocking aspect-references-empty-array warning (exit 0)', () => {
    const dir = minimalGraph('ref-empty', ({ ygRoot }) => {
      writeAspect(ygRoot, 'ref-aspect', llmAspectYaml(['references: []']), {
        file: 'content.md',
        body: 'Rule.\n',
      });
      writeNode(ygRoot, 'widget', WIDGET_WITH_REF_ASPECT);
    });
    try {
      const { status, all } = run(['check'], dir);
      expect(status).toBe(0);
      expect(all).toContain('aspect-references-empty-array');
      expect(all).toContain('ref-aspect');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // GROUP B — aspect reference SIZE caps (core/checks/aspect-contracts.ts).
  // A real reference file on disk exceeds the tier's per-file / per-aspect byte
  // caps configured in yg-config.yaml. Both checks run against the same file:
  // a single 200-byte reference trips the 50-byte per-file cap AND the 80-byte
  // per-aspect cap, so one scaffold pins both codes.
  // -------------------------------------------------------------------------

  it('B1: an over-cap reference trips aspect-reference-too-large and aspect-references-total-too-large (exit 1)', () => {
    const dir = minimalGraph(
      'ref-too-large',
      ({ ygRoot, projectRoot }) => {
        writeAspect(
          ygRoot,
          'ref-aspect',
          [
            'name: RefAspect',
            'description: An LLM aspect with an over-cap reference',
            'reviewer:',
            '  type: llm',
            '  tier: standard',
            'references:',
            '  - docs/big.md',
            '',
          ].join('\n'),
          { file: 'content.md', body: 'Rule.\n' },
        );
        writeNode(ygRoot, 'widget', WIDGET_WITH_REF_ASPECT);
        // 200 bytes: over the 50-byte per-file cap and the 80-byte per-aspect cap.
        writeSource(projectRoot, 'docs/big.md', 'x'.repeat(200));
      },
      { tierExtra: ['      references:', '        max_bytes_per_file: 50', '        max_total_bytes_per_aspect: 80'] },
    );
    try {
      const { status, all } = run(['check'], dir);
      expect(status).toBe(1);
      expect(all).toContain('aspect-reference-too-large');
      expect(all).toContain('aspect-references-total-too-large');
      expect(all).toContain('docs/big.md');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // GROUP C — reviewer-spec parser errors (io/aspect-parser.ts parseReviewer).
  // These are parse-time errors surfaced via graph.aspectParseErrors.
  // -------------------------------------------------------------------------

  it('C1: a missing reviewer block yields aspect-reviewer-missing (exit 1)', () => {
    const dir = minimalGraph('rev-missing', ({ ygRoot }) => {
      // No `reviewer:` key at all.
      writeAspect(
        ygRoot,
        'ref-aspect',
        ['name: RefAspect', 'description: An aspect with no reviewer block', ''].join('\n'),
        null,
      );
      writeNode(ygRoot, 'widget', WIDGET_WITH_REF_ASPECT);
    });
    try {
      const { status, all } = run(['check'], dir);
      expect(status).toBe(1);
      expect(all).toContain('aspect-reviewer-missing');
      expect(all).toContain('ref-aspect');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('C2: a string-form reviewer yields aspect-reviewer-legacy-string (exit 1)', () => {
    const dir = minimalGraph('rev-legacy', ({ ygRoot }) => {
      writeAspect(
        ygRoot,
        'ref-aspect',
        ['name: RefAspect', 'description: A legacy string reviewer', 'reviewer: llm', ''].join('\n'),
        { file: 'content.md', body: 'Rule.\n' },
      );
      writeNode(ygRoot, 'widget', WIDGET_WITH_REF_ASPECT);
    });
    try {
      const { status, all } = run(['check'], dir);
      expect(status).toBe(1);
      expect(all).toContain('aspect-reviewer-legacy-string');
      expect(all).toContain('ref-aspect');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('C3: an unknown reviewer.type yields aspect-reviewer-type-invalid (exit 1)', () => {
    const dir = minimalGraph('rev-type-invalid', ({ ygRoot }) => {
      // 'structure' is not a valid reviewer type — only 'llm' and 'deterministic'.
      writeAspect(
        ygRoot,
        'ref-aspect',
        ['name: RefAspect', 'description: An invalid reviewer type', 'reviewer:', '  type: structure', ''].join('\n'),
        null,
      );
      writeNode(ygRoot, 'widget', WIDGET_WITH_REF_ASPECT);
    });
    try {
      const { status, all } = run(['check'], dir);
      expect(status).toBe(1);
      expect(all).toContain('aspect-reviewer-type-invalid');
      expect(all).toContain('structure');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('C4: a deterministic aspect with a tier yields aspect-tier-on-deterministic (exit 1)', () => {
    const dir = minimalGraph('tier-on-det', ({ ygRoot }) => {
      writeAspect(
        ygRoot,
        'ref-aspect',
        [
          'name: RefAspect',
          'description: A deterministic aspect that wrongly carries a tier',
          'reviewer:',
          '  type: deterministic',
          '  tier: standard',
          '',
        ].join('\n'),
        { file: 'check.mjs', body: 'export function check() {\n  return [];\n}\n' },
      );
      writeNode(ygRoot, 'widget', WIDGET_WITH_REF_ASPECT);
    });
    try {
      const { status, all } = run(['check'], dir);
      expect(status).toBe(1);
      expect(all).toContain('aspect-tier-on-deterministic');
      expect(all).toContain('ref-aspect');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // GROUP D — architecture / relation STRUCTURAL codes.
  // -------------------------------------------------------------------------

  // parent-type-forbidden (core/checks/architecture.ts: checkArchitectureParents).
  // The `widget` type declares parents: [gadget]; the actual parent node is a
  // `module`, which is not in that allow-list.
  it('D1: a node under a forbidden parent type yields parent-type-forbidden (exit 1)', () => {
    const architecture = [
      'node_types:',
      '  module:',
      "    description: 'An organizational parent'",
      '    log_required: false',
      '  gadget:',
      "    description: 'A gadget'",
      '    log_required: false',
      '    when:',
      '      path: "**"',
      '  widget:',
      "    description: 'A widget that must live under a gadget'",
      '    log_required: false',
      '    parents:',
      '      - gadget',
      '    when:',
      '      path: "**"',
      '',
    ].join('\n');
    const dir = minimalGraph(
      'parent-forbidden',
      ({ ygRoot }) => {
        writeNode(ygRoot, 'outer', ['name: Outer', 'description: outer module node', 'type: module', ''].join('\n'));
        writeNode(
          ygRoot,
          'outer/inner',
          ['name: Inner', 'description: inner widget node', 'type: widget', ''].join('\n'),
        );
      },
      { architecture },
    );
    try {
      const { status, all } = run(['check'], dir);
      expect(status).toBe(1);
      expect(all).toContain('parent-type-forbidden');
      expect(all).toContain('outer/inner');
      expect(all).toContain('Allowed parents: [gadget]');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // type-strict-orphan (core/checks/mapping.ts: checkStrictBackwardCoverage).
  // A file on disk satisfies a strict type's `when` but is mapped by no node of
  // that type (a different node owns a different file). walkRepoFiles is a plain
  // filesystem walk, so this fires even without a git repo.
  it('D2: a file matching an enforce:strict type but owned by no node yields type-strict-orphan (exit 1)', () => {
    const architecture = [
      'node_types:',
      '  special:',
      "    description: 'Strictly enforced type for special files'",
      '    log_required: false',
      '    enforce: strict',
      '    when:',
      '      path: "src/**/*.special.ts"',
      '  service:',
      "    description: 'A service'",
      '    log_required: false',
      '    when:',
      '      path: "**"',
      '',
    ].join('\n');
    const dir = minimalGraph(
      'strict-orphan',
      ({ ygRoot, projectRoot }) => {
        // A service node owns an ordinary file (so the graph is non-empty and valid).
        writeNode(
          ygRoot,
          'widget',
          ['name: Widget', 'description: a widget', 'type: service', 'mapping:', '  - src/widget.ts', ''].join('\n'),
        );
        writeSource(projectRoot, 'src/widget.ts', 'export const w = 1;\n');
        // The orphan: matches special.when, but no node maps it.
        writeSource(projectRoot, 'src/thing.special.ts', 'export const s = 1;\n');
      },
      { architecture },
    );
    try {
      const { status, all } = run(['check'], dir);
      expect(status).toBe(1);
      expect(all).toContain('type-strict-orphan');
      expect(all).toContain('src/thing.special.ts');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // structural-cycle (core/checks/relations.ts: checkNoCycles).
  // Two nodes form a `uses` cycle (a -> b -> a). Only structural relation types
  // (uses/calls/extends/implements) count toward a cycle.
  it('D3: a uses cycle between two nodes yields structural-cycle (exit 1)', () => {
    const dir = minimalGraph('structural-cycle', ({ ygRoot }) => {
      writeNode(
        ygRoot,
        'a',
        ['name: NodeA', 'description: node a', 'type: service', 'relations:', '  - target: b', '    type: uses', ''].join(
          '\n',
        ),
      );
      writeNode(
        ygRoot,
        'b',
        ['name: NodeB', 'description: node b', 'type: service', 'relations:', '  - target: a', '    type: uses', ''].join(
          '\n',
        ),
      );
    });
    try {
      const { status, all } = run(['check'], dir);
      expect(status).toBe(1);
      expect(all).toContain('structural-cycle');
      expect(all).toContain('a -> b -> a');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // GROUP E — sizeExempt opt-out (io/node-parser.ts + core/checks/mapping.ts).
  // -------------------------------------------------------------------------

  // A sizeExempt with a blank reason is a NODE PARSE ERROR (io/node-parser.ts:
  // parseSizeExempt throws), surfaced by the validator as yaml-invalid against
  // the offending node. The node never loads, so the parse-error why-line is the
  // tripwire — not an oversized-node count.
  it('E1: sizeExempt with a blank reason is rejected as yaml-invalid (exit 1)', () => {
    const dir = minimalGraph(
      'sizeexempt-blank',
      ({ ygRoot, projectRoot }) => {
        writeNode(
          ygRoot,
          'widget',
          [
            'name: Widget',
            'description: a widget',
            'type: service',
            'mapping:',
            '  - src/widget.ts',
            'sizeExempt:',
            '  reason: "   "',
            '',
          ].join('\n'),
        );
        writeSource(projectRoot, 'src/widget.ts', 'export const w = 1;\n');
      },
      { qualityExtra: ['  max_node_chars: 100'] },
    );
    try {
      const { status, all } = run(['check'], dir);
      expect(status).toBe(1);
      expect(all).toContain('yaml-invalid');
      expect(all).toContain('widget');
      expect(all).toContain("'sizeExempt' requires a non-empty 'reason'");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The positive path: a VALID sizeExempt reason suppresses oversized-node even
  // though the mapped file is far over the (deliberately tiny) budget. The
  // control case (no sizeExempt → oversized-node fires) is already pinned in
  // cli-check-validation.test.ts case 1, so here we assert only the suppression.
  it('E2: a valid sizeExempt reason suppresses oversized-node (exit 0)', () => {
    const dir = minimalGraph(
      'sizeexempt-suppress',
      ({ ygRoot, projectRoot }) => {
        writeNode(
          ygRoot,
          'widget',
          [
            'name: Widget',
            'description: a widget mapping one unsplittable generated artifact',
            'type: service',
            'mapping:',
            '  - src/generated.ts',
            'sizeExempt:',
            '  reason: "Single generated artifact that cannot be split."',
            '',
          ].join('\n'),
        );
        // ~3000 chars, far over the 100-char budget — would be oversized-node
        // without the exemption.
        writeSource(
          projectRoot,
          'src/generated.ts',
          '// padding line to inflate this node past the budget\n'.repeat(60),
        );
      },
      { qualityExtra: ['  max_node_chars: 100'] },
    );
    try {
      const { status, all } = run(['check'], dir);
      expect(status).toBe(0);
      expect(all).not.toContain('oversized-node');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // GROUP H — structural codes not exercised anywhere else in the E2E corpus:
  // a broken implies edge, an overlapping (non-hierarchical) mapping, and a
  // model directory with files but no yg-node.yaml. Each code was verified to
  // exist in src/core/checks/* and to be absent from every other e2e suite.
  // -------------------------------------------------------------------------

  it('H1: an aspect implying a non-existent aspect yields implied-aspect-missing (exit 1)', () => {
    const dir = minimalGraph('implied-missing', ({ ygRoot, projectRoot }) => {
      writeAspect(
        ygRoot,
        'audit',
        ['name: Audit', 'description: Audit rule', 'reviewer:', '  type: deterministic', 'implies:', '  - ghost-aspect', ''].join('\n'),
        { file: 'check.mjs', body: 'export function check() { return []; }\n' },
      );
      writeNode(
        ygRoot,
        'widget',
        ['name: Widget', 'description: A widget', 'type: service', 'aspects:', '  - audit', 'mapping:', '  - src/widget.ts', ''].join('\n'),
      );
      writeSource(projectRoot, 'src/widget.ts', 'export const w = 1;\n');
    });
    try {
      const { status, all } = run(['check'], dir);
      expect(status).toBe(1);
      expect(all).toContain('implied-aspect-missing');
      expect(all).toContain('ghost-aspect');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('H2: two non-hierarchical nodes with overlapping directory mappings yield overlapping-mapping (exit 1)', () => {
    const dir = minimalGraph('overlap', ({ ygRoot, projectRoot }) => {
      // alpha and beta are siblings (neither is an ancestor of the other), yet
      // alpha maps a directory that CONTAINS beta's — an ambiguous-ownership
      // overlap that the "child wins" containment rule does not excuse.
      writeNode(ygRoot, 'alpha', ['name: Alpha', 'description: A', 'type: service', 'mapping:', '  - src/shared/', ''].join('\n'));
      writeNode(ygRoot, 'beta', ['name: Beta', 'description: B', 'type: service', 'mapping:', '  - src/shared/sub/', ''].join('\n'));
      writeSource(projectRoot, 'src/shared/sub/x.ts', 'export const x = 1;\n');
    });
    try {
      const { status, all } = run(['check'], dir);
      expect(status).toBe(1);
      expect(all).toContain('overlapping-mapping');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('H3: a model directory with files but no yg-node.yaml yields node-yaml-missing (exit 1)', () => {
    const dir = minimalGraph('node-yaml-missing', ({ ygRoot, projectRoot }) => {
      // A valid node so the graph is not empty…
      writeNode(ygRoot, 'widget', ['name: Widget', 'description: A widget', 'type: service', 'mapping:', '  - src/widget.ts', ''].join('\n'));
      writeSource(projectRoot, 'src/widget.ts', 'export const w = 1;\n');
      // …plus a stray model directory that has a file but no node definition.
      const strayDir = path.join(ygRoot, 'model', 'orphan-dir');
      mkdirSync(strayDir, { recursive: true });
      writeFileSync(path.join(strayDir, 'notes.md'), '# stray notes\n', 'utf-8');
    });
    try {
      const { status, all } = run(['check'], dir);
      expect(status).toBe(1);
      expect(all).toContain('node-yaml-missing');
      expect(all).toContain('orphan-dir');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('H4: a mapping path that climbs above the repo root yields mapping-escapes-repo (exit 1)', () => {
    const dir = minimalGraph('mapping-escapes', ({ ygRoot, projectRoot }) => {
      // A valid node keeps the graph non-empty and covered…
      writeNode(ygRoot, 'widget', ['name: Widget', 'description: A widget', 'type: service', 'mapping:', '  - src/widget.ts', ''].join('\n'));
      writeSource(projectRoot, 'src/widget.ts', 'export const w = 1;\n');
      // …plus a node whose mapping climbs above the repo root with `..`.
      writeNode(ygRoot, 'escaper', ['name: Escaper', 'description: Escapes', 'type: service', 'mapping:', '  - ../../outside.ts', ''].join('\n'));
    });
    try {
      const { status, all } = run(['check'], dir);
      expect(status).toBe(1);
      expect(all).toContain('mapping-escapes-repo');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
