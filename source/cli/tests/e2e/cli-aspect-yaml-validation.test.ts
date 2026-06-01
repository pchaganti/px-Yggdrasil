import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, cpSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'e2e-lifecycle');
const distExists = existsSync(BIN_PATH);

function run(args: string[], cwd: string): { status: number | null; all: string } {
  const result = spawnSync('node', [BIN_PATH, ...args], { cwd, encoding: 'utf-8' });
  return { status: result.status, all: (result.stdout ?? '') + (result.stderr ?? '') };
}

/**
 * Copy the e2e-lifecycle graph and plant a standalone `aspects/<id>/` directory.
 * A standalone aspect is parsed at graph load, so any yg-aspect.yaml defect
 * surfaces through `yg check` without needing to attach it to a node.
 */
function withAspect(label: string, id: string, yaml: string, checkMjs?: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-ayv-${label}-`));
  cpSync(FIXTURE, dir, { recursive: true });
  const aspectDir = path.join(dir, '.yggdrasil', 'aspects', id);
  mkdirSync(aspectDir, { recursive: true });
  writeFileSync(path.join(aspectDir, 'yg-aspect.yaml'), yaml, 'utf-8');
  if (checkMjs) writeFileSync(path.join(aspectDir, 'check.mjs'), checkMjs, 'utf-8');
  return dir;
}

const PASS_CHECK = 'export function check() { return []; }\n';

// ---------------------------------------------------------------------------
// yg-aspect.yaml field + reviewer-block validation (io/aspect-parser.ts).
// The parser validates fields in order: name → reviewer → status → implies, so
// each fixture keeps the earlier fields valid and corrupts exactly one. Every
// defect is a structural error that blocks `yg check` (exit 1). Fully hermetic.
// ---------------------------------------------------------------------------

describe.skipIf(!distExists)('CLI E2E — yg-aspect.yaml field validation', () => {
  it('A1: a yg-aspect.yaml with no `name` is rejected (aspect-name-missing)', () => {
    const dir = withAspect('a1', 'no-name', 'reviewer:\n  type: deterministic\n', PASS_CHECK);
    try {
      const check = run(['check'], dir);
      expect(check.status).toBe(1);
      expect(check.all).toContain('aspect-name-missing');
      expect(check.all).toContain("missing or empty 'name'");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('A2: an out-of-vocabulary `status` is rejected (aspect-status-invalid)', () => {
    const dir = withAspect('a2', 'bad-status', 'name: P\nreviewer:\n  type: deterministic\nstatus: bogus\n', PASS_CHECK);
    try {
      const check = run(['check'], dir);
      expect(check.status).toBe(1);
      expect(check.all).toContain('aspect-status-invalid');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('A3: a non-array `implies` is rejected (aspect-implies-not-array)', () => {
    const dir = withAspect('a3', 'bad-implies', 'name: P\nreviewer:\n  type: deterministic\nimplies: foo\n', PASS_CHECK);
    try {
      const check = run(['check'], dir);
      expect(check.status).toBe(1);
      expect(check.all).toContain('aspect-implies-not-array');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('A4: an implies entry with an invalid status_inherit is rejected (implies-status-inherit-invalid)', () => {
    const dir = withAspect(
      'a4',
      'bad-inherit',
      'name: P\nreviewer:\n  type: deterministic\nimplies:\n  - id: no-todo-comments\n    status_inherit: bogus\n',
      PASS_CHECK,
    );
    try {
      const check = run(['check'], dir);
      expect(check.status).toBe(1);
      expect(check.all).toContain('implies-status-inherit-invalid');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('A5: a scalar `reviewer:` (not a mapping) is rejected (aspect-reviewer-not-mapping)', () => {
    const dir = withAspect('a5', 'reviewer-scalar', 'name: P\nreviewer: ast\n');
    try {
      const check = run(['check'], dir);
      expect(check.status).toBe(1);
      expect(check.all).toContain('aspect-reviewer-not-mapping');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('A6: a reviewer mapping without `type:` is rejected (aspect-reviewer-type-missing)', () => {
    const dir = withAspect('a6', 'reviewer-no-type', 'name: P\nreviewer:\n  tier: standard\n');
    try {
      const check = run(['check'], dir);
      expect(check.status).toBe(1);
      expect(check.all).toContain('aspect-reviewer-type-missing');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('A7: an unknown key under `reviewer:` is rejected (aspect-reviewer-unknown-key)', () => {
    const dir = withAspect('a7', 'reviewer-unknown-key', 'name: P\nreviewer:\n  type: llm\n  provider: openai\n');
    try {
      const check = run(['check'], dir);
      expect(check.status).toBe(1);
      expect(check.all).toContain('aspect-reviewer-unknown-key');
      // The hint steers the author to the config tier, not the aspect.
      expect(check.all).toContain('provider/model lives in the config tier');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('A8: an empty/non-string `reviewer.tier` is rejected (aspect-reviewer-tier-invalid)', () => {
    const dir = withAspect('a8', 'reviewer-empty-tier', 'name: P\nreviewer:\n  type: llm\n  tier: ""\n');
    try {
      const check = run(['check'], dir);
      expect(check.status).toBe(1);
      expect(check.all).toContain('aspect-reviewer-tier-invalid');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
