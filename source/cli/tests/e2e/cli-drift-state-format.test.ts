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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
// e2e-lifecycle is a complete v5 graph (config + architecture + model nodes +
// aspects) with NO committed drift-state baselines. We copy it and plant a
// single malformed baseline for the `services/orders` node, then assert the
// spawned binary's read-boundary gate.
const FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'e2e-lifecycle');
const NODE = 'services/orders';

const distExists = existsSync(BIN_PATH);

function run(
  args: string[],
  cwd: string,
): { stdout: string; stderr: string; status: number | null; all: string } {
  const result = spawnSync('node', [BIN_PATH, ...args], { cwd, encoding: 'utf-8' });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  return { stdout, stderr, status: result.status, all: stdout + stderr };
}

/** Copy the complete e2e-lifecycle fixture into a fresh temp dir for mutation. */
function copyFixture(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-dsf-${label}-`));
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

/** Write a raw baseline file (any JSON value) for the `services/orders` node. */
function plantBaseline(dir: string, raw: string): void {
  const stateDir = path.join(dir, '.yggdrasil', '.drift-state', 'services');
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(path.join(stateDir, 'orders.json'), raw, 'utf-8');
}

// A baseline that satisfies every typed-shape requirement. Each negative case
// below removes or corrupts exactly one part of this object.
const VALID_BASELINE = {
  schemaVersion: 1,
  hash: 'deadbeef',
  files: {},
  identity: {},
  aspectVerdicts: {},
};

/** A drift-state error is a recoverable STATE problem, never a CLI bug. */
function expectCleanStateError(all: string): void {
  expect(all).not.toContain('Unexpected error');
  expect(all).not.toContain('This is a bug');
  expect(all).not.toContain('file an issue');
  expect(all).not.toContain('does not classify');
}

// ---------------------------------------------------------------------------
// Typed drift-state format gate (v5 single-format runtime boundary).
// The runtime reads ONLY the current typed baseline format; anything else is
// refused at the read boundary, fail-closed (exit 1, nothing written). Fully
// hermetic: no network, no LLM, fresh mkdtemp per test.
// ---------------------------------------------------------------------------

describe.skipIf(!distExists)('CLI E2E — typed drift-state format gate', () => {
  // --- 1. Outdated baseline: absent schemaVersion (old flat pre-v5 shape) ---

  it('G1: a baseline with NO schemaVersion is refused with the migration hint (exit 1, clean)', () => {
    const dir = copyFixture('g1');
    try {
      // Old flat baseline shape — carries data but predates the typed format.
      plantBaseline(dir, JSON.stringify({ hash: 'x', files: { 'src/services/orders.ts': 'h' } }));

      const check = run(['check'], dir);
      expect(check.status).toBe(1);
      // Names the offending node and the absent version.
      expect(check.all).toContain(`baseline for node '${NODE}'`);
      expect(check.all).toContain('schemaVersion undefined, not 1');
      // Recovery is a migration, not a restore.
      expect(check.all).toContain('yg init --upgrade');
      // Rendered as a recoverable state error, NOT an unclassified CLI bug.
      expectCleanStateError(check.all);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- 2. Outdated baseline: a recognized-but-wrong schemaVersion ---

  it('G2: a baseline with a non-current schemaVersion (99) is refused with the migration hint', () => {
    const dir = copyFixture('g2');
    try {
      plantBaseline(dir, JSON.stringify({ ...VALID_BASELINE, schemaVersion: 99 }));

      const check = run(['check'], dir);
      expect(check.status).toBe(1);
      expect(check.all).toContain('schemaVersion 99, not 1');
      expect(check.all).toContain('yg init --upgrade');
      expectCleanStateError(check.all);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- 3. Corrupt CURRENT-version baseline: distinct recovery (restore/delete) ---

  it('G3: a current-version baseline missing required fields is refused with restore-or-delete advice', () => {
    const dir = copyFixture('g3');
    try {
      // schemaVersion is current, but every required typed field is absent.
      plantBaseline(dir, JSON.stringify({ schemaVersion: 1 }));

      const check = run(['check'], dir);
      expect(check.status).toBe(1);
      expect(check.all).toContain('missing required fields');
      expect(check.all).toContain('restore the baseline from git');
      // A corrupt CURRENT-version baseline is NOT an upgrade scenario.
      expect(check.all).not.toContain('yg init --upgrade');
      expectCleanStateError(check.all);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- 4. Recovery commands interpolate the real node path (regression guard) ---

  it('G4: the corrupt-baseline recovery commands substitute the real node path, not a literal template', () => {
    const dir = copyFixture('g4');
    try {
      plantBaseline(dir, JSON.stringify({ schemaVersion: 1 }));

      const check = run(['check'], dir);
      expect(check.status).toBe(1);
      // Both recovery commands must be copy-pasteable with the node path filled in.
      expect(check.all).toContain(`git checkout HEAD -- .yggdrasil/.drift-state/${NODE}.json`);
      expect(check.all).toContain(`yg approve --node ${NODE}`);
      // No un-interpolated ${nodePath} placeholder may leak into the message.
      expect(check.all).not.toContain('${nodePath}');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- 5. Every required typed field is part of the contract ---

  for (const field of ['hash', 'files', 'identity', 'aspectVerdicts'] as const) {
    it(`G5[${field}]: a current-version baseline omitting '${field}' is refused as corrupt`, () => {
      const dir = copyFixture(`g5-${field}`);
      try {
        const baseline: Record<string, unknown> = { ...VALID_BASELINE };
        delete baseline[field];
        plantBaseline(dir, JSON.stringify(baseline));

        const check = run(['check'], dir);
        expect(check.status).toBe(1);
        expect(check.all).toContain('missing required fields');
        expectCleanStateError(check.all);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  // --- 6. Wrong-typed field (object expected, array given) is also corrupt ---

  it('G6: a baseline whose aspectVerdicts is an array (not a record) is refused as corrupt', () => {
    const dir = copyFixture('g6');
    try {
      plantBaseline(dir, JSON.stringify({ ...VALID_BASELINE, aspectVerdicts: [] }));

      const check = run(['check'], dir);
      expect(check.status).toBe(1);
      expect(check.all).toContain('missing required fields');
      expectCleanStateError(check.all);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- 7. A baseline that is a JSON primitive (not an object) is outdated ---

  it('G7: a baseline that is a JSON primitive (not an object) is refused via the outdated gate', () => {
    const dir = copyFixture('g7');
    try {
      plantBaseline(dir, '42');

      const check = run(['check'], dir);
      expect(check.status).toBe(1);
      expect(check.all).toContain('schemaVersion undefined, not 1');
      expect(check.all).toContain('yg init --upgrade');
      expectCleanStateError(check.all);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- 8. The gate is centralized: it fires identically from `yg approve` ---

  it('G8: the same corrupt baseline is refused cleanly by `yg approve`, not just `yg check`', () => {
    const dir = copyFixture('g8');
    try {
      plantBaseline(dir, JSON.stringify({ schemaVersion: 1 }));

      const approve = run(['approve', '--node', NODE], dir);
      expect(approve.status).toBe(1);
      expect(approve.all).toContain('missing required fields');
      // The centralized handler renders it cleanly here too — no bug framing,
      // and nothing was written over the (intentionally malformed) baseline.
      expectCleanStateError(approve.all);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
