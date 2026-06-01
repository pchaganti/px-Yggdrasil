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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
// e2e-lifecycle is a complete v5 graph (config + architecture + model nodes +
// aspects). We reuse it for the scenarios that need `yg check` / `yg tree` to
// resolve a real graph root, and we build minimal v4 layouts from scratch for
// the migration-input scenarios.
const FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'e2e-lifecycle');

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
  const result = spawnSync('node', [BIN_PATH, ...args], {
    cwd,
    encoding: 'utf-8',
  });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  return { stdout, stderr, status: result.status, all: stdout + stderr };
}

/** Copy the complete e2e-lifecycle fixture into a fresh temp dir for mutation. */
function copyFixture(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-mig-${label}-`));
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

/**
 * Build a minimal v4.x `.yggdrasil` layout from scratch in a fresh temp dir.
 * The migration runner (`yg init --upgrade`) only needs a `version:` field plus
 * a `schemas/` directory to exist; aspects are optional and added per-scenario.
 * Everything here is written into mkdtemp — the committed fixture is never
 * touched.
 */
function makeV4Layout(label: string, configBody: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-mig-${label}-`));
  const yggDir = path.join(dir, '.yggdrasil');
  mkdirSync(path.join(yggDir, 'schemas'), { recursive: true });
  writeFileSync(path.join(yggDir, 'yg-config.yaml'), configBody, 'utf-8');
  return dir;
}

const configPath = (dir: string) =>
  path.join(dir, '.yggdrasil', 'yg-config.yaml');

// ---------------------------------------------------------------------------
// Migration paths (v4.x → v5.0.0) NOT already covered by cli-lifecycle.test.ts.
// Fully hermetic: no network, no LLM, no real endpoints, fresh mkdtemp per test.
// ---------------------------------------------------------------------------

describe.skipIf(!distExists)('CLI E2E — schema migrations (v4 → v5 config/aspect/version-guard)', () => {
  // --- 1. Single-provider v4.3.0 config → v5 tiers ---

  it('M1: v4.3.0 single-provider config upgrades to v5 with version 5.0.0 and reviewer.tiers', () => {
    // A v4.3.0 config carrying a single bare provider section (no
    // reviewer.active, no reviewer.tiers). transformConfigReviewer infers the
    // sole provider as the default tier and rewrites to the tier shape.
    const dir = makeV4Layout(
      'm1',
      [
        'version: "4.3.0"',
        'reviewer:',
        '  ollama:',
        '    model: qwen3',
        '    endpoint: http://localhost:11434',
        '',
      ].join('\n'),
    );
    try {
      const { status } = run(['init', '--upgrade', '--platform', 'generic'], dir);
      expect(status).toBe(0);

      const config = readFileSync(configPath(dir), 'utf-8');
      // Version bumped to the migration target.
      expect(config).toContain('version: "5.0.0"');
      // Reviewer migrated to the tier-based shape.
      expect(config).toContain('tiers:');
      expect(config).toContain('provider: ollama');
      // The legacy bare-provider shape is gone.
      expect(config).not.toMatch(/^reviewer:\n {2}ollama:\n {4}model:/m);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- 2. Idempotency on an already-v5 repo ---

  it('M2: upgrading an already-v5 repo twice is a no-op — config byte-identical between runs', () => {
    const dir = copyFixture('m2');
    try {
      // First upgrade on the v5 fixture: nothing to migrate (5.0.0 is the
      // latest target), so the config must be left untouched.
      const first = run(['init', '--upgrade', '--platform', 'generic'], dir);
      expect(first.status).toBe(0);
      const afterFirst = readFileSync(configPath(dir), 'utf-8');

      // Second upgrade: must produce a byte-identical config.
      const second = run(['init', '--upgrade', '--platform', 'generic'], dir);
      expect(second.status).toBe(0);
      const afterSecond = readFileSync(configPath(dir), 'utf-8');

      expect(afterSecond).toBe(afterFirst);
      // And it is genuinely the v5 shape, not some degenerate empty file.
      expect(afterSecond).toContain('version: "5.0.0"');
      expect(afterSecond).toContain('tiers:');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- 3. Bad config: migration blocks the version bump and does NOT mutate ---

  it('M3: an unmigratable v4 config is left byte-identical and `yg check` rejects it with a migration hint', () => {
    // Multiple bare providers WITHOUT reviewer.active: transformConfigReviewer
    // cannot infer which tier should be default, so it emits a warning and
    // withholds the version bump (the file MUST NOT be rewritten). We build
    // this on top of the complete e2e-lifecycle fixture so `yg check` can
    // resolve a real graph root afterwards.
    const dir = copyFixture('m3');
    const badConfig = [
      'version: "4.3.0"',
      'reviewer:',
      '  ollama:',
      '    model: qwen3',
      '    endpoint: http://localhost:11434',
      '  openai:',
      '    model: gpt-4',
      '',
    ].join('\n');
    try {
      writeFileSync(configPath(dir), badConfig, 'utf-8');

      // The non-interactive `yg init --upgrade --platform` path must NOT swallow
      // migration warnings. When transformConfigReviewer blocks the migration,
      // the command surfaces the warning and exits 1 — the agent/CI gets a clear
      // signal that the version bump was withheld, instead of a false success.
      const upgrade = run(['init', '--upgrade', '--platform', 'generic'], dir);
      expect(upgrade.status).toBe(1);
      // The withheld-bump signal and the underlying migration warning are both
      // surfaced — the agent/CI is told the version bump was NOT applied.
      expect(upgrade.all).toContain('Migration withheld');
      expect(upgrade.all).toContain('the version bump was NOT applied');
      expect(upgrade.all).toContain('without reviewer.active');
      // It must NOT falsely claim success.
      expect(upgrade.all).not.toContain('Rules and schemas refreshed');

      // Config must be byte-identical — no partial / silent mutation.
      const after = readFileSync(configPath(dir), 'utf-8');
      expect(after).toBe(badConfig);
      // Version must NOT have been bumped.
      expect(after).toContain('version: "4.3.0"');

      // The real enforcement: `yg check` rejects the still-legacy (outdated) config and
      // points the agent at the migration command.
      const check = run(['check'], dir);
      expect(check.status).toBe(1);
      expect(check.all).toContain('older than this CLI');
      expect(check.all).toContain('yg init --upgrade');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- 4. Aspect reviewer field migration (string → mapping) ---

  it('M4: aspect `reviewer: ast` → { type: deterministic }; missing reviewer → { type: llm }', () => {
    // A clean single-provider config so the config migration succeeds and the
    // runner proceeds to walk and rewrite the aspect reviewer fields.
    const dir = makeV4Layout(
      'm4',
      [
        'version: "4.3.0"',
        'reviewer:',
        '  ollama:',
        '    model: qwen3',
        '    endpoint: http://localhost:11434',
        '',
      ].join('\n'),
    );
    const aspectsDir = path.join(dir, '.yggdrasil', 'aspects');
    try {
      // v4 aspect with the legacy `reviewer: ast` string.
      const astDir = path.join(aspectsDir, 'legacy-ast');
      mkdirSync(astDir, { recursive: true });
      writeFileSync(
        path.join(astDir, 'yg-aspect.yaml'),
        ['id: legacy-ast', 'description: A legacy AST aspect.', 'reviewer: ast', ''].join('\n'),
        'utf-8',
      );

      // v4 aspect with NO reviewer field at all.
      const noneDir = path.join(aspectsDir, 'legacy-noreviewer');
      mkdirSync(noneDir, { recursive: true });
      writeFileSync(
        path.join(noneDir, 'yg-aspect.yaml'),
        ['id: legacy-noreviewer', 'description: A legacy aspect with no reviewer field.', ''].join('\n'),
        'utf-8',
      );

      const { status } = run(['init', '--upgrade', '--platform', 'generic'], dir);
      expect(status).toBe(0);

      // Config migrated cleanly → version bumped → aspects were walked.
      expect(readFileSync(configPath(dir), 'utf-8')).toContain('version: "5.0.0"');

      // `reviewer: ast` (legacy AST) maps to the deterministic reviewer type.
      const astAfter = readFileSync(path.join(astDir, 'yg-aspect.yaml'), 'utf-8');
      expect(astAfter).toContain('reviewer:');
      expect(astAfter).toContain('type: deterministic');
      expect(astAfter).not.toMatch(/reviewer:\s*ast/);

      // Absent reviewer defaults to the llm reviewer type.
      const noneAfter = readFileSync(path.join(noneDir, 'yg-aspect.yaml'), 'utf-8');
      expect(noneAfter).toContain('reviewer:');
      expect(noneAfter).toContain('type: llm');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- 5. Version-too-new guard (config schema newer than the CLI supports) ---

  it('M5: a config version newer than the CLI supports blocks `yg check` and `yg tree` (exit 1)', () => {
    // CLI_SUPPORTED_SCHEMA in graph-loader.ts is 5.0.0; a config at 99.0.0 must
    // be refused by every command that loads the graph. We keep the v5 reviewer
    // shape intact and only raise the version field.
    const dir = copyFixture('m5');
    try {
      const original = readFileSync(configPath(dir), 'utf-8');
      const bumped = original.replace(/^version:\s.*$/m, 'version: "99.0.0"');
      writeFileSync(configPath(dir), bumped, 'utf-8');

      const check = run(['check'], dir);
      expect(check.status).toBe(1);
      expect(check.all).toContain('newer than this CLI supports');
      expect(check.all).toContain('max: 5.0.0');
      // A newer-than-CLI config is an expected USER error (upgrade your CLI),
      // not an internal bug — it must NOT be wrapped as "please file an issue".
      expect(check.all).not.toContain('file an issue');
      expect(check.all).not.toContain('This is a bug');

      const tree = run(['tree'], dir);
      expect(tree.status).toBe(1);
      expect(tree.all).toContain('newer than this CLI supports');
      expect(tree.all).toContain('max: 5.0.0');
      expect(tree.all).not.toContain('file an issue');
      expect(tree.all).not.toContain('This is a bug');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- 6. Drift-state baseline migration (flat synthetic-key shape → typed) ---
  //
  // The unit suite (to-5.0.0-drift-state.test.ts) exercises migrateTo50's
  // drift-state logic directly. These prove the COMMAND wiring: `yg init
  // --upgrade` actually walks .drift-state/, re-keys each baseline on disk,
  // and gates the version bump on the outcome.

  /** Plant a raw drift-state baseline file under <dir>/.yggdrasil/.drift-state/<nodePath>.json. */
  function writeBaseline(dir: string, nodePath: string, raw: string): void {
    const file = path.join(dir, '.yggdrasil', '.drift-state', `${nodePath}.json`);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, raw, 'utf-8');
  }
  const readBaseline = (dir: string, nodePath: string): Record<string, unknown> =>
    JSON.parse(readFileSync(path.join(dir, '.yggdrasil', '.drift-state', `${nodePath}.json`), 'utf-8'));

  it('M6: a flat pre-verdict baseline (nested path, synthetic keys) is re-keyed to typed with approved-synthesis', () => {
    const dir = makeV4Layout(
      'm6',
      ['version: "4.3.0"', 'reviewer:', '  ollama:', '    model: q', '    endpoint: http://x', ''].join('\n'),
    );
    try {
      // Old flat shape: real file + the synthetic identity keys, NO aspectVerdicts.
      writeBaseline(dir, 'svc/handler', JSON.stringify({
        hash: 'OLD_HASH',
        files: {
          'src/foo.ts': 'h-foo',
          'own-subset:svc/handler': 'h-own',
          'aspect-meta:alpha': 'h-alpha',
          'tier-identity:alpha': 'h-tier',
        },
      }));

      const { status } = run(['init', '--upgrade', '--platform', 'generic'], dir);
      expect(status).toBe(0);
      // Config bumped — the drift-state pass succeeded, so the runner advanced the version.
      expect(readFileSync(configPath(dir), 'utf-8')).toContain('version: "5.0.0"');

      const typed = readBaseline(dir, 'svc/handler') as {
        schemaVersion: number;
        files: Record<string, string>;
        identity: { ownSubset: string; ports: Record<string, string>; aspects: Record<string, unknown> };
        aspectVerdicts: Record<string, unknown>;
        hash: string;
      };
      expect(typed.schemaVersion).toBe(1);
      // Synthetic keys are lifted out of `files`; only the real file remains.
      expect(typed.files).toEqual({ 'src/foo.ts': 'h-foo' });
      // Typed identity reconstructed from the synthetic kinds.
      expect(typed.identity.ownSubset).toBe('h-own');
      expect(typed.identity.aspects.alpha).toEqual({ meta: 'h-alpha', tier: 'h-tier' });
      // Pre-verdict baseline → each identity aspect recorded as approved (carries the
      // last-approve state forward instead of flooding the first check with newly-active).
      expect(typed.aspectVerdicts).toEqual({ alpha: { verdict: 'approved' } });
      // Hash recomputed (lossless) — no longer the placeholder.
      expect(typed.hash).not.toBe('OLD_HASH');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('M7: a baseline that already carries aspectVerdicts has them preserved verbatim (no approved-synthesis)', () => {
    const dir = makeV4Layout(
      'm7',
      ['version: "4.3.0"', 'reviewer:', '  ollama:', '    model: q', '    endpoint: http://x', ''].join('\n'),
    );
    try {
      writeBaseline(dir, 'svc', JSON.stringify({
        hash: 'x',
        files: { 'src/a.ts': 'h-a', 'aspect-meta:alpha': 'h-alpha' },
        aspectVerdicts: { alpha: { verdict: 'refused', reason: 'bad', errorSource: 'codeViolation' } },
      }));

      const { status } = run(['init', '--upgrade', '--platform', 'generic'], dir);
      expect(status).toBe(0);

      const typed = readBaseline(dir, 'svc') as { aspectVerdicts: Record<string, unknown> };
      // A recorded refusal must NOT be silently upgraded to approved by the migration.
      expect(typed.aspectVerdicts).toEqual({
        alpha: { verdict: 'refused', reason: 'bad', errorSource: 'codeViolation' },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('M8: an unparseable baseline is deleted, withholds the version bump (exit 1), and a re-run then succeeds', () => {
    const dir = makeV4Layout(
      'm8',
      ['version: "4.3.0"', 'reviewer:', '  ollama:', '    model: q', '    endpoint: http://x', ''].join('\n'),
    );
    try {
      writeBaseline(dir, 'broken', '{ this is not valid json');

      // First run: the corrupt baseline cannot be re-keyed, so the runner withholds
      // the version bump and surfaces the deletion — exit 1, version untouched.
      const first = run(['init', '--upgrade', '--platform', 'generic'], dir);
      expect(first.status).toBe(1);
      expect(first.all).toContain('Migration withheld');
      expect(first.all).toContain('the version bump was NOT applied');
      expect(first.all).toContain('.drift-state/broken.json');
      expect(first.all).toContain('could not be parsed');
      // The bump is withheld — the version is NOT advanced to 5.0.0 on this run.
      expect(readFileSync(configPath(dir), 'utf-8')).not.toContain('5.0.0');
      // The unsalvageable baseline was removed (the node will surface as drift).
      expect(existsSync(path.join(dir, '.yggdrasil', '.drift-state', 'broken.json'))).toBe(false);

      // Recovery: with the corrupt file gone, a second upgrade completes the bump.
      const second = run(['init', '--upgrade', '--platform', 'generic'], dir);
      expect(second.status).toBe(0);
      expect(readFileSync(configPath(dir), 'utf-8')).toContain('version: "5.0.0"');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('M9: re-keying is idempotent — upgrading an already-typed baseline twice leaves it byte-identical', () => {
    const dir = makeV4Layout(
      'm9',
      ['version: "4.3.0"', 'reviewer:', '  ollama:', '    model: q', '    endpoint: http://x', ''].join('\n'),
    );
    const baselineFile = path.join(dir, '.yggdrasil', '.drift-state', 'svc.json');
    try {
      writeBaseline(dir, 'svc', JSON.stringify({
        hash: 'x',
        files: { 'src/a.ts': 'h-a', 'own-subset:svc': 'h-own', 'aspect-meta:alpha': 'h-alpha' },
      }));

      // First upgrade re-keys flat → typed.
      expect(run(['init', '--upgrade', '--platform', 'generic'], dir).status).toBe(0);
      const afterFirst = readFileSync(baselineFile, 'utf-8');
      expect(afterFirst).toContain('"schemaVersion": 1');

      // Second upgrade: the baseline is already typed → skipped untouched.
      expect(run(['init', '--upgrade', '--platform', 'generic'], dir).status).toBe(0);
      expect(readFileSync(baselineFile, 'utf-8')).toBe(afterFirst);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
