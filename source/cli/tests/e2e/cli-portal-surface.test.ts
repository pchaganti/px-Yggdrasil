import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Public-surface E2E for the `yg portal` command scaffold. Spawns the built
// dist/bin.js and asserts the --help surface (option set + registration). No
// src/** import (e2e-public-surface aspect) — `--help` is graph-independent, so
// these run in the CLI root directory without a fixture project.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');

const distExists = existsSync(BIN_PATH);

function run(args: string[]): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync('node', [BIN_PATH, ...args], {
    cwd: CLI_ROOT,
    encoding: 'utf-8',
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status,
  };
}

describe.skipIf(!distExists)('CLI E2E — yg portal command surface', () => {
  it('registers the portal command (listed under the top-level --help)', () => {
    const { status, stdout } = run(['--help']);
    expect(status).toBe(0);
    expect(stdout).toContain('portal');
  });

  it('yg portal --help lists every documented option', () => {
    const { status, stdout } = run(['portal', '--help']);
    expect(status).toBe(0);
    expect(stdout).toContain('--static');
    expect(stdout).toContain('--port');
    expect(stdout).toContain('--open');
    expect(stdout).toContain('--no-write');
  });

  it('rejects a non-integer --port value (exit 1)', () => {
    const { status, stderr } = run(['portal', '--port', 'abc']);
    expect(status).toBe(1);
    expect(stderr).toContain('--port');
  });
});
