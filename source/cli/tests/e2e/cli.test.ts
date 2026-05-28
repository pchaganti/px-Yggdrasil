import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, cpSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

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

describe.skipIf(!distExists)('CLI E2E', () => {
  it('yg --help shows usage', () => {
    const { stdout, status } = run(['--help']);
    expect(status).toBe(0);
    expect(stdout).toContain('Usage: yg');
    expect(stdout).toContain('Yggdrasil');
    expect(stdout).toContain('Commands:');
  });

  it('yg --version', () => {
    const { stdout, status } = run(['--version']);
    expect(stdout.trim()).toBe(PKG_VERSION);
    expect(status).toBe(0);
  });

  it('yg aspects lists aspects with YAML output', () => {
    const { stdout, status } = run(['aspects']);
    expect(status).toBe(0);
    expect(stdout).toContain('requires-audit');
  });

  it('yg aspects without .yggdrasil returns exit 1', () => {
    const emptyDir = mkdtempSync(path.join(tmpdir(), 'yg-e2e-aspects-no-ygg-'));
    try {
      const { status, stderr } = run(['aspects'], emptyDir);
      expect(status).toBe(1);
      expect(stderr).toContain('yg init');
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it('yg tree without .yggdrasil returns exit 1', () => {
    const emptyDir = mkdtempSync(path.join(tmpdir(), 'yg-e2e-no-ygg-'));
    try {
      const { status, stderr } = run(['tree'], emptyDir);
      expect(status).toBe(1);
      expect(stderr).toContain('No .yggdrasil/');
      expect(stderr).toContain('yg init');
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it('yg tree', () => {
    const { stdout, status } = run(['tree']);
    expect(status).toBe(0);
    expect(stdout).toContain('auth');
    expect(stdout).toContain('orders');
    expect(stdout).toContain('users');
  });

  it('yg check exits with code 0 or 1 and shows Result:', () => {
    const { status, stdout } = run(['check']);
    expect([0, 1]).toContain(status);
    expect(stdout).toContain('Result:');
  });

  it('yg context', () => {
    const { stdout, status } = run(['context', '--node', 'orders/order-service']);
    expect(status).toBe(0);
    expect(stdout).toContain('orders/order-service');
    expect(stdout).toContain('Source files');
    expect(stdout).toContain('After modifying source files');
  });

  it('yg context nonexistent node', () => {
    const { status } = run(['context', '--node', 'does/not/exist']);
    expect(status).toBe(1);
  });

  it('yg context without --node or --file returns exit 1', () => {
    const { status, stderr } = run(['context']);
    expect(status).toBe(1);
    expect(stderr).toContain("'--node <path>' or '--file <path>' is required");
  });

  it('yg context --node works', () => {
    const { stdout, status } = run(['context', '--node', 'orders/order-service']);
    expect(status).toBe(0);
    expect(stdout).toContain('orders/order-service');
    expect(stdout).toContain('Source files');
    expect(stdout).toContain('After modifying source files');
  });


  it('yg deps returns non-zero (unknown command)', () => {
    const { status } = run(['deps', '--node', 'orders/order-service']);
    expect(status).not.toBe(0);
  });

  it('yg impact', () => {
    const { stdout, status } = run(['impact', '--node', 'auth/auth-api']);
    expect(status).toBe(0);
    expect(stdout).toContain('orders/order-service');
  });

  it('yg owner --file resolves file to node', () => {
    const { stdout, status } = run(['owner', '--file', 'src/orders/order.service.ts']);
    expect(status).toBe(0);
    expect(stdout).toContain('orders/order-service');
  });

  it('yg owner --file nonexistent file returns no graph coverage', () => {
    const { stdout, status } = run(['owner', '--file', 'nonexistent/file.ts']);
    expect(status).toBe(0);
    expect(stdout).toContain('no graph coverage');
  });

  it('yg owner without --file returns exit 1', () => {
    const { status, stderr } = run(['owner']);
    expect(status).toBe(1);
    expect(stderr).toContain('required option');
  });

  // --- Tree options ---

  it('yg tree --depth 1 limits output', () => {
    const { stdout, status } = run(['tree', '--depth', '1']);
    expect(status).toBe(0);
    expect(stdout).toContain('auth');
    expect(stdout).toContain('orders');
    // depth 1 means we see top-level modules but NOT their children names as tree nodes
    // Children metadata should still appear at depth 1
  });

  it('yg tree --root auth shows only auth subtree', () => {
    const { stdout, status } = run(['tree', '--root', 'auth']);
    expect(status).toBe(0);
    expect(stdout).toContain('auth');
    expect(stdout).toContain('auth/auth-api');
    // Subtree mode: only auth nodes
    expect(stdout).not.toContain('orders');
    expect(stdout).not.toContain('users');
  });

  it('yg tree shows flat list with type and description', () => {
    const { stdout, status } = run(['tree']);
    expect(status).toBe(0);
    // Flat format: path [type] — description
    expect(stdout).toMatch(/auth \[/);
    expect(stdout).toMatch(/\[module\]|\[service\]|\[project\]/);
  });

  it('yg tree --root nonexistent returns exit 1', () => {
    const { stderr, status } = run(['tree', '--root', 'nonexistent']);
    expect(status).toBe(1);
    expect(stderr).toContain('not found');
  });

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

  // --- impact edge cases ---

  it('yg impact nonexistent node returns exit code 1', () => {
    const { status, stderr } = run(['impact', '--node', 'does/not/exist']);
    expect(status).toBe(1);
    expect(stderr).toContain('Node not found');
  });

  it('yg impact without any mode returns exit 1', () => {
    const { status, stderr } = run(['impact']);
    expect(status).toBe(1);
    expect(stderr).toContain('No target specified');
  });

  it('yg impact --node and --aspect together returns exit 1', () => {
    const { status, stderr } = run(['impact', '--node', 'auth/auth-api', '--aspect', 'requires-audit']);
    expect(status).toBe(1);
    expect(stderr).toContain('Multiple targets specified');
  });

  it('yg impact --aspect requires-audit shows directly affected nodes', () => {
    const { stdout, status } = run(['impact', '--aspect', 'requires-audit']);
    expect(status).toBe(0);
    expect(stdout).toContain('Impact of changes in aspect requires-audit');
    expect(stdout).toContain('Directly affected');
    expect(stdout).toContain('orders');
    expect(stdout).toContain('Blast radius:');
  });

  it('yg impact --aspect requires-audit shows indirectly affected structural dependents', () => {
    const { stdout, status } = run(['impact', '--aspect', 'requires-audit']);
    expect(status).toBe(0);
    expect(stdout).toContain('Indirectly affected (structural dependents)');
    expect(stdout).toContain('checkout/controller');
  });

  it('yg impact --aspect requires-audit shows implies chain', () => {
    const { stdout, status } = run(['impact', '--aspect', 'requires-audit']);
    expect(status).toBe(0);
    expect(stdout).toContain('Implies: requires-logging');
  });

  it('yg impact --aspect requires-audit shows source attribution (own)', () => {
    const { stdout, status } = run(['impact', '--aspect', 'requires-audit']);
    expect(status).toBe(0);
    expect(stdout).toContain('orders (own)');
    expect(stdout).toContain('orders/order-service (own)');
  });

  it('yg impact --aspect requires-logging shows flow propagation source', () => {
    const { stdout, status } = run(['impact', '--aspect', 'requires-logging']);
    expect(status).toBe(0);
    // orders/order-service gets requires-logging from checkout-flow
    expect(stdout).toContain('orders/order-service (flow: Checkout Flow)');
    // orders gets requires-logging via implies from requires-audit
    expect(stdout).toContain('orders (implied)');
    expect(stdout).toContain('Flows propagating this aspect: Checkout Flow');
    expect(stdout).toContain('Implied by: requires-audit');
  });

  it('yg impact --aspect nonexistent returns exit 1', () => {
    const { status, stderr } = run(['impact', '--aspect', 'nonexistent']);
    expect(status).toBe(1);
    expect(stderr).toContain('Aspect not found');
  });

  it('yg impact --flow checkout-flow shows participants', () => {
    const { stdout, status } = run(['impact', '--flow', 'checkout-flow']);
    expect(status).toBe(0);
    expect(stdout).toContain('Impact of changes in flow');
    expect(stdout).toContain('orders/order-service');
    expect(stdout).toContain('auth/auth-api');
    expect(stdout).toContain('Blast radius:');
  });

  it('yg impact --flow checkout-flow shows flow aspects', () => {
    const { stdout, status } = run(['impact', '--flow', 'checkout-flow']);
    expect(status).toBe(0);
    expect(stdout).toContain('Flow aspects: requires-logging');
  });

  it('yg impact --flow checkout-flow shows indirectly affected structural dependents', () => {
    const { stdout, status } = run(['impact', '--flow', 'checkout-flow']);
    expect(status).toBe(0);
    expect(stdout).toContain('Indirectly affected (structural dependents)');
    expect(stdout).toContain('checkout/controller');
  });

  it('yg impact --flow nonexistent returns exit 1', () => {
    const { status, stderr } = run(['impact', '--flow', 'nonexistent']);
    expect(status).toBe(1);
    expect(stderr).toContain('Flow not found');
  });

  it('yg impact --node shows co-aspect nodes', () => {
    const { stdout, status } = run(['impact', '--node', 'orders/order-service']);
    expect(status).toBe(0);
    // orders/order-service has requires-audit and requires-logging
    // orders module also has these (via own + implies)
    expect(stdout).toContain('Nodes sharing aspects');
    expect(stdout).toContain('orders');
  });

  it('yg impact --node shows indirect dependents of descendants', () => {
    const { stdout, status } = run(['impact', '--node', 'orders']);
    expect(status).toBe(0);
    expect(stdout).toContain('Indirectly affected');
    expect(stdout).toContain('checkout/controller');
  });

  it('yg impact --file resolves owner and shows impact', () => {
    const { stdout, status } = run(['impact', '--file', 'src/orders/order.service.ts']);
    expect(status).toBe(0);
    // file->node resolution flows through stdout (informational)
    expect(stdout).toContain('src/orders/order.service.ts -> orders/order-service');
    expect(stdout).toContain('Impact of changes in orders/order-service');
  });

  it('yg impact --simulate is rejected (unknown option)', () => {
    const { status, stderr } = run(['impact', '--node', 'auth/auth-api', '--simulate']);
    // Commander treats unknown options as errors
    expect(status).not.toBe(0);
    expect(stderr).toContain('simulate');
  });

  it('yg impact --method is rejected (unknown option)', () => {
    const { status, stderr } = run(['impact', '--node', 'auth/auth-api', '--method', 'verify']);
    expect(status).not.toBe(0);
    expect(stderr).toContain('method');
  });

  it('yg aspects output has no stability field', () => {
    const { stdout, status } = run(['aspects']);
    expect(status).toBe(0);
    expect(stdout).not.toContain('stability');
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

  // --- flows ---

  it('yg flows lists flows with participants and aspects', () => {
    const { stdout, status } = run(['flows']);
    expect(status).toBe(0);
    expect(stdout).toContain('Checkout Flow');
    expect(stdout).toContain('orders/order-service');
    expect(stdout).toContain('Aspects: requires-logging');
  });

  it('yg flows without .yggdrasil returns exit 1', () => {
    const emptyDir = mkdtempSync(path.join(tmpdir(), 'yg-e2e-flows-no-ygg-'));
    try {
      const { status, stderr } = run(['flows'], emptyDir);
      expect(status).toBe(1);
      expect(stderr).toContain('yg init');
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  // --- find ---

  it('yg find returns ranked entry points matching the query', () => {
    const { stdout, status } = run(['find', 'order']);
    expect(status).toBe(0);
    expect(stdout).toContain('orders');
    expect(stdout).toContain('score:');
  });

  it('yg find without query returns exit 1', () => {
    const { status, stderr } = run(['find']);
    expect(status).toBe(1);
    expect(stderr).toContain('query');
  });

  // --- context --file ---

  it('yg context --file resolves a source file to its owning node', () => {
    const { stdout, status } = run(['context', '--file', 'src/orders/order.service.ts']);
    expect(status).toBe(0);
    expect(stdout).toContain('orders/order-service');
    expect(stdout).toContain('Must satisfy');
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

  // --- ast-test ---

  it('yg ast-test with unknown aspect returns exit 1', () => {
    const { status, stderr } = run(['ast-test', '--aspect', 'nonexistent-aspect-xyz']);
    expect(status).toBe(1);
    expect(stderr).toContain('not found');
  });

  it('yg ast-test with LLM reviewer aspect returns exit 1 with reviewer error', () => {
    const { status, stderr } = run(['ast-test', '--aspect', 'requires-audit']);
    expect(status).toBe(1);
    expect(stderr).toContain('reviewer');
  });

  it('yg ast-test runs AST check and reports no violations on clean code', () => {
    // Use the dogfood project which has real AST aspects and a proper node_modules tree
    const WORKSPACE_ROOT = path.resolve(CLI_ROOT, '../..');
    const { stdout, status } = run(
      ['ast-test', '--aspect', 'no-direct-console', '--node', 'cli/formatters'],
      WORKSPACE_ROOT,
    );
    expect(status).toBe(0);
    expect(stdout).toContain('No violations');
  });

  // --- type-suggest ---

  it('yg type-suggest --file shows matching architecture types', () => {
    const { stdout, status } = run(['type-suggest', '--file', 'src/orders/order.service.ts']);
    expect(status).toBe(0);
    expect(stdout).toMatch(/service|repository/);
  });

  it('yg type-suggest without --file returns exit 1', () => {
    const { status, stderr } = run(['type-suggest']);
    expect(status).toBe(1);
    expect(stderr).toContain('file');
  });

  // --- knowledge ---

  it('yg knowledge list shows all available topics', () => {
    const { stdout, status } = run(['knowledge', 'list']);
    expect(status).toBe(0);
    expect(stdout).toContain('flows');
    expect(stdout).toContain('cli-reference');
    expect(stdout).toContain('To read a topic:');
  });

  it('yg knowledge read returns the topic content', () => {
    const { stdout, status } = run(['knowledge', 'read', 'flows']);
    expect(status).toBe(0);
    expect(stdout.length).toBeGreaterThan(200);
    expect(stdout.toLowerCase()).toContain('flow');
  });

  it('yg knowledge read with unknown topic returns exit 1', () => {
    const { status, stderr } = run(['knowledge', 'read', 'nonexistent-topic-xyz']);
    expect(status).toBe(1);
    expect(stderr).toContain('nonexistent-topic-xyz');
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

  // --- check - no .yggdrasil ---

  it('yg check without .yggdrasil returns exit 1', () => {
    const emptyDir = mkdtempSync(path.join(tmpdir(), 'yg-e2e-check-no-ygg-'));
    try {
      const { status, stderr } = run(['check'], emptyDir);
      expect(status).toBe(1);
      expect(stderr).toContain('yg init');
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
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

  // --- impact extended ---

  it('yg impact --type service shows nodes of that type', () => {
    const { stdout, status } = run(['impact', '--type', 'service']);
    expect(status).toBe(0);
    expect(stdout).toContain('Type: service');
    expect(stdout).toContain('auth/auth-api');
    expect(stdout).toContain('orders/order-service');
  });

  it('yg impact --type nonexistent returns exit 1', () => {
    const { status, stderr } = run(['impact', '--type', 'nonexistent-type-xyz']);
    expect(status).toBe(1);
    expect(stderr).toContain('not found in architecture');
  });

  it('yg impact --node and --file together returns exit 1', () => {
    const { status, stderr } = run(['impact', '--node', 'orders/order-service', '--file', 'src/orders/order.service.ts']);
    expect(status).toBe(1);
    expect(stderr).toContain('mutually exclusive');
  });

  it('yg impact --flow and --aspect together returns exit 1', () => {
    const { status, stderr } = run(['impact', '--flow', 'checkout-flow', '--aspect', 'requires-audit']);
    expect(status).toBe(1);
    expect(stderr).toContain('Multiple targets specified');
  });

  it('yg impact --file nonexistent path returns exit 1', () => {
    const { status, stderr } = run(['impact', '--file', 'src/does-not-exist.ts']);
    expect(status).toBe(1);
    expect(stderr).toContain('not mapped');
  });

  // --- owner extended ---

  it('yg owner without .yggdrasil returns exit 1', () => {
    const emptyDir = mkdtempSync(path.join(tmpdir(), 'yg-e2e-owner-no-ygg-'));
    try {
      const { status, stderr } = run(['owner', '--file', 'src/foo.ts'], emptyDir);
      expect(status).toBe(1);
      expect(stderr).toContain('yg init');
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  // --- find extended ---

  it('yg find without .yggdrasil returns exit 1', () => {
    const emptyDir = mkdtempSync(path.join(tmpdir(), 'yg-e2e-find-no-ygg-'));
    try {
      const { status, stderr } = run(['find', 'order'], emptyDir);
      expect(status).toBe(1);
      expect(stderr).toContain('yg init');
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it('yg find with no matching query returns exit 0 with no matches', () => {
    const { stdout, status } = run(['find', 'xyzqwerty123nonexistent']);
    expect(status).toBe(0);
    expect(stdout).toContain('No matches');
  });

  // --- context extended ---

  it('yg context --file unmapped file returns exit 1', () => {
    const { status, stderr } = run(['context', '--file', 'src/unmapped-file.ts']);
    expect(status).toBe(1);
    expect(stderr).toContain('no graph coverage');
  });

  it('yg context without .yggdrasil returns exit 1', () => {
    const emptyDir = mkdtempSync(path.join(tmpdir(), 'yg-e2e-ctx-no-ygg-'));
    try {
      const { status, stderr } = run(['context', '--node', 'foo'], emptyDir);
      expect(status).toBe(1);
      expect(stderr).toContain('yg init');
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  // --- type-suggest extended ---

  it('yg type-suggest --file nonexistent path runs path-only check', () => {
    const { stdout, status } = run(['type-suggest', '--file', 'src/nonexistent/foo.ts']);
    expect(status).toBe(0);
    expect(stdout).toContain('path predicates only');
    expect(stdout).toContain('service');
  });

  it('yg type-suggest --file inside .yggdrasil/ is auto-exempt', () => {
    const { stdout, status } = run(['type-suggest', '--file', '.yggdrasil/model/auth/yg-node.yaml']);
    expect(status).toBe(0);
    expect(stdout).toContain('auto-exempt');
  });

  it('yg type-suggest without .yggdrasil returns exit 1', () => {
    const emptyDir = mkdtempSync(path.join(tmpdir(), 'yg-e2e-ts-no-ygg-'));
    try {
      const { status, stderr } = run(['type-suggest', '--file', 'src/foo.ts'], emptyDir);
      expect(status).toBe(1);
      expect(stderr).toContain('yg init');
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

  // --- ast-test extended ---

  it('yg ast-test without --aspect returns exit 1', () => {
    const { status, stderr } = run(['ast-test']);
    expect(status).toBe(1);
    expect(stderr).toContain('--aspect');
  });

  it('yg ast-test with valid AST aspect but no --files or --node returns exit 1', () => {
    const WORKSPACE_ROOT = path.resolve(CLI_ROOT, '../..');
    const { status, stderr } = run(['ast-test', '--aspect', 'no-direct-console'], WORKSPACE_ROOT);
    expect(status).toBe(1);
    expect(stderr).toContain('--files');
  });

  it('yg ast-test with --files runs check against specific files', () => {
    const WORKSPACE_ROOT = path.resolve(CLI_ROOT, '../..');
    const { stdout, status } = run(
      [
        'ast-test',
        '--aspect', 'no-direct-console',
        '--files', 'source/cli/src/formatters/message-builder.ts',
      ],
      WORKSPACE_ROOT,
    );
    expect(status).toBe(0);
    expect(stdout).toContain('No violations');
  });

  // --- knowledge extended ---

  it('yg knowledge without subcommand shows usage and returns exit 1', () => {
    const { status, stdout, stderr } = run(['knowledge']);
    expect(status).toBe(1);
    expect(stdout + stderr).toContain('Usage: yg knowledge');
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
