import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  cpSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Hermetic E2E — MIGRATIONS & CONFIG remaining paths through the spawned binary
// (dist/bin.js). Three domains, none overlapping the existing suites:
//
//   GROUP P — the `yg init --upgrade --platform <x>` installer matrix for the
//     seven platforms NOT already driven through the real binary by
//     cli-greenfield-init (generic/cursor/codex/opencode/amp/claude-code) or
//     cli-migrations (generic only): copilot, cline, roocode, windsurf, aider,
//     gemini, codebuddy. Each writes its rules file to the path contracted in
//     src/templates/platform.ts.
//
//   GROUP M — v4 → v5 migration edges NOT pinned by cli-migrations (which pins
//     single-provider config→tiers (M1), idempotency (M2), multi-provider
//     no-active reject (M3), and aspect `ast`/absent (M4)): an UNRECOGNIZED
//     legacy aspect reviewer string, an aspect reviewer mapping with no `type:`,
//     an EVEN global consensus reject, single-tier per-tier consensus
//     normalization, multi-provider-WITH-active default resolution + consensus
//     copy, a yg-secrets foreign-field withhold IN ISOLATION, and the resumable
//     chain (withheld → fix → completed bump).
//
//   GROUP C — config-parser coercion edges surfaced via `yg check` that
//     cli-config-tier-validation does NOT pin: tiers KEY missing entirely
//     (vs its empty-`{}` F3), a NON-STRING reviewer.default, a tier that is not
//     a mapping, a tier config: that is not a mapping, a scalar reviewer:, a
//     quality block that is not a mapping, parallel as a FLOAT, an invalid
//     max_tokens, a non-mapping references:, and the secrets-non-credential
//     field through the check gate.
//
// Determinism: every test scaffolds in a fresh mkdtemp dir and rmSync()s it in a
// finally. The committed fixtures are never mutated (schemas are cpSync-copied,
// every config/aspect is authored in mkdtemp). No network, no clock, no RNG, no
// hardcoded reachable host — the loopback endpoint below is never dialed by the
// `yg check` / `yg init --upgrade` paths exercised here. Every exit code and
// message substring was verified against the live dist/bin.js before pinning.
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const SCHEMAS_DIR = path.join(
  CLI_ROOT,
  'tests',
  'fixtures',
  'sample-project',
  '.yggdrasil',
  'schemas',
);

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
  writeFileSync(path.join(yggRoot, 'yg-config.yaml'), 'version: "5.0.0"\n', 'utf-8');
  return dir;
}

/**
 * Build a minimal v4.x `.yggdrasil` layout in a fresh temp dir. The migration
 * runner (`yg init --upgrade`) needs only a `version:` field plus a `schemas/`
 * directory; aspects/secrets are added per-scenario. Mirrors makeV4Layout from
 * cli-migrations.
 */
function makeV4Layout(label: string, configBody: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-mcx-${label}-`));
  const yggDir = path.join(dir, '.yggdrasil');
  mkdirSync(path.join(yggDir, 'schemas'), { recursive: true });
  writeFileSync(path.join(yggDir, 'yg-config.yaml'), configBody, 'utf-8');
  return dir;
}

const configPath = (dir: string) => path.join(dir, '.yggdrasil', 'yg-config.yaml');

/**
 * Scaffold a structurally-complete, fully-hermetic graph (config + architecture
 * + one node + one deterministic aspect + the three schemas) and write the
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
  cpSync(SCHEMAS_DIR, path.join(ygRoot, 'schemas'), { recursive: true });

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
  // GROUP M — v4 → v5 migration edges not pinned by cli-migrations.
  // =========================================================================

  it('M1: an UNRECOGNIZED legacy aspect reviewer string withholds the bump (exit 1) but migrates the config', () => {
    // cli-migrations M4 covers `ast`/absent; the unrecognized-string branch of
    // transformAspectReviewer is distinct. The config migration runs FIRST and
    // rewrites the reviewer to the tier shape, but the aspect warning withholds
    // the version bump — so the config carries the tier shape at the PRIOR
    // (unquoted) version.
    const dir = makeV4Layout(
      'unrec-aspect',
      ['version: "4.3.0"', 'reviewer:', '  ollama:', '    model: qwen3', `    endpoint: ${LOOPBACK_ENDPOINT}`, ''].join('\n'),
    );
    const aspectDir = path.join(dir, '.yggdrasil', 'aspects', 'legacy-fancy');
    try {
      mkdirSync(aspectDir, { recursive: true });
      writeFileSync(
        path.join(aspectDir, 'yg-aspect.yaml'),
        ['id: legacy-fancy', 'description: A legacy aspect with a bogus reviewer string.', 'reviewer: fancy', ''].join('\n'),
        'utf-8',
      );

      const { status, all } = run(['init', '--upgrade', '--platform', 'generic'], dir);
      expect(status).toBe(1);
      expect(all).toContain('Migration withheld');
      expect(all).toContain('the version bump was NOT applied');
      expect(all).toContain("unrecognized reviewer value 'fancy'");
      expect(all).not.toContain('Rules and schemas refreshed');

      const config = readFileSync(configPath(dir), 'utf-8');
      // The config WAS migrated to the tier shape (config step ran before the
      // withhold)...
      expect(config).toContain('tiers:');
      expect(config).toContain('provider: ollama');
      // ...but the version bump was withheld, so it is NOT 5.0.0.
      expect(config).not.toContain('5.0.0');
      // The bad aspect was left untouched.
      expect(readFileSync(path.join(aspectDir, 'yg-aspect.yaml'), 'utf-8')).toContain('reviewer: fancy');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('M2: an aspect reviewer MAPPING with no `type:` key withholds the bump (exit 1)', () => {
    // The mapping-without-type branch of transformAspectReviewer: a half-formed
    // mapping the migration cannot complete. It emits a warning and withholds.
    const dir = makeV4Layout(
      'aspect-notype',
      ['version: "4.3.0"', 'reviewer:', '  ollama:', '    model: qwen3', `    endpoint: ${LOOPBACK_ENDPOINT}`, ''].join('\n'),
    );
    const aspectDir = path.join(dir, '.yggdrasil', 'aspects', 'legacy-notype');
    try {
      mkdirSync(aspectDir, { recursive: true });
      writeFileSync(
        path.join(aspectDir, 'yg-aspect.yaml'),
        ['id: legacy-notype', 'description: A legacy aspect whose reviewer mapping lacks type.', 'reviewer:', '  tier: standard', ''].join('\n'),
        'utf-8',
      );

      const { status, all } = run(['init', '--upgrade', '--platform', 'generic'], dir);
      expect(status).toBe(1);
      expect(all).toContain('Migration withheld');
      expect(all).toContain('reviewer mapping has no `type:` key');
      expect(readFileSync(configPath(dir), 'utf-8')).not.toContain('5.0.0');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('M3: an EVEN global reviewer.consensus withholds the bump and leaves the config byte-identical (exit 1)', () => {
    // transformConfigReviewer rejects an even global consensus before producing
    // any tier shape — so unlike M1/M2 the config is NOT rewritten at all here.
    const badConfig = ['version: "4.3.0"', 'reviewer:', '  consensus: 4', '  ollama:', '    model: qwen3', `    endpoint: ${LOOPBACK_ENDPOINT}`, ''].join('\n');
    const dir = makeV4Layout('consensus-even', badConfig);
    try {
      const { status, all } = run(['init', '--upgrade', '--platform', 'generic'], dir);
      expect(status).toBe(1);
      expect(all).toContain('Migration withheld');
      expect(all).toContain('global reviewer.consensus 4 is even');
      // Reject-before-transform: the config file is byte-identical.
      expect(readFileSync(configPath(dir), 'utf-8')).toBe(badConfig);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('M4: a single-provider config with global consensus 3 normalizes consensus 3 into the tier and bumps (exit 0)', () => {
    // cli-migrations M1 covers single-provider with NO consensus (defaults to 1).
    // Here an odd global consensus 3 is carried INTO the single tier.
    const dir = makeV4Layout(
      'consensus3-single',
      ['version: "4.3.0"', 'reviewer:', '  consensus: 3', '  ollama:', '    model: qwen3', `    endpoint: ${LOOPBACK_ENDPOINT}`, ''].join('\n'),
    );
    try {
      const { status } = run(['init', '--upgrade', '--platform', 'generic'], dir);
      expect(status).toBe(0);
      const config = readFileSync(configPath(dir), 'utf-8');
      expect(config).toContain('version: "5.0.0"');
      expect(config).toContain('tiers:');
      expect(config).toContain('provider: ollama');
      expect(config).toContain('consensus: 3');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('M5: multi-provider WITH reviewer.active resolves the default tier and copies consensus to every tier (exit 0)', () => {
    // cli-migrations M3 covers multi-provider WITHOUT active (reject). With
    // active present, transformConfigReviewer infers the default and migrates
    // both providers into tiers, carrying the odd global consensus onto each.
    const dir = makeV4Layout(
      'multi-active',
      ['version: "4.3.0"', 'reviewer:', '  active: ollama', '  consensus: 3', '  ollama:', '    model: qwen3', '  openai:', '    model: gpt-4', ''].join('\n'),
    );
    try {
      const { status } = run(['init', '--upgrade', '--platform', 'generic'], dir);
      expect(status).toBe(0);
      const config = readFileSync(configPath(dir), 'utf-8');
      expect(config).toContain('version: "5.0.0"');
      // Both providers became tiers...
      expect(config).toContain('provider: ollama');
      expect(config).toContain('provider: openai');
      // ...with the active provider chosen as the default...
      expect(config).toContain('default: ollama');
      // ...and the odd global consensus copied onto each tier.
      expect(config).toContain('consensus: 3');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('M6: a yg-secrets.yaml foreign field withholds the bump IN ISOLATION (clean config, exit 1)', () => {
    // The config migrates cleanly to tiers; the SOLE blocker is a non-credential
    // field in yg-secrets.yaml. migrateSecretsFile emits the warning that
    // withholds the bump — proving the secrets signal stands on its own.
    const dir = makeV4Layout(
      'secrets-foreign',
      ['version: "4.3.0"', 'reviewer:', '  ollama:', '    model: qwen3', `    endpoint: ${LOOPBACK_ENDPOINT}`, ''].join('\n'),
    );
    try {
      writeFileSync(
        path.join(dir, '.yggdrasil', 'yg-secrets.yaml'),
        ['reviewer:', '  openai:', '    api_key: sk-placeholder', '    organization: org-123', '    model: gpt-4', ''].join('\n'),
        'utf-8',
      );
      const { status, all } = run(['init', '--upgrade', '--platform', 'generic'], dir);
      expect(status).toBe(1);
      expect(all).toContain('Migration withheld');
      expect(all).toContain("provider 'openai' has non-credential fields");
      expect(all).toContain('organization');
      // Config migrated to tiers but the bump was withheld.
      const config = readFileSync(configPath(dir), 'utf-8');
      expect(config).toContain('tiers:');
      expect(config).not.toContain('5.0.0');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('M7: the migration chain is RESUMABLE — withheld on a bad aspect, then completes the bump after the fix', () => {
    // First run migrates the config to tiers but withholds the bump on a bogus
    // aspect reviewer string. After the aspect is fixed (to `ast`), the second
    // run re-runs the (already-idempotent) config step, migrates the aspect
    // (`ast` → { type: deterministic }), and completes the bump to 5.0.0.
    const dir = makeV4Layout(
      'resumable',
      ['version: "4.3.0"', 'reviewer:', '  ollama:', '    model: qwen3', `    endpoint: ${LOOPBACK_ENDPOINT}`, ''].join('\n'),
    );
    const aspectFile = path.join(dir, '.yggdrasil', 'aspects', 'legacy-fancy', 'yg-aspect.yaml');
    try {
      mkdirSync(path.dirname(aspectFile), { recursive: true });
      writeFileSync(aspectFile, ['id: legacy-fancy', 'description: x', 'reviewer: fancy', ''].join('\n'), 'utf-8');

      const first = run(['init', '--upgrade', '--platform', 'generic'], dir);
      expect(first.status).toBe(1);
      expect(first.all).toContain('Migration withheld');
      expect(readFileSync(configPath(dir), 'utf-8')).not.toContain('5.0.0');

      // Fix the aspect: a recognized legacy AST string.
      writeFileSync(aspectFile, ['id: legacy-fancy', 'description: x', 'reviewer: ast', ''].join('\n'), 'utf-8');

      const second = run(['init', '--upgrade', '--platform', 'generic'], dir);
      expect(second.status).toBe(0);
      expect(second.stdout).toContain('Rules and schemas refreshed');
      const config = readFileSync(configPath(dir), 'utf-8');
      expect(config).toContain('version: "5.0.0"');
      // The aspect was migrated this time around.
      const aspectAfter = readFileSync(aspectFile, 'utf-8');
      expect(aspectAfter).toContain('type: deterministic');
      expect(aspectAfter).not.toMatch(/reviewer:\s*ast/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

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

  it('C8: a negative tier config.max_tokens yields config-tier-config-invalid (exit 1)', () => {
    const dir = scaffoldCheck('max-tokens-bad', {
      configYaml: ['reviewer:', '  tiers:', '    standard:', '      provider: ollama', '      consensus: 1', '      config:', '        model: test', '        max_tokens: -5', ''].join('\n'),
    });
    try {
      const { status, stdout } = run(['check'], dir);
      expect(status).toBe(1);
      expect(stdout).toContain('config-tier-config-invalid');
      expect(stdout).toContain("config.max_tokens must be 'auto' or a positive number");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('C9: a tier references: that is a scalar yields tier-references-not-mapping (exit 1)', () => {
    const dir = scaffoldCheck('refs-not-map', {
      configYaml: ['reviewer:', '  tiers:', '    standard:', '      provider: ollama', '      consensus: 1', '      references: hello', '      config:', '        model: test', ''].join('\n'),
    });
    try {
      const { status, stdout } = run(['check'], dir);
      expect(status).toBe(1);
      expect(stdout).toContain('tier-references-not-mapping');
      expect(stdout).toContain("tier 'standard' has 'references' that is not a YAML mapping");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('C10: a yg-secrets.yaml non-credential field is rejected by yg check as secrets-non-credential-field (exit 1)', () => {
    // The check gate surfaces the same secrets defect the migration runner does,
    // but as a validator code (independent of any upgrade run). The config is
    // valid v5 so the SOLE error is the foreign secrets field.
    const dir = scaffoldCheck('secrets-foreign', {
      configYaml: ['reviewer:', '  tiers:', VALID_TIER, ''].join('\n'),
      secretsYaml: ['reviewer:', '  ollama:', '    api_key: sk-placeholder', '    organization: org-123', ''].join('\n'),
    });
    try {
      const { status, stdout } = run(['check'], dir);
      expect(status).toBe(1);
      expect(stdout).toContain('secrets-non-credential-field');
      expect(stdout).toContain("'organization' under reviewer.ollama");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
