import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { mkdtemp, cp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'sample-project');

async function withFixtureCopy<T>(fn: (cwd: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), 'ygg-check-'));
  await cp(FIXTURE, root, { recursive: true });
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('check command', () => {
  describe('exit codes', () => {
    it('exits 1 when the fixture has unverified pairs', async () => {
      // The sample-project fixture ships without a lock file, so all LLM
      // pairs are unverified — check must exit 1.
      await withFixtureCopy(async (cwd) => {
        const result = spawnSync('node', [BIN_PATH, 'check'], {
          cwd,
          encoding: 'utf-8',
        });
        expect(result.status).toBe(1);
      });
    });

    it('exits 1 when the lock file contains garbled JSON', async () => {
      await withFixtureCopy(async (cwd) => {
        await writeFile(
          path.join(cwd, '.yggdrasil', 'yg-lock.json'),
          '{ not valid json',
          'utf-8',
        );
        const result = spawnSync('node', [BIN_PATH, 'check'], {
          cwd,
          encoding: 'utf-8',
        });
        expect(result.status).toBe(1);
      });
    });
  });

  describe('output content — clean fixture (unverified pairs)', () => {
    it('prints the check header with node and aspect counts', async () => {
      await withFixtureCopy(async (cwd) => {
        const result = spawnSync('node', [BIN_PATH, 'check'], {
          cwd,
          encoding: 'utf-8',
        });
        // Header format: "yg check: PASS|FAIL  N nodes · M aspects · …"
        expect(result.stdout).toMatch(/yg check: (PASS|FAIL)/);
        expect(result.stdout).toContain('nodes');
        expect(result.stdout).toContain('aspects');
      });
    });

    it('labels unverified pairs with the "unverified" issue label', async () => {
      await withFixtureCopy(async (cwd) => {
        const result = spawnSync('node', [BIN_PATH, 'check'], {
          cwd,
          encoding: 'utf-8',
        });
        // The fixture has no lock → pairs appear as "unverified"
        expect(result.stdout).toContain('unverified');
      });
    });

    it('suggests yg check --approve as the next step', async () => {
      await withFixtureCopy(async (cwd) => {
        const result = spawnSync('node', [BIN_PATH, 'check'], {
          cwd,
          encoding: 'utf-8',
        });
        expect(result.stdout).toContain('yg check --approve');
      });
    });

    it('labels a mapping-path-missing issue correctly', async () => {
      // The sample-project has users/missing-service pointing to a file that
      // does not exist on disk — check must surface it as mapping-path-missing.
      await withFixtureCopy(async (cwd) => {
        const result = spawnSync('node', [BIN_PATH, 'check'], {
          cwd,
          encoding: 'utf-8',
        });
        expect(result.stdout).toContain('mapping-path-missing');
      });
    });
  });

  describe('output content — garbled lock', () => {
    it('labels the issue as lock-invalid and references yg-lock.json', async () => {
      await withFixtureCopy(async (cwd) => {
        await writeFile(
          path.join(cwd, '.yggdrasil', 'yg-lock.json'),
          '{ not valid json',
          'utf-8',
        );
        const result = spawnSync('node', [BIN_PATH, 'check'], {
          cwd,
          encoding: 'utf-8',
        });
        expect(result.stdout).toContain('lock-invalid');
        expect(result.stdout).toMatch(/yg-lock\.json/);
      });
    });

    it('does not emit "unverified" when the lock is garbled (fail closed)', async () => {
      // When the lock cannot be parsed, all individual pair checks are skipped
      // and only a single lock-invalid error is emitted.
      await withFixtureCopy(async (cwd) => {
        await writeFile(
          path.join(cwd, '.yggdrasil', 'yg-lock.json'),
          '{ not valid json',
          'utf-8',
        );
        const result = spawnSync('node', [BIN_PATH, 'check'], {
          cwd,
          encoding: 'utf-8',
        });
        expect(result.stdout).not.toContain('unverified');
      });
    });
  });

  describe('--approve flag dispatch', () => {
    it('dispatches to the fill path and prints "Filling" in stdout', async () => {
      // --approve should invoke runFill (not just runCheck). The fixture has
      // LLM aspects with an unreachable reviewer, so fill prints a "Filling N
      // unverified pairs…" line before attempting the reviewer calls.
      await withFixtureCopy(async (cwd) => {
        const result = spawnSync('node', [BIN_PATH, 'check', '--approve'], {
          cwd,
          encoding: 'utf-8',
          timeout: 20000,
        });
        expect(result.stdout).toContain('Filling');
      });
    });

    it('still reports the check result after --approve runs', async () => {
      // Even when the reviewer is unreachable, check --approve must print the
      // full check output (header + issues) after the fill attempt finishes.
      await withFixtureCopy(async (cwd) => {
        const result = spawnSync('node', [BIN_PATH, 'check', '--approve'], {
          cwd,
          encoding: 'utf-8',
          timeout: 20000,
        });
        expect(result.stdout).toMatch(/yg check: (PASS|FAIL)/);
      });
    });

    it('exits 1 when the reviewer is unreachable and pairs remain unverified', async () => {
      // The fixture reviewer is configured for a local ollama endpoint that
      // does not exist in CI — fill fails on infrastructure, check exits 1.
      await withFixtureCopy(async (cwd) => {
        const result = spawnSync('node', [BIN_PATH, 'check', '--approve'], {
          cwd,
          encoding: 'utf-8',
          timeout: 20000,
        });
        expect(result.status).toBe(1);
      });
    });
  });
});
