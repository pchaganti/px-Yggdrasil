import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  cpSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Hermetic E2E harness — yg-config.yaml reviewer/tier + global-config VALIDATION
// matrix through the spawned binary.
//
// Every test scaffolds a fresh minimal graph in a per-test mkdtemp directory:
//   - the three required schemas (copied from the committed sample-project so
//     `schema-missing` never adds noise),
//   - a single `service` node type whose `when` matches everything,
//   - ONE node and ONE DETERMINISTIC aspect (so the graph is structurally
//     complete and fully hermetic — no LLM, no network, no clock, no RNG),
//   - a yg-config.yaml exhibiting exactly ONE config defect per test.
//
// It then spawns the REAL built binary (dist/bin.js) running `yg check` and
// asserts exit code 1 + the SPECIFIC error code and message substrings. Every
// code/message asserted below was verified against the live binary AND against
// src/io/config-parser.ts / src/io/aspect-parser.ts /
// src/core/checks/aspect-contracts.ts before being pinned here.
//
// Determinism guarantees:
//   - `yg check` runs purely on the local graph + filesystem; no reviewer
//     endpoint is dialed. The valid-config baseline carries a loopback endpoint
//     that is never contacted.
//   - The committed fixtures under tests/fixtures/ are never mutated — schemas
//     are cpSync-copied into mkdtemp; every config is authored in mkdtemp.
//   - Each temp dir is removed in a finally block.
//
// Coverage boundary (no overlap with existing suites):
//   - cli-check-validation.test.ts deliberately scaffolds a VALID config, so it
//     never fires any config-* code. This suite owns the config-defect matrix.
//   - cli-migrations.test.ts (M3) already covers the legacy v4→v5 rejection via
//     `yg init --upgrade` AND via `yg check`. Legacy/mixed config-shape
//     detection has been removed from the runtime parser — a malformed v5 config
//     yields `config-tiers-missing` or `config-reviewer-unknown-key`.
//   - cli-tier-cascade.test.ts covers tier-identity DRIFT/cascade, not config
//     VALIDATION errors. No overlap.
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const SAMPLE_FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'sample-project');
const SCHEMAS_DIR = path.join(SAMPLE_FIXTURE, '.yggdrasil', 'schemas');

const distExists = existsSync(BIN_PATH);

// A loopback reviewer endpoint that is never dialed by `yg check`. Used only so
// a valid baseline config carries a syntactically valid tier — no test depends
// on this host being reachable or absent.
const LOOPBACK_ENDPOINT = 'http://127.0.0.1:11434';

function run(
  args: string[],
  cwd: string,
): {
  stdout: string;
  stderr: string;
  status: number | null;
  all: string;
} {
  const result = spawnSync('node', [BIN_PATH, ...args], {
    cwd,
    encoding: 'utf-8',
  });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  return { stdout, stderr, status: result.status, all: stdout + stderr };
}

/**
 * Scaffold a minimal, structurally-complete, fully-hermetic graph and write the
 * scenario's yg-config.yaml.
 *
 * `referenceAspect` controls whether the single node declares the deterministic
 * aspect. For pure CONFIG defects the aspect parses fine, so the node DOES
 * reference it (avoids an orphaned-aspect warning). For aspect-PARSE defects
 * (e.g. tier-on-deterministic) the offending aspect is dropped from the graph,
 * which would make a referencing node ALSO trip aspect-undefined — so the
 * caller leaves the node unreferenced to isolate the parse error.
 *
 * Returns the temp dir; caller is responsible for rmSync cleanup.
 */
function scaffold(
  label: string,
  opts: {
    configYaml: string;
    aspectYaml?: string;
    aspectRule?: { file: 'content.md' | 'check.mjs'; body: string };
    referenceAspect?: boolean;
  },
): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-cfgtier-${label}-`));
  const ygRoot = path.join(dir, '.yggdrasil');
  mkdirSync(path.join(ygRoot, 'model', 'widget'), { recursive: true });
  mkdirSync(path.join(ygRoot, 'aspects', 'det'), { recursive: true });
  mkdirSync(path.join(ygRoot, 'flows'), { recursive: true });
  cpSync(SCHEMAS_DIR, path.join(ygRoot, 'schemas'), { recursive: true });

  writeFileSync(
    path.join(ygRoot, 'yg-architecture.yaml'),
    [
      'node_types:',
      '  service:',
      "    description: 'A service'",
      '    log_required: false',
      '    when:',
      '      path: "**"',
      '',
    ].join('\n'),
    'utf-8',
  );

  const referenceAspect = opts.referenceAspect ?? true;
  writeFileSync(
    path.join(ygRoot, 'model', 'widget', 'yg-node.yaml'),
    [
      'name: Widget',
      'description: A widget node',
      'type: service',
      ...(referenceAspect ? ['aspects:', '  - det'] : []),
      '',
    ].join('\n'),
    'utf-8',
  );

  const aspectYaml =
    opts.aspectYaml ??
    ['name: Det', 'description: A deterministic aspect', 'reviewer:', '  type: deterministic', ''].join('\n');
  writeFileSync(path.join(ygRoot, 'aspects', 'det', 'yg-aspect.yaml'), aspectYaml, 'utf-8');
  const aspectRule = opts.aspectRule ?? { file: 'check.mjs', body: 'export function check() {\n  return [];\n}\n' };
  writeFileSync(path.join(ygRoot, 'aspects', 'det', aspectRule.file), aspectRule.body, 'utf-8');

  writeFileSync(path.join(ygRoot, 'yg-config.yaml'), opts.configYaml, 'utf-8');
  return dir;
}

/** A valid single-tier reviewer block — the baseline every defect mutates. */
const VALID_TIER = [
  '    standard:',
  '      provider: ollama',
  '      consensus: 1',
  '      config:',
  '        model: test',
  `        endpoint: ${LOOPBACK_ENDPOINT}`,
].join('\n');

describe.skipIf(!distExists)('CLI E2E — yg-config.yaml reviewer/tier + global-config validation matrix', () => {
  // =========================================================================
  // GROUP A — provider validation
  // =========================================================================

  it('A1: an unknown provider value yields config-tier-provider-unknown (exit 1)', () => {
    const dir = scaffold('provider-unknown', {
      configYaml: ['reviewer:', '  tiers:', '    standard:', '      provider: bogus-provider', '      consensus: 1', '      config:', '        model: test', ''].join('\n'),
    });
    try {
      const { status, stdout } = run(['check'], dir);
      expect(status).toBe(1);
      expect(stdout).toContain('config-tier-provider-unknown');
      expect(stdout).toContain("unknown provider 'bogus-provider'");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('A2: a tier missing provider: yields config-tier-provider-missing (exit 1)', () => {
    const dir = scaffold('provider-missing', {
      configYaml: ['reviewer:', '  tiers:', '    standard:', '      consensus: 1', '      config:', '        model: test', ''].join('\n'),
    });
    try {
      const { status, stdout } = run(['check'], dir);
      expect(status).toBe(1);
      expect(stdout).toContain('config-tier-provider-missing');
      expect(stdout).toContain("tier 'standard' is missing provider");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // =========================================================================
  // GROUP B — consensus validation (positive odd integer)
  // =========================================================================

  it('B1: an even consensus yields config-tier-consensus-invalid (exit 1)', () => {
    const dir = scaffold('consensus-even', {
      configYaml: ['reviewer:', '  tiers:', '    standard:', '      provider: ollama', '      consensus: 2', '      config:', '        model: test', `        endpoint: ${LOOPBACK_ENDPOINT}`, ''].join('\n'),
    });
    try {
      const { status, stdout } = run(['check'], dir);
      expect(status).toBe(1);
      expect(stdout).toContain('config-tier-consensus-invalid');
      expect(stdout).toContain("invalid consensus '2'");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('B2: a zero consensus yields config-tier-consensus-invalid (exit 1)', () => {
    const dir = scaffold('consensus-zero', {
      configYaml: ['reviewer:', '  tiers:', '    standard:', '      provider: ollama', '      consensus: 0', '      config:', '        model: test', `        endpoint: ${LOOPBACK_ENDPOINT}`, ''].join('\n'),
    });
    try {
      const { status, stdout } = run(['check'], dir);
      expect(status).toBe(1);
      expect(stdout).toContain('config-tier-consensus-invalid');
      expect(stdout).toContain("invalid consensus '0'");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('B3: a negative consensus yields config-tier-consensus-invalid (exit 1)', () => {
    const dir = scaffold('consensus-neg', {
      configYaml: ['reviewer:', '  tiers:', '    standard:', '      provider: ollama', '      consensus: -3', '      config:', '        model: test', `        endpoint: ${LOOPBACK_ENDPOINT}`, ''].join('\n'),
    });
    try {
      const { status, stdout } = run(['check'], dir);
      expect(status).toBe(1);
      expect(stdout).toContain('config-tier-consensus-invalid');
      expect(stdout).toContain("invalid consensus '-3'");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('B4: a non-integer consensus yields config-tier-consensus-invalid (exit 1)', () => {
    const dir = scaffold('consensus-float', {
      configYaml: ['reviewer:', '  tiers:', '    standard:', '      provider: ollama', '      consensus: 1.5', '      config:', '        model: test', `        endpoint: ${LOOPBACK_ENDPOINT}`, ''].join('\n'),
    });
    try {
      const { status, stdout } = run(['check'], dir);
      expect(status).toBe(1);
      expect(stdout).toContain('config-tier-consensus-invalid');
      expect(stdout).toContain("invalid consensus '1.5'");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('B5: a tier missing consensus: yields config-tier-consensus-invalid (exit 1)', () => {
    const dir = scaffold('consensus-missing', {
      configYaml: ['reviewer:', '  tiers:', '    standard:', '      provider: ollama', '      config:', '        model: test', `        endpoint: ${LOOPBACK_ENDPOINT}`, ''].join('\n'),
    });
    try {
      const { status, stdout } = run(['check'], dir);
      expect(status).toBe(1);
      expect(stdout).toContain('config-tier-consensus-invalid');
      expect(stdout).toContain("tier 'standard' is missing consensus");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // =========================================================================
  // GROUP C — tier config block (model required, config block required)
  // =========================================================================

  it('C1: a tier missing config: yields config-tier-config-missing (exit 1)', () => {
    const dir = scaffold('config-missing', {
      configYaml: ['reviewer:', '  tiers:', '    standard:', '      provider: ollama', '      consensus: 1', ''].join('\n'),
    });
    try {
      const { status, stdout } = run(['check'], dir);
      expect(status).toBe(1);
      expect(stdout).toContain('config-tier-config-missing');
      expect(stdout).toContain("tier 'standard' is missing config");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('C2: a tier whose config has no model yields config-tier-config-missing (exit 1)', () => {
    // ollama has no PROVIDER_DEFAULTS model fallback, so an absent config.model
    // surfaces as config-tier-config-missing ("config.model is missing").
    const dir = scaffold('model-missing', {
      configYaml: ['reviewer:', '  tiers:', '    standard:', '      provider: ollama', '      consensus: 1', '      config:', `        endpoint: ${LOOPBACK_ENDPOINT}`, ''].join('\n'),
    });
    try {
      const { status, stdout } = run(['check'], dir);
      expect(status).toBe(1);
      expect(stdout).toContain('config-tier-config-missing');
      expect(stdout).toContain('config.model is missing');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('C3: an unknown key inside a tier yields config-tier-unknown-key (exit 1)', () => {
    const dir = scaffold('tier-unknown-key', {
      configYaml: ['reviewer:', '  tiers:', '    standard:', '      provider: ollama', '      consensus: 1', '      boguskey: 1', '      config:', '        model: test', `        endpoint: ${LOOPBACK_ENDPOINT}`, ''].join('\n'),
    });
    try {
      const { status, stdout } = run(['check'], dir);
      expect(status).toBe(1);
      expect(stdout).toContain('config-tier-unknown-key');
      expect(stdout).toContain("unknown key 'boguskey'");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // =========================================================================
  // GROUP D — tier names (regex + reserved)
  // =========================================================================

  it('D1: a tier name that fails the name regex yields config-tier-name-invalid (exit 1)', () => {
    // Tier names must match ^[a-zA-Z][a-zA-Z0-9_-]{0,62}$ — a leading digit is
    // rejected. default points at it so reviewer.default is itself valid.
    const dir = scaffold('tier-name-invalid', {
      configYaml: ['reviewer:', '  default: "1bad"', '  tiers:', '    "1bad":', '      provider: ollama', '      consensus: 1', '      config:', '        model: test', `        endpoint: ${LOOPBACK_ENDPOINT}`, ''].join('\n'),
    });
    try {
      const { status, stdout } = run(['check'], dir);
      expect(status).toBe(1);
      expect(stdout).toContain('config-tier-name-invalid');
      expect(stdout).toContain("tier name '1bad' is invalid");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('D2: a tier literally named default yields config-tier-name-reserved (exit 1)', () => {
    const dir = scaffold('tier-name-reserved', {
      configYaml: ['reviewer:', '  tiers:', '    default:', '      provider: ollama', '      consensus: 1', '      config:', '        model: test', `        endpoint: ${LOOPBACK_ENDPOINT}`, ''].join('\n'),
    });
    try {
      const { status, stdout } = run(['check'], dir);
      expect(status).toBe(1);
      expect(stdout).toContain('config-tier-name-reserved');
      expect(stdout).toContain("tier name 'default' is reserved");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // =========================================================================
  // GROUP E — reviewer.default resolution
  // =========================================================================

  it('E1: multiple tiers with NO reviewer.default yields config-default-tier-missing (exit 1)', () => {
    const dir = scaffold('default-missing', {
      configYaml: [
        'reviewer:',
        '  tiers:',
        VALID_TIER,
        '    deep:',
        '      provider: anthropic',
        '      consensus: 1',
        '      config:',
        '        model: claude',
        '',
      ].join('\n'),
    });
    try {
      const { status, stdout } = run(['check'], dir);
      expect(status).toBe(1);
      expect(stdout).toContain('config-default-tier-missing');
      expect(stdout).toContain('reviewer.default is required when multiple tiers are configured');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('E2: reviewer.default naming a non-existent tier yields config-default-tier-unknown (exit 1)', () => {
    const dir = scaffold('default-unknown', {
      configYaml: ['reviewer:', '  default: ghost', '  tiers:', VALID_TIER, ''].join('\n'),
    });
    try {
      const { status, stdout } = run(['check'], dir);
      expect(status).toBe(1);
      expect(stdout).toContain('config-default-tier-unknown');
      expect(stdout).toContain("reviewer.default is 'ghost' but no tier 'ghost' is configured");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // =========================================================================
  // GROUP F — reviewer-section shape (missing, unknown key)
  // =========================================================================

  it('F1: a config with no reviewer: block yields config-reviewer-missing (exit 1)', () => {
    // A valid YAML mapping (quality only) but no reviewer section. This is a
    // validator-level check (checkReviewerPresence), not a parser throw, so it
    // is distinct from the empty-file config-invalid case (G2).
    const dir = scaffold('reviewer-missing', {
      configYaml: ['quality:', '  max_direct_relations: 10', ''].join('\n'),
    });
    try {
      const { status, stdout } = run(['check'], dir);
      expect(status).toBe(1);
      expect(stdout).toContain('config-reviewer-missing');
      expect(stdout).toContain('yg-config.yaml has no reviewer: section');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('F2: an unknown key directly under reviewer: yields config-reviewer-unknown-key (exit 1)', () => {
    const dir = scaffold('reviewer-unknown-key', {
      configYaml: ['reviewer:', '  bogus: 1', '  tiers:', VALID_TIER, ''].join('\n'),
    });
    try {
      const { status, stdout } = run(['check'], dir);
      expect(status).toBe(1);
      expect(stdout).toContain('config-reviewer-unknown-key');
      expect(stdout).toContain("unknown key 'bogus' under reviewer:");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('F3: a multi-tier config with an EMPTY tiers mapping yields config-tiers-empty (exit 1)', () => {
    // reviewer present with `tiers:` but no entries → current-shape intent with
    // an unmet structural requirement.
    const dir = scaffold('tiers-empty', {
      configYaml: ['reviewer:', '  tiers: {}', ''].join('\n'),
    });
    try {
      const { status, stdout } = run(['check'], dir);
      expect(status).toBe(1);
      expect(stdout).toContain('config-tiers-empty');
      expect(stdout).toContain('reviewer.tiers is empty');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // =========================================================================
  // GROUP G — top-level + global config (quality, parallel, empty file)
  // =========================================================================

  it('G1: quality.max_node_chars that is negative yields config-invalid (exit 1)', () => {
    const dir = scaffold('max-node-chars-neg', {
      configYaml: ['quality:', '  max_node_chars: -5', 'reviewer:', '  tiers:', VALID_TIER, ''].join('\n'),
    });
    try {
      const { status, stdout } = run(['check'], dir);
      expect(status).toBe(1);
      expect(stdout).toContain('config-invalid');
      expect(stdout).toContain('quality.max_node_chars must be a positive integer');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('G1b: quality.max_node_chars that is zero yields config-invalid (exit 1)', () => {
    const dir = scaffold('max-node-chars-zero', {
      configYaml: ['quality:', '  max_node_chars: 0', 'reviewer:', '  tiers:', VALID_TIER, ''].join('\n'),
    });
    try {
      const { status, stdout } = run(['check'], dir);
      expect(status).toBe(1);
      expect(stdout).toContain('config-invalid');
      expect(stdout).toContain('quality.max_node_chars must be a positive integer');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('G2: a negative parallel yields config-invalid (exit 1)', () => {
    const dir = scaffold('parallel-neg', {
      configYaml: ['parallel: -2', 'reviewer:', '  tiers:', VALID_TIER, ''].join('\n'),
    });
    try {
      const { status, stdout } = run(['check'], dir);
      expect(status).toBe(1);
      expect(stdout).toContain('config-invalid');
      expect(stdout).toContain('parallel must be a positive integer >= 1');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('G2b: a non-numeric parallel yields config-invalid (exit 1)', () => {
    const dir = scaffold('parallel-string', {
      configYaml: ['parallel: lots', 'reviewer:', '  tiers:', VALID_TIER, ''].join('\n'),
    });
    try {
      const { status, stdout } = run(['check'], dir);
      expect(status).toBe(1);
      expect(stdout).toContain('config-invalid');
      expect(stdout).toContain('parallel must be a number');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('G3: an empty config file yields config-invalid (exit 1)', () => {
    const dir = scaffold('empty-config', { configYaml: '' });
    try {
      const { status, stdout } = run(['check'], dir);
      expect(status).toBe(1);
      expect(stdout).toContain('config-invalid');
      expect(stdout).toContain('empty or not a valid YAML mapping');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // =========================================================================
  // GROUP H — aspect-side tier validation (config-adjacent)
  // =========================================================================

  it('H1: a deterministic aspect declaring reviewer.tier yields aspect-tier-on-deterministic (exit 1)', () => {
    // The offending aspect fails to parse and is dropped from the graph, so the
    // node must NOT reference it (otherwise aspect-undefined piles on). The bare
    // parse error is then isolated; the orphaned-aspect warning is non-blocking.
    const dir = scaffold('tier-on-det', {
      configYaml: ['reviewer:', '  tiers:', VALID_TIER, ''].join('\n'),
      aspectYaml: [
        'name: Det',
        'description: A deterministic aspect that wrongly declares a tier',
        'reviewer:',
        '  type: deterministic',
        '  tier: standard',
        '',
      ].join('\n'),
      referenceAspect: false,
    });
    try {
      const { status, stdout } = run(['check'], dir);
      expect(status).toBe(1);
      expect(stdout).toContain('aspect-tier-on-deterministic');
      expect(stdout).toContain("reviewer.type: deterministic together with reviewer.tier: 'standard'");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('H2: an LLM aspect referencing a non-existent tier yields aspect-tier-unknown (exit 1)', () => {
    // The aspect PARSES fine (an unknown tier reference is not a parse error),
    // so the node references it and the validator-level checkAspectTierReferences
    // fires. The hermetic deterministic `det` aspect is replaced by an LLM aspect
    // pointing at a tier that is not configured.
    const dir = scaffold('aspect-tier-unknown', {
      configYaml: ['reviewer:', '  tiers:', VALID_TIER, ''].join('\n'),
      aspectYaml: [
        'name: Det',
        'description: An LLM aspect referencing a missing tier',
        'reviewer:',
        '  type: llm',
        '  tier: ghosttier',
        '',
      ].join('\n'),
      aspectRule: { file: 'content.md', body: 'Some rule.\n' },
    });
    try {
      const { status, stdout } = run(['check'], dir);
      expect(status).toBe(1);
      expect(stdout).toContain('aspect-tier-unknown');
      expect(stdout).toContain("references tier 'ghosttier' that does not exist");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
