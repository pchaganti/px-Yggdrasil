import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { mkdtemp, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'sample-project');

async function withFixtureCopy<T>(fn: (cwd: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), 'ygg-impact-'));
  await cp(FIXTURE, root, { recursive: true });
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('impact command', () => {
  describe('--node', () => {
    it('shows directly dependent nodes', async () => {
      await withFixtureCopy(async (cwd) => {
        const result = spawnSync(
          'node',
          [BIN_PATH, 'impact', '--node', 'orders/order-service'],
          { cwd, encoding: 'utf-8' },
        );
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('checkout/controller');
        expect(result.stdout).toContain('Directly dependent');
      });
    });

    it('shows flow membership', async () => {
      await withFixtureCopy(async (cwd) => {
        const result = spawnSync(
          'node',
          [BIN_PATH, 'impact', '--node', 'orders/order-service'],
          { cwd, encoding: 'utf-8' },
        );
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('Checkout Flow');
      });
    });

    it('shows event-connected nodes', async () => {
      await withFixtureCopy(async (cwd) => {
        const result = spawnSync(
          'node',
          [BIN_PATH, 'impact', '--node', 'orders/order-service'],
          { cwd, encoding: 'utf-8' },
        );
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('Event-connected');
        expect(result.stdout).toContain('users/user-repo');
      });
    });

    it('shows total scope summary', async () => {
      await withFixtureCopy(async (cwd) => {
        const result = spawnSync(
          'node',
          [BIN_PATH, 'impact', '--node', 'orders/order-service'],
          { cwd, encoding: 'utf-8' },
        );
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('Blast radius');
      });
    });

    it('shows aspects in scope', async () => {
      await withFixtureCopy(async (cwd) => {
        const result = spawnSync(
          'node',
          [BIN_PATH, 'impact', '--node', 'orders/order-service'],
          { cwd, encoding: 'utf-8' },
        );
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('Aspects');
      });
    });

    it('annotates effective status per aspect on Aspects line', async () => {
      await withFixtureCopy(async (cwd) => {
        const result = spawnSync(
          'node',
          [BIN_PATH, 'impact', '--node', 'orders/order-service'],
          { cwd, encoding: 'utf-8' },
        );
        expect(result.status).toBe(0);
        // Aspects: <name> [enforced], ...
        expect(result.stdout).toMatch(/Aspects:.*\[enforced\]/);
      });
    });

    it('returns exit 1 for non-existent node', async () => {
      await withFixtureCopy(async (cwd) => {
        const result = spawnSync(
          'node',
          [BIN_PATH, 'impact', '--node', 'does/not/exist'],
          { cwd, encoding: 'utf-8' },
        );
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('Node not found');
      });
    });

    it('handles node with no dependents gracefully', async () => {
      await withFixtureCopy(async (cwd) => {
        // checkout/controller uses orders/order-service but nothing uses checkout/controller
        const result = spawnSync(
          'node',
          [BIN_PATH, 'impact', '--node', 'checkout/controller'],
          { cwd, encoding: 'utf-8' },
        );
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('Directly dependent');
        expect(result.stdout).toContain('(none)');
      });
    });
  });

  describe('--aspect', () => {
    it('shows directly affected nodes', async () => {
      await withFixtureCopy(async (cwd) => {
        const result = spawnSync(
          'node',
          [BIN_PATH, 'impact', '--aspect', 'requires-audit'],
          { cwd, encoding: 'utf-8' },
        );
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('Directly affected');
        expect(result.stdout).toContain('orders');
        expect(result.stdout).toContain('orders/order-service');
      });
    });

    it('shows implies relationship', async () => {
      await withFixtureCopy(async (cwd) => {
        const result = spawnSync(
          'node',
          [BIN_PATH, 'impact', '--aspect', 'requires-audit'],
          { cwd, encoding: 'utf-8' },
        );
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('Implies');
        expect(result.stdout).toContain('requires-logging');
      });
    });

    it('shows total scope', async () => {
      await withFixtureCopy(async (cwd) => {
        const result = spawnSync(
          'node',
          [BIN_PATH, 'impact', '--aspect', 'requires-audit'],
          { cwd, encoding: 'utf-8' },
        );
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('Blast radius');
      });
    });

    it('returns exit 1 for non-existent aspect', async () => {
      await withFixtureCopy(async (cwd) => {
        const result = spawnSync(
          'node',
          [BIN_PATH, 'impact', '--aspect', 'does-not-exist'],
          { cwd, encoding: 'utf-8' },
        );
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('Aspect not found');
      });
    });

    it('shows [status] tag per affected (node, aspect) pair', async () => {
      await withFixtureCopy(async (cwd) => {
        const result = spawnSync(
          'node',
          [BIN_PATH, 'impact', '--aspect', 'requires-audit'],
          { cwd, encoding: 'utf-8' },
        );
        expect(result.status).toBe(0);
        // Each affected node line includes [<status>]; default is [enforced]
        expect(result.stdout).toMatch(/orders\/order-service \([^)]+\) \[enforced\]/);
      });
    });

    it('annotates affected nodes with refused baselines (rendering-flip risk)', async () => {
      // yg impact --aspect calls out nodes whose stored baseline contains a
      // `refused` verdict for the aspect — their rendering severity will flip
      // if the user changes the aspect's status.
      await withFixtureCopy(async (cwd) => {
        const { writeFile, mkdir } = await import('node:fs/promises');
        const driftDir = path.join(cwd, '.yggdrasil', '.drift-state', 'orders');
        await mkdir(driftDir, { recursive: true });
        await writeFile(
          path.join(driftDir, 'order-service.json'),
          JSON.stringify({
            hash: 'fake-hash',
            files: {},
            aspectVerdicts: {
              'requires-audit': { verdict: 'refused', reason: 'mock', errorSource: 'codeViolation' },
            },
          }),
          'utf-8',
        );
        const result = spawnSync(
          'node',
          [BIN_PATH, 'impact', '--aspect', 'requires-audit'],
          { cwd, encoding: 'utf-8' },
        );
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('refused baseline');
        expect(result.stdout).toContain('rendering severity will flip');
      });
    });

    it('does NOT annotate nodes whose baseline is approved', async () => {
      await withFixtureCopy(async (cwd) => {
        const { writeFile, mkdir } = await import('node:fs/promises');
        const driftDir = path.join(cwd, '.yggdrasil', '.drift-state', 'orders');
        await mkdir(driftDir, { recursive: true });
        await writeFile(
          path.join(driftDir, 'order-service.json'),
          JSON.stringify({
            hash: 'fake-hash',
            files: {},
            aspectVerdicts: { 'requires-audit': { verdict: 'approved' } },
          }),
          'utf-8',
        );
        const result = spawnSync(
          'node',
          [BIN_PATH, 'impact', '--aspect', 'requires-audit'],
          { cwd, encoding: 'utf-8' },
        );
        expect(result.status).toBe(0);
        expect(result.stdout).not.toContain('refused baseline');
      });
    });

    it('shows implied-by relationship for requires-logging', async () => {
      await withFixtureCopy(async (cwd) => {
        const result = spawnSync(
          'node',
          [BIN_PATH, 'impact', '--aspect', 'requires-logging'],
          { cwd, encoding: 'utf-8' },
        );
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('Implied by');
        expect(result.stdout).toContain('requires-audit');
      });
    });
  });

  describe('--flow', () => {
    it('shows participants', async () => {
      await withFixtureCopy(async (cwd) => {
        const result = spawnSync(
          'node',
          [BIN_PATH, 'impact', '--flow', 'Checkout Flow'],
          { cwd, encoding: 'utf-8' },
        );
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('Participants');
        expect(result.stdout).toContain('orders/order-service');
        expect(result.stdout).toContain('auth/auth-api');
      });
    });

    it('shows flow aspects', async () => {
      await withFixtureCopy(async (cwd) => {
        const result = spawnSync(
          'node',
          [BIN_PATH, 'impact', '--flow', 'Checkout Flow'],
          { cwd, encoding: 'utf-8' },
        );
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('Flow aspects');
        expect(result.stdout).toContain('requires-logging');
      });
    });

    it('shows total scope', async () => {
      await withFixtureCopy(async (cwd) => {
        const result = spawnSync(
          'node',
          [BIN_PATH, 'impact', '--flow', 'Checkout Flow'],
          { cwd, encoding: 'utf-8' },
        );
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('Blast radius');
      });
    });

    it('returns exit 1 for non-existent flow', async () => {
      await withFixtureCopy(async (cwd) => {
        const result = spawnSync(
          'node',
          [BIN_PATH, 'impact', '--flow', 'does-not-exist'],
          { cwd, encoding: 'utf-8' },
        );
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('Flow not found');
      });
    });
  });

  describe('--file', () => {
    it('resolves file to owner node and shows impact', async () => {
      await withFixtureCopy(async (cwd) => {
        const result = spawnSync(
          'node',
          [BIN_PATH, 'impact', '--file', 'src/orders/order.service.ts'],
          { cwd, encoding: 'utf-8' },
        );
        expect(result.status).toBe(0);
        // stdout shows file->node resolution (informational, not error)
        // plus the impact output itself
        expect(result.stdout).toContain('src/orders/order.service.ts -> orders/order-service');
        expect(result.stdout).toContain('Impact of changes in orders/order-service');
        expect(result.stdout).toContain('checkout/controller');
      });
    });

    it('returns exit 1 for unmapped file', async () => {
      await withFixtureCopy(async (cwd) => {
        const result = spawnSync(
          'node',
          [BIN_PATH, 'impact', '--file', 'src/unmapped/file.ts'],
          { cwd, encoding: 'utf-8' },
        );
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('no graph coverage');
      });
    });
  });

  describe('error cases', () => {
    it('requires at least one option', async () => {
      await withFixtureCopy(async (cwd) => {
        const result = spawnSync('node', [BIN_PATH, 'impact'], {
          cwd,
          encoding: 'utf-8',
        });
        expect(result.status).toBe(1);
        expect(result.stderr).toMatch(/--node|--aspect|--flow/);
      });
    });

    it('rejects --node and --file together', async () => {
      await withFixtureCopy(async (cwd) => {
        const result = spawnSync(
          'node',
          [BIN_PATH, 'impact', '--node', 'orders/order-service', '--file', 'src/orders/order.service.ts'],
          { cwd, encoding: 'utf-8' },
        );
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('mutually exclusive');
      });
    });

    it('rejects --node and --aspect together', async () => {
      await withFixtureCopy(async (cwd) => {
        const result = spawnSync(
          'node',
          [BIN_PATH, 'impact', '--node', 'orders/order-service', '--aspect', 'requires-audit'],
          { cwd, encoding: 'utf-8' },
        );
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('Multiple targets specified');
      });
    });
  });

  describe('--type', () => {
    it('shows type info and nodes of that type', async () => {
      await withFixtureCopy(async (cwd) => {
        const result = spawnSync(
          'node',
          [BIN_PATH, 'impact', '--type', 'service'],
          { cwd, encoding: 'utf-8' },
        );
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('Type: service');
        expect(result.stdout).toContain('Nodes of this type (4):');
      });
    });

    it('shows source files covered', async () => {
      await withFixtureCopy(async (cwd) => {
        const result = spawnSync(
          'node',
          [BIN_PATH, 'impact', '--type', 'service'],
          { cwd, encoding: 'utf-8' },
        );
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('Source files covered');
      });
    });

    it('returns exit 1 for non-existent type', async () => {
      await withFixtureCopy(async (cwd) => {
        const result = spawnSync(
          'node',
          [BIN_PATH, 'impact', '--type', 'does-not-exist'],
          { cwd, encoding: 'utf-8' },
        );
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("Type 'does-not-exist' not found");
      });
    });

    it('rejects --type combined with --node', async () => {
      await withFixtureCopy(async (cwd) => {
        const result = spawnSync(
          'node',
          [BIN_PATH, 'impact', '--type', 'service', '--node', 'orders/order-service'],
          { cwd, encoding: 'utf-8' },
        );
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('Multiple targets specified');
      });
    });
  });
});
