import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, writeFile, mkdir, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runVersionUpgrade, ensureGitattributes, ensureProjectGitignore } from '../../../src/cli/init.js';

const LOCK_LINE = '/.yggdrasil/yg-lock.json linguist-generated=true';
const CACHE_LINE = '.yggdrasil/.symbols-cache/';

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

    // With MIGRATIONS empty the runner lifts the version to CLI_SUPPORTED_SCHEMA
    // (5.0.0) via the no-migration fallback path and emits an action message.
    const cfg = await readFile(path.join(yggRoot, 'yg-config.yaml'), 'utf-8');
    expect(cfg).toContain('5.0.0');
    expect(result.migrationActions).toEqual(
      expect.arrayContaining([
        expect.stringContaining('version updated to 5.0.0'),
      ]),
    );

    // Schemas directory is populated after refresh
    const schemaFiles = await (await import('node:fs/promises')).readdir(
      path.join(yggRoot, 'schemas'),
    );
    expect(schemaFiles.length).toBeGreaterThan(0);

    // yg-architecture.yaml created if missing
    await expect(stat(path.join(yggRoot, 'yg-architecture.yaml'))).resolves.toBeTruthy();
  });

  it('is a clean no-op when config is already at the supported schema version', async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), 'yg-init-upgrade-'));
    dirsToCleanup.push(projectRoot);
    const yggRoot = await scaffoldExistingYgg(projectRoot, '5.0.0');

    const result = await runVersionUpgrade(
      projectRoot,
      yggRoot,
      'claude-code',
    );

    // Version must stay at 5.0.0 — no write, no false 'Migrated' action.
    const cfg = await readFile(path.join(yggRoot, 'yg-config.yaml'), 'utf-8');
    expect(cfg).toContain('5.0.0');
    expect(result.migrationActions).toHaveLength(0);
    expect(result.migrationWarnings).toHaveLength(0);
    expect(result.withheld).toBe(false);
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

  it('writes the .gitattributes lock line during upgrade', async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), 'yg-init-upgrade-'));
    dirsToCleanup.push(projectRoot);
    const yggRoot = await scaffoldExistingYgg(projectRoot, '4.0.0');

    await runVersionUpgrade(projectRoot, yggRoot, 'claude-code');

    const ga = await readFile(path.join(projectRoot, '.gitattributes'), 'utf-8');
    expect(ga).toContain(LOCK_LINE);
  });
});

describe('ensureGitattributes', () => {
  const dirsToCleanup: string[] = [];
  afterEach(async () => {
    for (const d of dirsToCleanup.splice(0)) await rm(d, { recursive: true, force: true });
  });

  it('creates .gitattributes with the lock line when absent', async () => {
    const repoRoot = await mkdtemp(path.join(tmpdir(), 'yg-gitattr-'));
    dirsToCleanup.push(repoRoot);

    await ensureGitattributes(repoRoot);

    const ga = await readFile(path.join(repoRoot, '.gitattributes'), 'utf-8');
    expect(ga).toBe(`${LOCK_LINE}\n`);
  });

  it('leaves the file unchanged when the lock line is already present', async () => {
    const repoRoot = await mkdtemp(path.join(tmpdir(), 'yg-gitattr-'));
    dirsToCleanup.push(repoRoot);
    const original = `* text=auto\n${LOCK_LINE}\n`;
    await writeFile(path.join(repoRoot, '.gitattributes'), original, 'utf-8');

    await ensureGitattributes(repoRoot);

    const ga = await readFile(path.join(repoRoot, '.gitattributes'), 'utf-8');
    expect(ga).toBe(original);
  });

  it('appends the lock line exactly once when other content exists', async () => {
    const repoRoot = await mkdtemp(path.join(tmpdir(), 'yg-gitattr-'));
    dirsToCleanup.push(repoRoot);
    await writeFile(path.join(repoRoot, '.gitattributes'), '* text=auto\n', 'utf-8');

    await ensureGitattributes(repoRoot);
    // Second call must NOT append a duplicate.
    await ensureGitattributes(repoRoot);

    const ga = await readFile(path.join(repoRoot, '.gitattributes'), 'utf-8');
    expect(ga).toBe(`* text=auto\n${LOCK_LINE}\n`);
    const occurrences = ga.split('\n').filter((l) => l.trim() === LOCK_LINE).length;
    expect(occurrences).toBe(1);
  });

  it('inserts a separating newline when the existing file lacks a trailing one', async () => {
    const repoRoot = await mkdtemp(path.join(tmpdir(), 'yg-gitattr-'));
    dirsToCleanup.push(repoRoot);
    await writeFile(path.join(repoRoot, '.gitattributes'), '* text=auto', 'utf-8');

    await ensureGitattributes(repoRoot);

    const ga = await readFile(path.join(repoRoot, '.gitattributes'), 'utf-8');
    expect(ga).toBe(`* text=auto\n${LOCK_LINE}\n`);
  });
});

describe('ensureProjectGitignore', () => {
  const dirsToCleanup: string[] = [];
  afterEach(async () => {
    for (const d of dirsToCleanup.splice(0)) await rm(d, { recursive: true, force: true });
  });

  it('creates .gitignore with the cache line when absent', async () => {
    const repoRoot = await mkdtemp(path.join(tmpdir(), 'yg-gitignore-'));
    dirsToCleanup.push(repoRoot);

    await ensureProjectGitignore(repoRoot);

    const gi = await readFile(path.join(repoRoot, '.gitignore'), 'utf-8');
    expect(gi).toBe(`${CACHE_LINE}\n`);
  });

  it('leaves the file unchanged when the cache line is already present', async () => {
    const repoRoot = await mkdtemp(path.join(tmpdir(), 'yg-gitignore-'));
    dirsToCleanup.push(repoRoot);
    const original = `node_modules/\n${CACHE_LINE}\n`;
    await writeFile(path.join(repoRoot, '.gitignore'), original, 'utf-8');

    await ensureProjectGitignore(repoRoot);

    const gi = await readFile(path.join(repoRoot, '.gitignore'), 'utf-8');
    expect(gi).toBe(original);
  });

  it('appends the cache line exactly once when other content exists', async () => {
    const repoRoot = await mkdtemp(path.join(tmpdir(), 'yg-gitignore-'));
    dirsToCleanup.push(repoRoot);
    await writeFile(path.join(repoRoot, '.gitignore'), 'node_modules/\n', 'utf-8');

    await ensureProjectGitignore(repoRoot);
    // Second call must NOT append a duplicate.
    await ensureProjectGitignore(repoRoot);

    const gi = await readFile(path.join(repoRoot, '.gitignore'), 'utf-8');
    expect(gi).toBe(`node_modules/\n${CACHE_LINE}\n`);
    const occurrences = gi.split('\n').filter((l) => l.trim() === CACHE_LINE).length;
    expect(occurrences).toBe(1);
  });

  it('inserts a separating newline when the existing file lacks a trailing one', async () => {
    const repoRoot = await mkdtemp(path.join(tmpdir(), 'yg-gitignore-'));
    dirsToCleanup.push(repoRoot);
    await writeFile(path.join(repoRoot, '.gitignore'), 'node_modules/', 'utf-8');

    await ensureProjectGitignore(repoRoot);

    const gi = await readFile(path.join(repoRoot, '.gitignore'), 'utf-8');
    expect(gi).toBe(`node_modules/\n${CACHE_LINE}\n`);
  });
});
