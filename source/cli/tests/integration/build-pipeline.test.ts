import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { mkdtemp, cp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const FULL_FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'sample-project');
const BROKEN_FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'sample-project-broken-relation');

async function withFixtureCopy<T>(fixture: string, fn: (cwd: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), 'ygg-build-pipeline-'));
  await cp(fixture, root, { recursive: true });
  return fn(root);
}

describe('context pipeline integration', () => {
  it('context --node writes context to stdout for valid node', async () => {
    await withFixtureCopy(FULL_FIXTURE, async (cwd) => {
      const result = spawnSync(
        'node',
        [BIN_PATH, 'context', '--node', 'orders/order-service'],
        {
          cwd,
          encoding: 'utf-8',
        },
      );

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('Source files');
      expect(result.stdout).toContain('orders/order-service');
      expect(result.stdout).toContain('After modifying source files');
    });
  });

  it('context --node is deterministic', async () => {
    await withFixtureCopy(FULL_FIXTURE, async (cwd) => {
      const first = spawnSync(
        'node',
        [BIN_PATH, 'context', '--node', 'orders/order-service'],
        {
          cwd,
          encoding: 'utf-8',
        },
      );
      expect(first.status).toBe(0);

      const second = spawnSync(
        'node',
        [BIN_PATH, 'context', '--node', 'orders/order-service'],
        {
          cwd,
          encoding: 'utf-8',
        },
      );
      expect(second.status).toBe(0);

      const stripVariableParts = (content: string) =>
        content
          .trim();

      expect(stripVariableParts(second.stdout)).toBe(stripVariableParts(first.stdout));
    });
  });

  it('context --node expands directory mapping to individual files', async () => {
    await withFixtureCopy(FULL_FIXTURE, async (cwd) => {
      // Create a directory with multiple files and a node that maps the directory
      const dirPath = path.join(cwd, 'src', 'payments');
      await mkdir(dirPath, { recursive: true });
      await writeFile(path.join(dirPath, 'payment.service.cs'), 'class PaymentService {}', 'utf-8');
      await writeFile(path.join(dirPath, 'payment.model.cs'), 'class PaymentModel {}', 'utf-8');
      await writeFile(path.join(dirPath, 'payment.validator.cs'), 'class PaymentValidator {}', 'utf-8');

      // Create a node with directory mapping
      const nodePath = path.join(cwd, '.yggdrasil', 'model', 'payments');
      await mkdir(nodePath, { recursive: true });
      await writeFile(path.join(nodePath, 'yg-node.yaml'), [
        'name: Payments',
        'description: Payment processing',
        'type: service',
        'mapping:',
        '  - src/payments/',
      ].join('\n'), 'utf-8');

      const result = spawnSync(
        'node',
        [BIN_PATH, 'context', '--node', 'payments'],
        { cwd, encoding: 'utf-8' },
      );

      expect(result.status).toBe(0);
      // Should show 3 individual files, not just "src/payments"
      expect(result.stdout).toContain('Source files (3):');
      expect(result.stdout).toContain('src/payments/payment.service.cs');
      expect(result.stdout).toContain('src/payments/payment.model.cs');
      expect(result.stdout).toContain('src/payments/payment.validator.cs');
    });
  });

  it('context fails on broken relation with structural error message', async () => {
    await withFixtureCopy(BROKEN_FIXTURE, async (cwd) => {
      const result = spawnSync(
        'node',
        [BIN_PATH, 'context', '--node', 'orders/broken-service'],
        {
          cwd,
          encoding: 'utf-8',
        },
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('build-context blocked by');
    });
  });
});
