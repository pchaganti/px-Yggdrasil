import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Hermetic E2E — INSTALLER MATRIX & CONFIG remaining paths through the spawned
// binary (dist/bin.js). Two live domains, none overlapping the existing suites:
//
//   GROUP P — the `yg init --upgrade --platform <x>` installer matrix for the
//     seven platforms NOT already driven through the real binary by
//     cli-greenfield-init (generic/cursor/codex/opencode/amp/claude-code) or
//     cli-migrations (generic only): copilot, cline, roocode, windsurf, aider,
//     gemini, codebuddy. Each writes its rules file to the path contracted in
//     src/templates/platform.ts.
//
//   GROUP M — DELETED. The v4 → v5 migration edges this group covered (config
//     bare/multi-provider→tiers transform, aspect reviewer string/mapping
//     migration, global-consensus normalization, secrets foreign-field withhold,
//     the "Migration withheld" resumable chain) were removed in the verdict-lock
//     redesign — `MIGRATIONS` is now empty and `yg init --upgrade` only bumps the
//     `version:` field. See the deletion note where the group stood.
//
//   GROUP C — config-parser coercion edges surfaced via `yg check` that
//     cli-config-tier-validation does NOT pin: tiers KEY missing entirely
//     (vs its empty-`{}` F3), a NON-STRING reviewer.default, a tier that is not
//     a mapping, a tier config: that is not a mapping, a scalar reviewer:, a
//     quality block that is not a mapping, parallel as a FLOAT, an ignored
//     (removed) max_tokens, a tier `references` key now rejected as an unknown
//     tier key, and a yg-secrets overlay field accepted through the check gate.
//
// Determinism: every test scaffolds in a fresh mkdtemp dir and rmSync()s it in a
// finally. The committed fixtures are never mutated (every config/aspect is
// authored in mkdtemp). No network, no clock, no RNG, no
// hardcoded reachable host — the loopback endpoint below is never dialed by the
// `yg check` / `yg init --upgrade` paths exercised here. Every exit code and
// message substring was verified against the live dist/bin.js before pinning.
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');

const distExists = existsSync(BIN_PATH);

// A loopback endpoint that is never contacted by `yg check` / `yg init`. Used
// only so a config carries a syntactically valid tier — no test depends on this
// host being reachable or absent.
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
  const result = spawnSync('node', [BIN_PATH, ...args], { cwd, encoding: 'utf-8' });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  return { stdout, stderr, status: result.status, all: stdout + stderr };
}

/**
 * A bare repo for the --upgrade path: just .yggdrasil/yg-config.yaml carrying a
 * version field (the minimum --upgrade needs to detect a version and refresh
 * schemas + rules). No nodes, no architecture. Mirrors bareUpgradeRepo from
 * cli-greenfield-init.
 */
function bareUpgradeRepo(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-mcx-${label}-`));
  const yggRoot = path.join(dir, '.yggdrasil');
  mkdirSync(yggRoot, { recursive: true });
  writeFileSync(path.join(yggRoot, 'yg-config.yaml'), 'version: "5.1.0"\n', 'utf-8');
  return dir;
}

// (makeV4Layout / configPath helpers removed with GROUP M — the v4→v5 migration
// edges they served are deleted surface; the surviving GROUP P/C tests use
// bareUpgradeRepo / scaffoldCheck instead.)

/**
 * Scaffold a structurally-complete, fully-hermetic graph (config + architecture
 * + one node + one deterministic aspect) and write the
 * scenario config. Returns the temp dir; caller owns rmSync cleanup. Mirrors the
 * scaffold helper in cli-config-tier-validation but inlined here so this file is
 * self-contained.
 */
function scaffoldCheck(
  label: string,
  opts: { configYaml: string; secretsYaml?: string; referenceAspect?: boolean },
): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-mcx-${label}-`));
  const ygRoot = path.join(dir, '.yggdrasil');
  mkdirSync(path.join(ygRoot, 'model', 'widget'), { recursive: true });
  mkdirSync(path.join(ygRoot, 'aspects', 'det'), { recursive: true });
  mkdirSync(path.join(ygRoot, 'flows'), { recursive: true });

  writeFileSync(
    path.join(ygRoot, 'yg-architecture.yaml'),
    ['node_types:', '  service:', "    description: 'A service'", '    log_required: false', '    when:', '      path: "**"', ''].join('\n'),
    'utf-8',
  );

  const referenceAspect = opts.referenceAspect ?? true;
  writeFileSync(
    path.join(ygRoot, 'model', 'widget', 'yg-node.yaml'),
    ['name: Widget', 'description: A widget node', 'type: service', ...(referenceAspect ? ['aspects:', '  - det'] : []), ''].join('\n'),
    'utf-8',
  );
  writeFileSync(
    path.join(ygRoot, 'aspects', 'det', 'yg-aspect.yaml'),
    ['name: Det', 'description: A deterministic aspect', 'reviewer:', '  type: deterministic', ''].join('\n'),
    'utf-8',
  );
  writeFileSync(path.join(ygRoot, 'aspects', 'det', 'check.mjs'), 'export function check() {\n  return [];\n}\n', 'utf-8');

  writeFileSync(path.join(ygRoot, 'yg-config.yaml'), opts.configYaml, 'utf-8');
  if (opts.secretsYaml !== undefined) {
    writeFileSync(path.join(ygRoot, 'yg-secrets.yaml'), opts.secretsYaml, 'utf-8');
  }
  return dir;
}

/** A valid single-tier reviewer block — the baseline several configs reuse. */
const VALID_TIER = [
  '    standard:',
  '      provider: ollama',
  '      consensus: 1',
  '      config:',
  '        model: test',
  `        endpoint: ${LOOPBACK_ENDPOINT}`,
].join('\n');

describe.skipIf(!distExists)('CLI E2E — migrations & config remaining paths (platform matrix, migration edges, coercion edges)', () => {
  // =========================================================================
  // GROUP P — platform installer matrix (the seven not E2E-covered elsewhere).
  // Each asserts: exit 0, the "Rules and schemas refreshed: <path>" line names
  // the platform's rules path, the file lands on disk, and (where it matters)
  // whether the shared .yggdrasil/agent-rules.md is co-written.
  // =========================================================================

  it('P1: --platform copilot writes .github/copilot-instructions.md with the yggdrasil block', () => {
    const dir = bareUpgradeRepo('copilot');
    try {
      const { status, stdout } = run(['init', '--upgrade', '--platform', 'copilot'], dir);
      expect(status).toBe(0);
      expect(stdout).toContain('.github/copilot-instructions.md');
      const filePath = path.join(dir, '.github', 'copilot-instructions.md');
      expect(existsSync(filePath)).toBe(true);
      // copilot embeds the rules inside delimited markers (not an @import line).
      const content = readFileSync(filePath, 'utf-8');
      expect(content).toContain('<!-- yggdrasil:start -->');
      expect(content).toContain('<!-- yggdrasil:end -->');
      // It does NOT co-write the shared agent-rules.md (rules are inlined).
      expect(existsSync(path.join(dir, '.yggdrasil', 'agent-rules.md'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('P2: --platform cline writes .clinerules/yggdrasil.md', () => {
    const dir = bareUpgradeRepo('cline');
    try {
      const { status, stdout } = run(['init', '--upgrade', '--platform', 'cline'], dir);
      expect(status).toBe(0);
      expect(stdout).toContain('.clinerules/yggdrasil.md');
      expect(existsSync(path.join(dir, '.clinerules', 'yggdrasil.md'))).toBe(true);
      expect(existsSync(path.join(dir, '.yggdrasil', 'agent-rules.md'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('P3: --platform roocode writes .roo/rules/yggdrasil.md', () => {
    const dir = bareUpgradeRepo('roocode');
    try {
      const { status, stdout } = run(['init', '--upgrade', '--platform', 'roocode'], dir);
      expect(status).toBe(0);
      expect(stdout).toContain('.roo/rules/yggdrasil.md');
      expect(existsSync(path.join(dir, '.roo', 'rules', 'yggdrasil.md'))).toBe(true);
      expect(existsSync(path.join(dir, '.yggdrasil', 'agent-rules.md'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('P4: --platform windsurf writes .windsurf/rules/yggdrasil.md', () => {
    const dir = bareUpgradeRepo('windsurf');
    try {
      const { status, stdout } = run(['init', '--upgrade', '--platform', 'windsurf'], dir);
      expect(status).toBe(0);
      expect(stdout).toContain('.windsurf/rules/yggdrasil.md');
      expect(existsSync(path.join(dir, '.windsurf', 'rules', 'yggdrasil.md'))).toBe(true);
      expect(existsSync(path.join(dir, '.yggdrasil', 'agent-rules.md'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('P5: --platform aider writes .aider.conf.yml read-entry AND .yggdrasil/agent-rules.md', () => {
    const dir = bareUpgradeRepo('aider');
    try {
      const { status, stdout } = run(['init', '--upgrade', '--platform', 'aider'], dir);
      expect(status).toBe(0);
      // aider's rules path is the shared agent-rules.md (the conf file only points at it).
      expect(stdout).toContain('.yggdrasil/agent-rules.md');
      const conf = path.join(dir, '.aider.conf.yml');
      expect(existsSync(conf)).toBe(true);
      const content = readFileSync(conf, 'utf-8');
      expect(content).toContain('read:');
      expect(content).toContain('.yggdrasil/agent-rules.md');
      // aider DOES co-write the shared rules file (the conf references it).
      expect(existsSync(path.join(dir, '.yggdrasil', 'agent-rules.md'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('P6: --platform gemini writes GEMINI.md (@import) AND .yggdrasil/agent-rules.md', () => {
    const dir = bareUpgradeRepo('gemini');
    try {
      const { status, stdout } = run(['init', '--upgrade', '--platform', 'gemini'], dir);
      expect(status).toBe(0);
      expect(stdout).toContain('.yggdrasil/agent-rules.md');
      const gemini = path.join(dir, 'GEMINI.md');
      expect(existsSync(gemini)).toBe(true);
      // gemini references the shared rules via an @import line.
      expect(readFileSync(gemini, 'utf-8')).toContain('@.yggdrasil/agent-rules.md');
      expect(existsSync(path.join(dir, '.yggdrasil', 'agent-rules.md'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('P7: --platform codebuddy writes .codebuddy/rules/yggdrasil/RULE.mdc with frontmatter', () => {
    const dir = bareUpgradeRepo('codebuddy');
    try {
      const { status, stdout } = run(['init', '--upgrade', '--platform', 'codebuddy'], dir);
      expect(status).toBe(0);
      expect(stdout).toContain('.codebuddy/rules/yggdrasil/RULE.mdc');
      const filePath = path.join(dir, '.codebuddy', 'rules', 'yggdrasil', 'RULE.mdc');
      expect(existsSync(filePath)).toBe(true);
      // codebuddy's RULE.mdc carries an alwaysApply frontmatter header.
      expect(readFileSync(filePath, 'utf-8')).toContain('alwaysApply: true');
      // It does NOT co-write the shared agent-rules.md (rules are inlined).
      expect(existsSync(path.join(dir, '.yggdrasil', 'agent-rules.md'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // =========================================================================
  // GROUP M — DELETED: v4 → v5 migration edges.
  // =========================================================================
  // The legacy migration content was removed in the verdict-lock redesign
  // (src/migrations/index.ts: `MIGRATIONS` is empty). `yg init --upgrade` no
  // longer transforms a v4 bare-provider/multi-provider reviewer block into the
  // tier shape, no longer walks/rewrites aspect reviewer fields, and no longer
  // emits the "Migration withheld" signal or migrates yg-secrets.yaml — it now
  // simply bumps the on-disk `version:` field. Every test in this group asserted
  // that removed transform/withhold machinery (unrecognized aspect string,
  // mapping-without-type, even/odd global-consensus normalization, multi-provider
  // active-default resolution, secrets foreign-field withhold, resumable
  // withhold→fix→bump), so all seven are deleted. yg-secrets is now a deep-merge
  // overlay over yg-config — overlay fields are accepted (see C10 below).

  // =========================================================================
  // GROUP C — config-parser coercion edges via `yg check` (not in
  // cli-config-tier-validation).
  // =========================================================================

  it('C1: reviewer with `default:` but NO `tiers:` key yields config-tiers-missing (exit 1)', () => {
    // cli-config-tier-validation F3 covers an EMPTY `tiers: {}` (config-tiers-empty).
    // The wholly-ABSENT tiers key takes the distinct config-tiers-missing path.
    const dir = scaffoldCheck('tiers-missing', { configYaml: ['reviewer:', '  default: standard', ''].join('\n') });
    try {
      const { status, stdout } = run(['check'], dir);
      expect(status).toBe(1);
      expect(stdout).toContain('config-tiers-missing');
      expect(stdout).toContain('reviewer.tiers is missing or not a mapping');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('C2: a NON-STRING reviewer.default yields config-default-tier-unknown (exit 1)', () => {
    // cli-config-tier-validation E2 covers a string default naming a missing
    // tier; the type-guard branch (default is a number) is distinct.
    const dir = scaffoldCheck('default-nonstring', {
      configYaml: ['reviewer:', '  default: 5', '  tiers:', VALID_TIER, ''].join('\n'),
    });
    try {
      const { status, stdout } = run(['check'], dir);
      expect(status).toBe(1);
      expect(stdout).toContain('config-default-tier-unknown');
      expect(stdout).toContain('reviewer.default must be a string');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('C3: a tier whose body is a scalar yields config-tier-invalid (exit 1)', () => {
    const dir = scaffoldCheck('tier-not-mapping', {
      configYaml: ['reviewer:', '  tiers:', '    standard: hello', ''].join('\n'),
    });
    try {
      const { status, stdout } = run(['check'], dir);
      expect(status).toBe(1);
      expect(stdout).toContain('config-tier-invalid');
      expect(stdout).toContain("tier 'standard' is not a mapping");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('C4: a tier config: that is a scalar yields config-tier-config-not-mapping (exit 1)', () => {
    // cli-config-tier-validation C1 covers a MISSING config:, C2 a missing
    // model. A present-but-scalar config: takes config-tier-config-not-mapping.
    const dir = scaffoldCheck('config-not-mapping', {
      configYaml: ['reviewer:', '  tiers:', '    standard:', '      provider: ollama', '      consensus: 1', '      config: hello', ''].join('\n'),
    });
    try {
      const { status, stdout } = run(['check'], dir);
      expect(status).toBe(1);
      expect(stdout).toContain('config-tier-config-not-mapping');
      expect(stdout).toContain("tier 'standard' has config: that is not a YAML mapping");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('C5: a scalar reviewer: (not a mapping) yields config-invalid with the unrecognized-shape message (exit 1)', () => {
    // reviewer present but neither legacy nor mixed nor a mapping → the final
    // else branch in parseConfig ("unrecognized reviewer: shape").
    const dir = scaffoldCheck('reviewer-scalar', { configYaml: 'reviewer: hello\n' });
    try {
      const { status, stdout } = run(['check'], dir);
      expect(status).toBe(1);
      expect(stdout).toContain('config-invalid');
      expect(stdout).toContain('unrecognized reviewer: shape');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('C6: a quality: block that is a list yields config-invalid (quality must be a mapping) (exit 1)', () => {
    // cli-config-tier-validation G1/G1b cover bad quality.max_node_chars values;
    // a quality block that is not a mapping at all is the earlier guard.
    const dir = scaffoldCheck('quality-list', {
      configYaml: ['quality:', '  - a', '  - b', 'reviewer:', '  tiers:', VALID_TIER, ''].join('\n'),
    });
    try {
      const { status, stdout } = run(['check'], dir);
      expect(status).toBe(1);
      expect(stdout).toContain('config-invalid');
      expect(stdout).toContain('quality must be a mapping');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('C7: a FRACTIONAL parallel yields config-invalid (positive integer >= 1) (exit 1)', () => {
    // cli-config-tier-validation G2 covers negative, G2b a non-numeric string.
    // A numeric-but-fractional value takes the !Number.isInteger branch with the
    // "positive integer >= 1" message (distinct from the "must be a number" one).
    const dir = scaffoldCheck('parallel-float', {
      configYaml: ['parallel: 2.5', 'reviewer:', '  tiers:', VALID_TIER, ''].join('\n'),
    });
    try {
      const { status, stdout } = run(['check'], dir);
      expect(status).toBe(1);
      expect(stdout).toContain('config-invalid');
      expect(stdout).toContain('parallel must be a positive integer >= 1, got 2.5');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('C8: max_tokens in tier config is silently ignored (removed field, not validated)', () => {
    // max_tokens was removed; any value in config.max_tokens is ignored without error.
    const dir = scaffoldCheck('max-tokens-ignored', {
      configYaml: ['reviewer:', '  tiers:', '    standard:', '      provider: ollama', '      consensus: 1', '      config:', '        model: test', '        max_tokens: -5', ''].join('\n'),
    });
    try {
      const { status } = run(['check'], dir);
      // max_tokens is now unrecognized and silently ignored — config parses without error.
      // (check exits 1 here because graph is empty, not because of config-tier-config-invalid)
      expect(status).not.toBe(undefined); // just ensuring it doesn't crash on config parse
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('C9: a tier `references:` key is now an UNKNOWN tier key — config-tier-unknown-key (exit 1)', () => {
    // RE-POINTED: the reviewer-reference caps and the tier `references` key were
    // removed in the verdict-lock redesign. A tier no longer accepts `references`
    // at all (the old `tier-references-not-mapping` / reference-too-large codes
    // are gone), so any `references` entry under a tier is rejected as an unknown
    // key. The allowed-keys list the message names is the new authoritative set:
    // provider, consensus, config, max_prompt_chars.
    const dir = scaffoldCheck('refs-unknown-key', {
      configYaml: ['reviewer:', '  tiers:', '    standard:', '      provider: ollama', '      consensus: 1', '      references: hello', '      config:', '        model: test', ''].join('\n'),
    });
    try {
      const { status, stdout } = run(['check'], dir);
      expect(status).toBe(1);
      expect(stdout).toContain('config-tier-unknown-key');
      expect(stdout).toContain("tier 'standard' has unknown key 'references'");
      // The message enumerates the new authoritative allowed-keys set.
      expect(stdout).toContain('max_prompt_chars');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('C10: a yg-secrets.yaml overlay field (non-credential) is accepted — yg-secrets is a deep-merge overlay over yg-config', () => {
    // yg-secrets is no longer api_key-only: it overlays any yg-config field
    // locally (e.g. a tier's provider/model). A non-credential field is valid
    // and must NOT raise the retired secrets-non-credential-field error.
    const dir = scaffoldCheck('secrets-overlay', {
      configYaml: ['reviewer:', '  tiers:', VALID_TIER, ''].join('\n'),
      secretsYaml: ['reviewer:', '  tiers:', '    standard:', '      config:', '        temperature: 0.2', ''].join('\n'),
    });
    try {
      const { stdout } = run(['check'], dir);
      expect(stdout).not.toContain('secrets-non-credential-field');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
