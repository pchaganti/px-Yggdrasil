import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, writeFile, mkdir, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runVersionUpgrade } from '../../../src/cli/init.js';

async function scaffoldExistingYgg(projectRoot: string, version: string): Promise<string> {
  const yggRoot = path.join(projectRoot, '.yggdrasil');
  await mkdir(path.join(yggRoot, 'model'), { recursive: true });
  await mkdir(path.join(yggRoot, 'aspects'), { recursive: true });
  await mkdir(path.join(yggRoot, 'flows'), { recursive: true });
  await mkdir(path.join(yggRoot, 'schemas'), { recursive: true });
  await writeFile(
    path.join(yggRoot, 'yg-config.yaml'),
    `version: ${version}\n`,
    'utf-8',
  );
  return yggRoot;
}

describe('runVersionUpgrade', () => {
  const dirsToCleanup: string[] = [];
  afterEach(async () => {
    for (const d of dirsToCleanup.splice(0)) await rm(d, { recursive: true, force: true });
  });

  it('refreshes schemas, bumps version, installs rules for platform', async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), 'yg-init-upgrade-'));
    dirsToCleanup.push(projectRoot);
    const yggRoot = await scaffoldExistingYgg(projectRoot, '4.0.0');

    const result = await runVersionUpgrade(
      projectRoot,
      yggRoot,
      'claude-code',
    );

    // installForClaudeCode returns the agentRulesPath (.yggdrasil/agent-rules.md)
    // after writing the import line to CLAUDE.md
    expect(result.rulesPath).toContain('agent-rules.md');
    await expect(stat(result.rulesPath)).resolves.toBeTruthy();

    // CLAUDE.md is created at project root with the import line
    const claudeMd = await readFile(path.join(projectRoot, 'CLAUDE.md'), 'utf-8');
    expect(claudeMd).toContain('agent-rules.md');

    // Version advanced by each registered incremental migration; the
    // 4.0.0→4.3.0 migration is the next applicable step from 4.0.0.
    const cfg = await readFile(path.join(yggRoot, 'yg-config.yaml'), 'utf-8');
    expect(cfg).toMatch(/version:\s*["'](4\.3\.0|5\.0\.0)["']/);

    // Schemas directory is populated after refresh
    const schemaFiles = await (await import('node:fs/promises')).readdir(
      path.join(yggRoot, 'schemas'),
    );
    expect(schemaFiles.length).toBeGreaterThan(0);

    // yg-architecture.yaml created if missing
    await expect(stat(path.join(yggRoot, 'yg-architecture.yaml'))).resolves.toBeTruthy();
  });

  it('installs the rules file for a different platform on re-run', async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), 'yg-init-upgrade-'));
    dirsToCleanup.push(projectRoot);
    const yggRoot = await scaffoldExistingYgg(projectRoot, '4.0.0');

    const result = await runVersionUpgrade(
      projectRoot,
      yggRoot,
      'cursor',
    );

    expect(result.rulesPath).toMatch(/\.cursor[/\\]rules[/\\]yggdrasil\.mdc$/);
    await expect(stat(result.rulesPath)).resolves.toBeTruthy();
  });
});
