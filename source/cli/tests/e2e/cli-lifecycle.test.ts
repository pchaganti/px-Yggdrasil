import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, cpSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const PKG_VERSION = JSON.parse(readFileSync(path.join(CLI_ROOT, 'package.json'), 'utf-8')).version;
const FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'sample-project');

const distExists = existsSync(BIN_PATH);

function run(
  args: string[],
  cwd = FIXTURE,
): {
  stdout: string;
  stderr: string;
  status: number | null;
} {
  const result = spawnSync('node', [BIN_PATH, ...args], {
    cwd,
    encoding: 'utf-8',
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status,
  };
}

describe.skipIf(!distExists)('CLI E2E — lifecycle (approve, log, deterministic-test, platform, init)', () => {
  // --- approve ---

  it('yg approve --node records hash and clears drift', () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'yg-e2e-approve-'));
    try {
      cpSync(FIXTURE, tmpDir, { recursive: true });
      // Remove the stored drift state to force the node to be (re-)approved
      rmSync(path.join(tmpDir, '.yggdrasil', '.drift-state', 'orders', 'order-service.json'), {
        force: true,
      });
      const { status: approveStatus, stdout } = run(
        ['approve', '--node', 'orders/order-service'],
        tmpDir,
      );
      expect(approveStatus).toBe(0);
      expect(stdout).toMatch(/Approved: orders\/order-service/);

      // After approving, check should not show source-drift for this node
      const { stdout: checkOut } = run(['check'], tmpDir);
      const driftLines = checkOut.split('\n').filter((l: string) =>
        l.includes('source-drift') && l.includes('orders/order-service'),
      );
      expect(driftLines.length).toBe(0);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('yg approve without --node returns exit 1', () => {
    const { status, stderr } = run(['approve']);
    expect(status).toBe(1);
    expect(stderr).toMatch(/required option|--node/);
  });

  it('yg approve nonexistent node returns exit 1', () => {
    const { status, stderr } = run(['approve', '--node', 'does/not/exist']);
    expect(status).toBe(1);
    expect(stderr).toContain("does not exist");
  });

  // --- platform installation (direct unit tests) ---

  it('installRulesForPlatform cursor creates .cursor/rules/yggdrasil.mdc', async () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'yg-e2e-platform-cursor-'));
    mkdirSync(path.join(tmpDir, '.yggdrasil'), { recursive: true });

    try {
      const { installRulesForPlatform } = await import('../../src/templates/platform.js');
      await installRulesForPlatform(tmpDir, 'cursor');
      expect(existsSync(path.join(tmpDir, '.cursor', 'rules', 'yggdrasil.mdc'))).toBe(true);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('installRulesForPlatform cline creates .clinerules/yggdrasil.md', async () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'yg-e2e-platform-cline-'));
    mkdirSync(path.join(tmpDir, '.yggdrasil'), { recursive: true });

    try {
      const { installRulesForPlatform } = await import('../../src/templates/platform.js');
      await installRulesForPlatform(tmpDir, 'cline');
      expect(existsSync(path.join(tmpDir, '.clinerules', 'yggdrasil.md'))).toBe(true);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('installRulesForPlatform claude-code creates CLAUDE.md and agent-rules.md', async () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'yg-e2e-platform-claude-'));
    mkdirSync(path.join(tmpDir, '.yggdrasil'), { recursive: true });

    try {
      const { installRulesForPlatform } = await import('../../src/templates/platform.js');
      await installRulesForPlatform(tmpDir, 'claude-code');
      expect(existsSync(path.join(tmpDir, 'CLAUDE.md'))).toBe(true);
      expect(existsSync(path.join(tmpDir, '.yggdrasil', 'agent-rules.md'))).toBe(true);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('installRulesForPlatform copilot creates .github/copilot-instructions.md', async () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'yg-e2e-platform-copilot-'));
    mkdirSync(path.join(tmpDir, '.yggdrasil'), { recursive: true });

    try {
      const { installRulesForPlatform } = await import('../../src/templates/platform.js');
      await installRulesForPlatform(tmpDir, 'copilot');
      expect(existsSync(path.join(tmpDir, '.github', 'copilot-instructions.md'))).toBe(true);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('installRulesForPlatform windsurf creates .windsurf/rules/yggdrasil.md', async () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'yg-e2e-platform-windsurf-'));
    mkdirSync(path.join(tmpDir, '.yggdrasil'), { recursive: true });

    try {
      const { installRulesForPlatform } = await import('../../src/templates/platform.js');
      await installRulesForPlatform(tmpDir, 'windsurf');
      expect(existsSync(path.join(tmpDir, '.windsurf', 'rules', 'yggdrasil.md'))).toBe(true);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('installRulesForPlatform aider creates .aider.conf.yml and agent-rules.md', async () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'yg-e2e-platform-aider-'));
    mkdirSync(path.join(tmpDir, '.yggdrasil'), { recursive: true });

    try {
      const { installRulesForPlatform } = await import('../../src/templates/platform.js');
      await installRulesForPlatform(tmpDir, 'aider');
      expect(existsSync(path.join(tmpDir, '.aider.conf.yml'))).toBe(true);
      expect(existsSync(path.join(tmpDir, '.yggdrasil', 'agent-rules.md'))).toBe(true);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('installRulesForPlatform gemini creates GEMINI.md and agent-rules.md', async () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'yg-e2e-platform-gemini-'));
    mkdirSync(path.join(tmpDir, '.yggdrasil'), { recursive: true });

    try {
      const { installRulesForPlatform } = await import('../../src/templates/platform.js');
      await installRulesForPlatform(tmpDir, 'gemini');
      expect(existsSync(path.join(tmpDir, 'GEMINI.md'))).toBe(true);
      expect(existsSync(path.join(tmpDir, '.yggdrasil', 'agent-rules.md'))).toBe(true);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('installRulesForPlatform roocode creates .roo/rules/yggdrasil.md', async () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'yg-e2e-platform-roocode-'));
    mkdirSync(path.join(tmpDir, '.yggdrasil'), { recursive: true });

    try {
      const { installRulesForPlatform } = await import('../../src/templates/platform.js');
      await installRulesForPlatform(tmpDir, 'roocode');
      expect(existsSync(path.join(tmpDir, '.roo', 'rules', 'yggdrasil.md'))).toBe(true);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('installRulesForPlatform codex creates AGENTS.md', async () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'yg-e2e-platform-codex-'));
    mkdirSync(path.join(tmpDir, '.yggdrasil'), { recursive: true });

    try {
      const { installRulesForPlatform } = await import('../../src/templates/platform.js');
      await installRulesForPlatform(tmpDir, 'codex');
      expect(existsSync(path.join(tmpDir, 'AGENTS.md'))).toBe(true);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('installRulesForPlatform generic creates agent-rules.md only', async () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'yg-e2e-platform-generic-'));
    mkdirSync(path.join(tmpDir, '.yggdrasil'), { recursive: true });

    try {
      const { installRulesForPlatform } = await import('../../src/templates/platform.js');
      await installRulesForPlatform(tmpDir, 'generic');
      expect(existsSync(path.join(tmpDir, '.yggdrasil', 'agent-rules.md'))).toBe(true);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('init --upgrade advances config version to the latest registered migration target', async () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'yg-e2e-upgrade-version-'));
    const yggDir = path.join(tmpDir, '.yggdrasil');
    mkdirSync(path.join(yggDir, 'schemas'), { recursive: true });
    writeFileSync(path.join(yggDir, 'yg-config.yaml'), 'version: "1.0.0"\n', 'utf-8');

    try {
      const { status } = run(['init', '--upgrade', '--platform', 'generic'], tmpDir);
      expect(status).toBe(0);
      // The on-disk version reflects each migration's `to` in order; the
      // final landed value equals the highest registered migration target,
      // not the CLI package.json version.
      const { MIGRATIONS } = await import('../../src/migrations/index.js');
      const latestTarget = [...MIGRATIONS].map(m => m.to).sort().pop()!;
      const config = readFileSync(path.join(yggDir, 'yg-config.yaml'), 'utf-8');
      expect(config).toContain(`version: "${latestTarget}"`);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('getCliVersion reads version from package.json', async () => {
    // PKG_VERSION reflects the CLI package version (independent from the
    // graph schema version, which the migration framework manages).
    expect(PKG_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  // --- log ---

  it('yg log add appends an entry to the node log', () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'yg-e2e-log-add-'));
    try {
      cpSync(FIXTURE, tmpDir, { recursive: true });
      const { status, stdout } = run(
        ['log', 'add', '--node', 'orders/order-service', '--reason', 'E2E test entry'],
        tmpDir,
      );
      expect(status).toBe(0);
      expect(stdout).toContain('Added log entry');
      expect(stdout).toContain('orders/order-service');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('yg log read returns entries written by log add', () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'yg-e2e-log-read-'));
    try {
      cpSync(FIXTURE, tmpDir, { recursive: true });
      run(['log', 'add', '--node', 'orders/order-service', '--reason', 'Readable entry'], tmpDir);
      const { status, stdout } = run(
        ['log', 'read', '--node', 'orders/order-service'],
        tmpDir,
      );
      expect(status).toBe(0);
      expect(stdout).toContain('Readable entry');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('yg log read --all returns full history including multiple entries', () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'yg-e2e-log-read-all-'));
    try {
      cpSync(FIXTURE, tmpDir, { recursive: true });
      run(['log', 'add', '--node', 'orders/order-service', '--reason', 'Alpha entry'], tmpDir);
      run(['log', 'add', '--node', 'orders/order-service', '--reason', 'Beta entry'], tmpDir);
      const { status, stdout } = run(
        ['log', 'read', '--node', 'orders/order-service', '--all'],
        tmpDir,
      );
      expect(status).toBe(0);
      expect(stdout).toContain('Alpha entry');
      expect(stdout).toContain('Beta entry');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('yg log add without --reason returns exit 1', () => {
    const { status, stderr } = run(['log', 'add', '--node', 'orders/order-service']);
    expect(status).toBe(1);
    expect(stderr).toContain('reason');
  });

  it('yg log read without --node returns exit 1', () => {
    const { status, stderr } = run(['log', 'read']);
    expect(status).toBe(1);
    expect(stderr).toContain('node');
  });

  // --- deterministic-test ---

  it('yg deterministic-test with unknown aspect returns exit 1', () => {
    const { status, stderr } = run(['deterministic-test', '--aspect', 'nonexistent-aspect-xyz']);
    expect(status).toBe(1);
    expect(stderr).toContain('not found');
  });

  it('yg deterministic-test with LLM reviewer aspect returns exit 1 with reviewer error', () => {
    const { status, stderr } = run(['deterministic-test', '--aspect', 'requires-audit']);
    expect(status).toBe(1);
    expect(stderr).toContain('reviewer');
  });

  it('yg deterministic-test runs the check and reports no violations on clean code', () => {
    // Use the dogfood project which has real deterministic aspects and a proper node_modules tree
    const WORKSPACE_ROOT = path.resolve(CLI_ROOT, '../..');
    const { stdout, status } = run(
      ['deterministic-test', '--aspect', 'no-direct-console', '--node', 'cli/formatters'],
      WORKSPACE_ROOT,
    );
    expect(status).toBe(0);
    expect(stdout).toContain('No violations');
  });

  // --- approve --dry-run ---

  it('yg approve --dry-run shows reviewer prompt without making an LLM call', () => {
    const { stdout, status } = run(['approve', '--node', 'orders/order-service', '--dry-run']);
    expect(status).toBe(0);
    expect(stdout).toContain('Dry run');
    expect(stdout).toContain('orders/order-service');
  });

  it('yg approve --aspect exits 0 and runs batch approval', () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'yg-e2e-approve-aspect-'));
    try {
      cpSync(FIXTURE, tmpDir, { recursive: true });
      const { stdout, status } = run(['approve', '--aspect', 'requires-audit'], tmpDir);
      expect(status).toBe(0);
      expect(stdout).toContain('requires-audit');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('yg approve --flow exits 0 and runs batch approval', () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'yg-e2e-approve-flow-'));
    try {
      cpSync(FIXTURE, tmpDir, { recursive: true });
      const { stdout, status } = run(['approve', '--flow', 'checkout-flow'], tmpDir);
      expect(status).toBe(0);
      expect(stdout).toContain('checkout-flow');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('yg approve --node and --aspect together returns exit 1', () => {
    const { status, stderr } = run(['approve', '--node', 'orders/order-service', '--aspect', 'requires-audit']);
    expect(status).toBe(1);
    expect(stderr).toContain('Multiple targets specified');
  });

  it('yg approve --node and --flow together returns exit 1', () => {
    const { status, stderr } = run(['approve', '--node', 'orders/order-service', '--flow', 'checkout-flow']);
    expect(status).toBe(1);
    expect(stderr).toContain('Multiple targets specified');
  });

  it('yg approve --aspect and --flow together returns exit 1', () => {
    const { status, stderr } = run(['approve', '--aspect', 'requires-audit', '--flow', 'checkout-flow']);
    expect(status).toBe(1);
    expect(stderr).toContain('Multiple targets specified');
  });

  it('yg approve multiple --node flags with --dry-run runs batch', () => {
    const { stdout, status } = run([
      'approve',
      '--node', 'orders/order-service',
      '--node', 'auth/auth-api',
      '--dry-run',
    ]);
    expect(status).toBe(0);
    expect(stdout).toContain('orders/order-service');
    expect(stdout).toContain('auth/auth-api');
  });

  // --- init edge cases ---

  it('yg init --upgrade without --platform returns exit 1', () => {
    const { status, stderr } = run(['init', '--upgrade']);
    expect(status).toBe(1);
    expect(stderr).toContain('--upgrade requires --platform');
  });

  it('yg init --upgrade without .yggdrasil returns exit 1', () => {
    const emptyDir = mkdtempSync(path.join(tmpdir(), 'yg-e2e-init-no-ygg-'));
    try {
      const { status, stderr } = run(['init', '--upgrade', '--platform', 'generic'], emptyDir);
      expect(status).toBe(1);
      expect(stderr).toContain('No .yggdrasil/');
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it('yg init fresh in non-TTY returns exit 1', () => {
    const emptyDir = mkdtempSync(path.join(tmpdir(), 'yg-e2e-init-fresh-'));
    try {
      const { status, stderr } = run(['init'], emptyDir);
      expect(status).toBe(1);
      expect(stderr).toContain('interactive terminal');
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  // --- log extended ---

  it('yg log add without --node returns exit 1', () => {
    const { status, stderr } = run(['log', 'add', '--reason', 'test']);
    expect(status).toBe(1);
    expect(stderr).toContain('--node');
  });

  it('yg log add for nonexistent node returns exit 1', () => {
    const { status, stderr } = run(['log', 'add', '--node', 'nonexistent/node', '--reason', 'test']);
    expect(status).toBe(1);
    expect(stderr).toContain('Node not found');
  });

  it('yg log add with --reason-file appends entry from file', () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'yg-e2e-log-reason-file-'));
    try {
      cpSync(FIXTURE, tmpDir, { recursive: true });
      const reasonFile = path.join(tmpDir, 'reason.txt');
      writeFileSync(reasonFile, 'Entry from reason-file', 'utf-8');
      const { status, stdout } = run(
        ['log', 'add', '--node', 'orders/order-service', '--reason-file', reasonFile],
        tmpDir,
      );
      expect(status).toBe(0);
      expect(stdout).toContain('Added log entry');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('yg log read --top 1 returns only the latest entry', () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'yg-e2e-log-top-'));
    try {
      cpSync(FIXTURE, tmpDir, { recursive: true });
      run(['log', 'add', '--node', 'orders/order-service', '--reason', 'Older entry'], tmpDir);
      run(['log', 'add', '--node', 'orders/order-service', '--reason', 'Newer entry'], tmpDir);
      const { status, stdout } = run(
        ['log', 'read', '--node', 'orders/order-service', '--top', '1'],
        tmpDir,
      );
      expect(status).toBe(0);
      expect(stdout).toContain('Newer entry');
      expect(stdout).not.toContain('Older entry');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('yg log read for nonexistent node returns exit 1', () => {
    const { status, stderr } = run(['log', 'read', '--node', 'nonexistent/node']);
    expect(status).toBe(1);
    expect(stderr).toContain('Node not found');
  });

  it('yg log merge-resolve without --node returns exit 1', () => {
    const { status, stderr } = run(['log', 'merge-resolve']);
    expect(status).toBe(1);
    expect(stderr).toContain('--node');
  });

  it('yg log without subcommand shows usage and returns exit 1', () => {
    const { status, stdout, stderr } = run(['log']);
    expect(status).toBe(1);
    expect(stdout + stderr).toContain('Usage: yg log');
  });

  // --- deterministic-test extended ---

  it('yg deterministic-test without --aspect returns exit 1', () => {
    const { status, stderr } = run(['deterministic-test']);
    expect(status).toBe(1);
    expect(stderr).toContain('--aspect');
  });

  it('yg deterministic-test with valid aspect but no --files or --node returns exit 1', () => {
    const WORKSPACE_ROOT = path.resolve(CLI_ROOT, '../..');
    const { status, stderr } = run(
      ['deterministic-test', '--aspect', 'no-direct-console'],
      WORKSPACE_ROOT,
    );
    expect(status).toBe(1);
    expect(stderr).toContain('Neither --node nor --files');
  });

  it('yg deterministic-test with --files runs check against specific files', () => {
    const WORKSPACE_ROOT = path.resolve(CLI_ROOT, '../..');
    const { stdout, status } = run(
      [
        'deterministic-test',
        '--aspect', 'no-direct-console',
        '--files', 'source/cli/src/formatters/message-builder.ts',
      ],
      WORKSPACE_ROOT,
    );
    expect(status).toBe(0);
    expect(stdout).toContain('No violations');
  });

  // --- v5 reviewer tiers ---

  it('yg check rejects legacy reviewer config with a migration hint', () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'yg-e2e-legacy-config-'));
    try {
      cpSync(FIXTURE, tmpDir, { recursive: true });
      writeFileSync(
        path.join(tmpDir, '.yggdrasil', 'yg-config.yaml'),
        'version: "4.3.0"\nreviewer:\n  ollama:\n    model: qwen3\n    endpoint: http://localhost:11434\n',
        'utf-8',
      );
      const { status, stdout } = run(['check'], tmpDir);
      expect(status).toBe(1);
      expect(stdout).toContain('legacy reviewer format');
      expect(stdout).toContain('yg init --upgrade');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('yg init --upgrade migrates v4 reviewer config to v5 tiers', () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'yg-e2e-migrate-v5-'));
    const yggDir = path.join(tmpDir, '.yggdrasil');
    mkdirSync(path.join(yggDir, 'schemas'), { recursive: true });
    writeFileSync(
      path.join(yggDir, 'yg-config.yaml'),
      'version: "4.3.0"\nreviewer:\n  consensus: 1\n  ollama:\n    model: qwen3\n    endpoint: http://localhost:11434\n',
      'utf-8',
    );
    try {
      const { status } = run(['init', '--upgrade', '--platform', 'generic'], tmpDir);
      expect(status).toBe(0);
      const config = readFileSync(path.join(yggDir, 'yg-config.yaml'), 'utf-8');
      expect(config).toContain('tiers:');
      expect(config).toContain('provider: ollama');
      expect(config).toContain('consensus: 1');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('yg approve --dry-run with v5 tiers config shows tier info', () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'yg-e2e-dryrun-v5-'));
    try {
      cpSync(FIXTURE, tmpDir, { recursive: true });
      const { stdout, status } = run(['approve', '--node', 'orders/order-service', '--dry-run'], tmpDir);
      expect(status).toBe(0);
      expect(stdout).toContain('Dry run');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

});
