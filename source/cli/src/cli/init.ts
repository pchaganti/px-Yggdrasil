import { Command } from 'commander';
import chalk from 'chalk';
import { mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import * as p from '@clack/prompts';
import { parse as yamlParse, stringify as yamlStringify } from 'yaml';
import { DEFAULT_CONFIG, DEFAULT_ARCHITECTURE } from '../templates/default-config.js';
import { installRulesForPlatform, PLATFORMS, type Platform } from '../templates/platform.js';
import { fetchAnthropicModels, fetchOpenAIModels, fetchGoogleModels, fetchOllamaModels } from '../llm/model-fetcher.js';
import { testApiProvider, testCliProvider } from '../llm/reviewer-test.js';
import type { ReviewerProvider } from '../model/graph.js';
import { detectVersion } from '../core/migrator.js';
import { runVersionUpgrade as coreRunVersionUpgrade } from '../core/migrator-runner.js';
import { CLI_SUPPORTED_SCHEMA } from '../core/graph-loader.js';
import { abortOnUnexpectedError } from './preamble.js';
import { MIGRATIONS } from '../migrations/index.js';
import { buildIssueMessage } from '../formatters/message-builder.js';
import { debugWrite } from '../utils/debug-log.js';
import { toPosixPath } from '../utils/posix.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isTTY(): boolean {
  return process.stdout.isTTY === true && process.stdin.isTTY === true;
}

function assertNotCancelled<T>(value: T | symbol): asserts value is T {
  if (p.isCancel(value)) {
    p.cancel('Operation cancelled.');
    process.exit(0);
  }
}

/** The exact .gitattributes line that marks the committed lock files as generated for
 *  diff/review tools. The glob covers the triad's committed members
 *  (yg-lock.nondeterministic.json, yg-lock.logs.json); the gitignored deterministic
 *  cache is never committed, so it needs no attribute. */
const GITATTRIBUTES_LOCK_LINE = '/.yggdrasil/yg-lock.*.json linguist-generated=true';

/**
 * Ensure the repo-root .gitattributes carries the lock's linguist-generated
 * line (spec §8). The lock is committed but machine-written — marking it
 * generated keeps it out of language stats and collapses it in review diffs.
 *
 * Idempotent: creates the file with the single line when absent; appends the
 * line exactly once when the file exists without it (preserving other content
 * and ensuring a separating newline); no-op when the line is already present.
 * Run on fresh init AND every --upgrade so existing adopters pick it up.
 */
export async function ensureGitattributes(repoRoot: string): Promise<void> {
  const gaPath = path.join(repoRoot, '.gitattributes');
  let existing: string | undefined;
  try {
    existing = await readFile(gaPath, 'utf-8');
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    debugWrite(`[init] ensureGitattributes: ${gaPath} not found (ENOENT), will create`);
    existing = undefined;
  }

  if (existing === undefined) {
    await writeFile(gaPath, `${GITATTRIBUTES_LOCK_LINE}\n`, 'utf-8');
    return;
  }

  // Already present (anywhere, as a full line) → nothing to do.
  const hasLine = existing
    .split('\n')
    .some((line) => line.trim() === GITATTRIBUTES_LOCK_LINE);
  if (hasLine) return;

  // Append once, guaranteeing a newline boundary before and after.
  const sep = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
  await writeFile(gaPath, `${existing}${sep}${GITATTRIBUTES_LOCK_LINE}\n`, 'utf-8');
}

/** The lines `.yggdrasil/.gitignore` must carry, in order. All Yggdrasil-derived
 *  local state lives under `.yggdrasil/` and is rebuildable or secret — it must
 *  never be committed:
 *    - `yg-secrets.yaml`  — provider API keys
 *    - `.symbols-cache/`  — the relation pass's per-language symbol-index cache
 *    - `.debug.log`       — the opt-in command debug log
 *  This is the single source of truth for what init writes into the local
 *  gitignore (both fresh init and every --upgrade). Paths are relative to the
 *  `.yggdrasil/` directory the file lives in. */
const YGGDRASIL_GITIGNORE_LINES = [
  'yg-secrets.yaml',
  '.symbols-cache/',
  '.debug.log',
  // Deterministic-verdict lock: a local cache rebuilt for free by
  // `yg check --approve --only-deterministic`; never committed.
  '.yg-lock.deterministic.json',
] as const;

/**
 * Ensure `<yggRoot>/.gitignore` carries every required line. `.yggdrasil/` is the
 * single home for all Yggdrasil-derived local state (secrets, the relation
 * symbol-index cache, the debug log); none of it may be committed (a committed
 * cache trips the coverage gate as an unmapped file the moment it is tracked, and
 * secrets must never reach the repo).
 *
 * Idempotent: creates the file with all lines when absent; appends only the
 * missing line(s), once each, when the file exists without them (preserving any
 * other existing content and ensuring a separating newline); no-op when every
 * line is already present. Run on fresh init AND every --upgrade so existing
 * adopters pick up the complete set.
 */
export async function ensureYggdrasilGitignore(yggRoot: string): Promise<void> {
  const giPath = path.join(yggRoot, '.gitignore');
  let existing: string | undefined;
  try {
    existing = await readFile(giPath, 'utf-8');
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    debugWrite(`[init] ensureYggdrasilGitignore: ${giPath} not found (ENOENT), will create`);
    existing = undefined;
  }

  if (existing === undefined) {
    await writeFile(giPath, `${YGGDRASIL_GITIGNORE_LINES.join('\n')}\n`, 'utf-8');
    return;
  }

  const presentLines = new Set(existing.split('\n').map((line) => line.trim()));
  const missing = YGGDRASIL_GITIGNORE_LINES.filter((line) => !presentLines.has(line));
  if (missing.length === 0) return;

  // Append each missing line once, guaranteeing a newline boundary before and after.
  const sep = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
  await writeFile(giPath, `${existing}${sep}${missing.join('\n')}\n`, 'utf-8');
}

const API_PROVIDERS: ReviewerProvider[] = ['anthropic', 'openai', 'google', 'openai-compatible', 'ollama'];
const CLI_PROVIDERS: ReviewerProvider[] = ['claude-code', 'codex', 'gemini-cli'];
const CLAUDE_CODE_ALIASES = [
  { value: 'haiku', label: 'haiku' },
  { value: 'sonnet', label: 'sonnet' },
  { value: 'opus', label: 'opus' },
];

// ---------------------------------------------------------------------------
// Platform prompt
// ---------------------------------------------------------------------------

async function promptPlatform(): Promise<Platform> {
  const platform = await p.select<Platform>({
    message: 'Select your agent platform',
    options: PLATFORMS.map((pl) => ({ value: pl, label: pl })),
  });
  assertNotCancelled(platform);
  return platform;
}

// ---------------------------------------------------------------------------
// Reviewer configuration flow
// ---------------------------------------------------------------------------

export function needsApiKey(provider: ReviewerProvider): boolean {
  return !CLI_PROVIDERS.includes(provider) && provider !== 'ollama';
}

function needsEndpoint(provider: ReviewerProvider): boolean {
  return provider === 'openai-compatible' || provider === 'ollama';
}

async function promptApiKey(provider: ReviewerProvider): Promise<string> {
  const envVars: Record<string, string> = {
    anthropic: 'ANTHROPIC_API_KEY',
    openai: 'OPENAI_API_KEY',
    google: 'GOOGLE_API_KEY',
    'openai-compatible': 'OPENAI_API_KEY',
  };
  const envVar = envVars[provider];
  const hint = envVar ? ` (or set ${envVar} env var)` : '';
  const key = await p.text({
    message: `API key for ${provider}${hint}`,
    placeholder: 'Stored in .yggdrasil/yg-secrets.yaml (gitignored)',
    validate: (v) => ((v ?? '').trim().length === 0 ? 'API key cannot be empty' : undefined),
  });
  assertNotCancelled(key);
  return key.trim();
}

async function promptEndpoint(provider: ReviewerProvider): Promise<string> {
  const defaultEndpoint = provider === 'ollama' ? 'http://localhost:11434' : undefined;
  const endpoint = await p.text({
    message: provider === 'ollama'
      ? 'Ollama endpoint URL'
      : 'Endpoint URL (OpenAI-compatible API)',
    placeholder: defaultEndpoint,
    defaultValue: defaultEndpoint,
    validate: (v) => ((v ?? '').trim().length === 0 ? 'Endpoint cannot be empty' : undefined),
  });
  assertNotCancelled(endpoint);
  return endpoint.trim();
}

async function fetchModels(
  provider: ReviewerProvider,
  apiKey: string,
  endpoint?: string,
): Promise<{ ok: boolean; models: string[]; error?: string; is401?: boolean }> {
  let result;
  switch (provider) {
    case 'anthropic':
      result = await fetchAnthropicModels(apiKey);
      break;
    case 'openai':
    case 'openai-compatible':
      result = await fetchOpenAIModels(apiKey, endpoint);
      break;
    case 'google':
      result = await fetchGoogleModels(apiKey);
      break;
    case 'ollama':
      result = await fetchOllamaModels(endpoint);
      break;
    default:
      return { ok: false, models: [], error: `Unsupported provider for model fetch: ${provider}` };
  }
  const is401 = !result.ok && result.error?.includes('401');
  return { ...result, is401 };
}

async function promptModelFromList(models: string[]): Promise<string> {
  const model = await p.select<string>({
    message: 'Select a model',
    options: models.map((m) => ({ value: m, label: m })),
  });
  assertNotCancelled(model);
  return model;
}

async function promptModelText(provider: ReviewerProvider): Promise<string> {
  let hint = '';
  if (provider === 'codex') {
    hint = ' (see https://platform.openai.com/docs/models)';
  } else if (provider === 'gemini-cli') {
    hint = ' (see https://ai.google.dev/gemini-api/docs/models)';
  }
  const model = await p.text({
    message: `Enter model name${hint}`,
    validate: (v) => ((v ?? '').trim().length === 0 ? 'Model name cannot be empty' : undefined),
  });
  assertNotCancelled(model);
  return model.trim();
}

async function runReviewerConfigFlow(): Promise<{
  provider: ReviewerProvider;
  model: string;
  apiKey?: string;
  endpoint?: string;
}> {
  // 1. Provider selection
  const provider = await p.select<ReviewerProvider>({
    message: 'Which provider should verify your code?',
    options: [
      { value: 'anthropic' as ReviewerProvider, label: 'Anthropic', hint: 'API — Claude models' },
      { value: 'openai' as ReviewerProvider, label: 'OpenAI', hint: 'API — GPT models' },
      { value: 'google' as ReviewerProvider, label: 'Google', hint: 'API — Gemini models' },
      { value: 'ollama' as ReviewerProvider, label: 'Ollama', hint: 'Local — no API costs' },
      { value: 'openai-compatible' as ReviewerProvider, label: 'OpenAI-compatible', hint: 'API — custom endpoint' },
      { value: 'claude-code' as ReviewerProvider, label: 'Claude Code', hint: 'CLI — uses installed claude' },
      { value: 'codex' as ReviewerProvider, label: 'Codex', hint: 'CLI — uses installed codex' },
      { value: 'gemini-cli' as ReviewerProvider, label: 'Gemini CLI', hint: 'CLI — uses installed gemini' },
    ],
  });
  assertNotCancelled(provider);

  // CLI providers: no API key needed
  if (CLI_PROVIDERS.includes(provider)) {
    // Model selection for CLI providers
    let model: string;
    if (provider === 'claude-code') {
      const selected = await p.select<string>({
        message: 'Select model alias',
        options: CLAUDE_CODE_ALIASES,
      });
      assertNotCancelled(selected);
      model = selected;
    } else {
      model = await promptModelText(provider);
    }

    // Validate CLI is installed
    const s = p.spinner();
    s.start(`Checking ${provider} installation...`);
    const testResult = await testCliProvider(provider);
    s.stop(testResult.ok ? `${provider} found` : `${provider} not found`);

    if (!testResult.ok) {
      p.log.warning(`${provider} not found on PATH: ${testResult.error}`);
      p.log.info('You can install it later. Configuration will be saved.');
    }

    return { provider, model };
  }

  // API providers
  let apiKey = '';
  if (needsApiKey(provider)) {
    apiKey = await promptApiKey(provider);
  }

  let endpoint: string | undefined;
  if (needsEndpoint(provider)) {
    endpoint = await promptEndpoint(provider);
  }

  // Fetch models
  const s = p.spinner();
  s.start('Fetching available models...');
  let fetchResult = await fetchModels(provider, apiKey, endpoint);

  // On 401: re-prompt API key once
  if (fetchResult.is401 && needsApiKey(provider)) {
    s.stop('Authentication failed (401).');
    p.log.warning('Invalid API key. Please try again.');
    apiKey = await promptApiKey(provider);
    s.start('Retrying model fetch...');
    fetchResult = await fetchModels(provider, apiKey, endpoint);
  }

  let model: string;
  if (fetchResult.ok && fetchResult.models.length > 0) {
    s.stop(`Found ${fetchResult.models.length} models.`);
    model = await promptModelFromList(fetchResult.models);
  } else {
    s.stop(fetchResult.error ? `Could not fetch models: ${fetchResult.error}` : 'No models found.');
    p.log.info('Enter model name manually.');
    model = await promptModelText(provider);
  }

  // Validation test
  const testSpinner = p.spinner();
  testSpinner.start('Testing connection...');
  const testResult = await testApiProvider(provider, apiKey, model, endpoint);
  testSpinner.stop(testResult.ok ? 'Connection successful.' : 'Connection test failed.');

  if (!testResult.ok) {
    p.log.warning(`Test failed: ${testResult.error}`);
    p.log.info('Configuration will be saved anyway. You can fix it later.');
  }

  return { provider, model, apiKey: apiKey || undefined, endpoint };
}

// ---------------------------------------------------------------------------
// Write reviewer config into yg-config.yaml
// ---------------------------------------------------------------------------

/**
 * Name of the single tier `yg init` bootstraps. Shared by writeReviewerConfig
 * (which defines the tier in yg-config.yaml) and writeSecretsFile (which writes
 * the tier's api_key into the yg-secrets.yaml overlay) so the two never drift —
 * the secrets file is a 1:1 deep-merge overlay over the config and must address
 * the SAME tier.
 */
export const BOOTSTRAP_TIER_NAME = 'standard';

export async function writeReviewerConfig(
  yggRoot: string,
  config: { provider: ReviewerProvider; model: string; endpoint?: string },
): Promise<void> {
  const configPath = path.join(yggRoot, 'yg-config.yaml');
  let raw: Record<string, unknown> = {};
  try {
    const content = await readFile(configPath, 'utf-8');
    raw = (yamlParse(content) as Record<string, unknown>) ?? {};
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code !== 'ENOENT') {
      throw new Error(`Failed to parse ${configPath}: ${e.message}`, { cause: err });
    }
    debugWrite(`[init] writeReviewerConfig: ${configPath} not found (${e.message}), starting fresh`);
  }

  // Build reviewer section with a single-tier default.
  const tierConfig: Record<string, unknown> = { model: config.model };
  if (config.endpoint) {
    tierConfig.endpoint = config.endpoint;
  }
  if (API_PROVIDERS.includes(config.provider)) {
    tierConfig.temperature = 0;
  }

  raw.reviewer = {
    tiers: {
      [BOOTSTRAP_TIER_NAME]: {
        provider: config.provider,
        consensus: 1,
        max_prompt_chars: 50000,
        config: tierConfig,
      },
    },
  };

  await writeFile(configPath, yamlStringify(raw), 'utf-8');
}

// ---------------------------------------------------------------------------
// Write API key to yg-secrets.yaml
// ---------------------------------------------------------------------------

export async function writeSecretsFile(
  yggRoot: string,
  apiKey: string,
): Promise<void> {
  const secretsPath = path.join(yggRoot, 'yg-secrets.yaml');
  let raw: Record<string, unknown> = {};
  try {
    const content = await readFile(secretsPath, 'utf-8');
    raw = (yamlParse(content) as Record<string, unknown>) ?? {};
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code !== 'ENOENT') {
      throw new Error(`Failed to parse ${secretsPath}: ${e.message}`, { cause: err });
    }
    debugWrite(`[init] writeSecretsFile: ${secretsPath} not found (${e.message}), starting fresh`);
  }

  // yg-secrets.yaml is a 1:1 deep-merge overlay over yg-config.yaml — it mirrors
  // the SAME shape. The API key belongs to the tier's `config:` block (where the
  // reviewer reads it from the resolved tier), NOT a provider-level bucket: the
  // reviewer: section accepts only `default` and `tiers`, and distinct tiers may
  // use distinct providers — so the credential is per-tier, not per-provider.
  if (!raw.reviewer || typeof raw.reviewer !== 'object') {
    raw.reviewer = {};
  }
  const reviewerSection = raw.reviewer as Record<string, unknown>;
  if (!reviewerSection.tiers || typeof reviewerSection.tiers !== 'object') {
    reviewerSection.tiers = {};
  }
  const tiers = reviewerSection.tiers as Record<string, unknown>;
  if (!tiers[BOOTSTRAP_TIER_NAME] || typeof tiers[BOOTSTRAP_TIER_NAME] !== 'object') {
    tiers[BOOTSTRAP_TIER_NAME] = {};
  }
  const tier = tiers[BOOTSTRAP_TIER_NAME] as Record<string, unknown>;
  if (!tier.config || typeof tier.config !== 'object') {
    tier.config = {};
  }
  (tier.config as Record<string, unknown>).api_key = apiKey;

  await writeFile(secretsPath, yamlStringify(raw), { encoding: 'utf-8', mode: 0o600 });
}

// ---------------------------------------------------------------------------
// Fresh init
// ---------------------------------------------------------------------------

async function freshInit(projectRoot: string): Promise<void> {
  const yggRoot = path.join(projectRoot, '.yggdrasil');

  if (!isTTY()) {
    process.stderr.write(chalk.red(`Error: ${buildIssueMessage({
      what: 'yg init requires an interactive terminal.',
      why: 'Setup requires interactive prompts to configure platform and reviewer.',
      next: 'Run yg init in an interactive terminal session.',
    })}\n`));
    process.exit(1);
  }

  p.intro(chalk.bold('Yggdrasil Setup'));

  p.log.info(
    'Yggdrasil enforces architectural rules on AI-generated code.\n' +
    '  You write rules (aspects), the agent manages the graph,\n' +
    '  and a reviewer verifies compliance after every change.',
  );

  // 1. Platform — determines which rules file the agent reads
  p.log.step('Step 1: AI coding platform');
  p.log.info('This installs a rules file that teaches your agent the Yggdrasil protocol.');
  const platform = await promptPlatform();

  // 2. Reviewer — the LLM that verifies aspects against source code
  p.log.step('Step 2: Reviewer provider');
  p.log.info(
    'The reviewer checks your source code against aspect rules during yg check --approve.\n' +
    '  API providers make HTTP calls. CLI providers delegate to an installed agent.\n' +
    '  For local review without API costs, use Ollama.',
  );
  const reviewerConfig = await runReviewerConfigFlow();

  // 3. Create structure + write config
  await createYggdrasilStructure(projectRoot, yggRoot, platform);

  await writeReviewerConfig(yggRoot, reviewerConfig);
  if (reviewerConfig.apiKey) {
    await writeSecretsFile(yggRoot, reviewerConfig.apiKey);
  }

  await ensureGitattributes(projectRoot);

  p.outro(chalk.green('Yggdrasil initialized. Run yg check to get started.'));
}

async function createYggdrasilStructure(
  projectRoot: string,
  yggRoot: string,
  platform: Platform,
): Promise<void> {
  await mkdir(path.join(yggRoot, 'model'), { recursive: true });
  await mkdir(path.join(yggRoot, 'aspects'), { recursive: true });
  await mkdir(path.join(yggRoot, 'flows'), { recursive: true });

  await writeFile(path.join(yggRoot, 'yg-config.yaml'), DEFAULT_CONFIG, 'utf-8');
  await writeFile(path.join(yggRoot, 'yg-architecture.yaml'), DEFAULT_ARCHITECTURE, 'utf-8');
  await ensureYggdrasilGitignore(yggRoot);
  // yg-secrets.yaml is created by writeSecretsFile when user provides an API key

  await installRulesForPlatform(projectRoot, platform);
}

// ---------------------------------------------------------------------------
// Version upgrade — shared between the version-mismatch branch and --upgrade --platform flag path
// ---------------------------------------------------------------------------

export interface VersionUpgradeResult {
  rulesPath: string;
  migrationActions: string[];
  migrationWarnings: string[];
  /** True when a migration withheld the version bump (incomplete upgrade). */
  withheld: boolean;
}

export async function runVersionUpgrade(
  projectRoot: string,
  yggRoot: string,
  platform: Platform,
): Promise<VersionUpgradeResult> {
  const { migrationActions, migrationWarnings, withheld } = await coreRunVersionUpgrade({
    yggRoot, migrations: MIGRATIONS, targetVersion: CLI_SUPPORTED_SCHEMA,
  });

  const architecturePath = path.join(yggRoot, 'yg-architecture.yaml');
  try {
    await stat(architecturePath);
  } catch (e: unknown) {
    debugWrite(`[init] runVersionUpgrade architecture file missing, writing default: ${e instanceof Error ? e.message : String(e)}`);
    await writeFile(architecturePath, DEFAULT_ARCHITECTURE, 'utf-8');
  }

  const rawRulesPath = await installRulesForPlatform(projectRoot, platform);
  const rulesPath = toPosixPath(rawRulesPath);

  // Maintain the lock's .gitattributes line on every upgrade so existing
  // adopters pick it up (both the interactive and non-interactive --upgrade
  // paths route through here). Idempotent.
  await ensureGitattributes(projectRoot);
  // Likewise ensure `.yggdrasil/.gitignore` carries the full set of local
  // rebuildable/secret state (secrets, the relation symbol-index cache, the
  // debug log) so existing adopters pick up the complete set. Idempotent.
  await ensureYggdrasilGitignore(yggRoot);

  return { rulesPath, migrationActions, migrationWarnings, withheld };
}

// ---------------------------------------------------------------------------
// Existing repo menu
// ---------------------------------------------------------------------------

async function existingInit(projectRoot: string): Promise<void> {
  const yggRoot = path.join(projectRoot, '.yggdrasil');

  if (!isTTY()) {
    process.stdout.write(chalk.yellow(buildIssueMessage({
      what: '.yggdrasil/ already exists.',
      why: 'Re-configuration requires interactive prompts which are not available in non-TTY mode.',
      next: 'Run yg init interactively in a terminal to reconfigure.',
    }) + '\n'));
    return;
  }

  p.intro(chalk.bold('Yggdrasil Configuration'));

  // Check for pending migrations. The graph version is the SCHEMA version — it
  // advances only when the graph format changes, not on every package release —
  // so compare it against CLI_SUPPORTED_SCHEMA, never the package version. A
  // patch release that leaves the format unchanged needs no upgrade.
  const currentVersion = await detectVersion(yggRoot);

  if (currentVersion && currentVersion !== CLI_SUPPORTED_SCHEMA) {
    p.log.step(`Graph schema ${currentVersion} detected — this CLI uses schema ${CLI_SUPPORTED_SCHEMA}. Upgrade required.`);
    p.log.info('Select the agent platform so the rules are regenerated for the upgrade.');
    const platform = await promptPlatform();

    const s = p.spinner();
    s.start('Running migrations and installing rules...');
    const result = await runVersionUpgrade(projectRoot, yggRoot, platform);
    s.stop('Upgrade complete.');

    for (const action of result.migrationActions) {
      p.log.info(action);
    }
    for (const warning of result.migrationWarnings) {
      p.log.warning(warning);
    }

    const landedVersion = (await detectVersion(yggRoot)) ?? currentVersion;
    p.log.step('Next steps:');
    p.log.info('1. Run yg check to verify graph integrity');
    p.log.info('2. Run yg check --approve to record verdicts for the graph');
    p.outro(
      chalk.green(
        `Migrated from ${currentVersion} to ${landedVersion}. Rules installed: ${toPosixPath(path.relative(projectRoot, result.rulesPath))}`,
      ),
    );
    return;
  }

  const action = await p.select<string>({
    message: 'What would you like to do?',
    options: [
      { value: 'upgrade', label: 'Upgrade rules' },
      { value: 'reviewer', label: 'Configure reviewer' },
      { value: 'platform', label: 'Change platform' },
    ],
  });
  assertNotCancelled(action);

  switch (action) {
    case 'upgrade': {
      const platform = await promptPlatform();
      const result = await runVersionUpgrade(projectRoot, yggRoot, platform);
      p.outro(chalk.green(`Rules refreshed: ${toPosixPath(path.relative(projectRoot, result.rulesPath))}`));
      break;
    }
    case 'reviewer': {
      const reviewerConfig = await runReviewerConfigFlow();
      await writeReviewerConfig(yggRoot, reviewerConfig);
      if (reviewerConfig.apiKey) {
        await writeSecretsFile(yggRoot, reviewerConfig.apiKey);
      }
      p.outro(chalk.green('Reviewer configured.'));
      break;
    }
    case 'platform': {
      const platform = await promptPlatform();
      const rulesPath = await installRulesForPlatform(projectRoot, platform);
      p.outro(chalk.green(`Platform changed: ${toPosixPath(path.relative(projectRoot, rulesPath))}`));
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

export function registerInitCommand(program: Command): void {
  program
    .command('init')
    .description('Initialize Yggdrasil graph in current project')
    .option('--upgrade', 'Non-interactive: refresh rules')
    .option('--platform <name>', `Platform for rules file (${PLATFORMS.join(', ')})`)
    .action(async (options: { upgrade?: boolean; platform?: string }) => {
      try {
        const projectRoot = process.cwd();
        const yggRoot = path.join(projectRoot, '.yggdrasil');

        // Non-interactive upgrade: --upgrade --platform <name>
        if (options.upgrade) {
          if (!options.platform) {
            process.stderr.write(
              chalk.red(
                `Error: ${buildIssueMessage({
                  what: '--upgrade requires --platform.',
                  why: 'yg init --upgrade must know which platform rules to regenerate after migration.',
                  next: `Pass --platform <name>. Supported: ${PLATFORMS.join(', ')}.`,
                })}\n`,
              ),
            );
            process.exit(1);
          }
          if (!PLATFORMS.includes(options.platform as Platform)) {
            process.stderr.write(
              chalk.red(
                `Error: ${buildIssueMessage({
                  what: `Unknown platform '${options.platform}'.`,
                  why: 'The --platform value must match one of the supported agent platforms.',
                  next: `Use one of: ${PLATFORMS.join(', ')}`,
                })}\n`,
              ),
            );
            process.exit(1);
          }
          try {
            await stat(yggRoot);
          } catch (e: unknown) {
            debugWrite(`[init] upgrade: .yggdrasil not found: ${e instanceof Error ? e.message : String(e)}`);
            process.stderr.write(
              chalk.red(
                `Error: ${buildIssueMessage({
                  what: 'No .yggdrasil/ directory found in the current project.',
                  why: '`yg init --upgrade` operates on an existing graph; the bootstrap form (without --upgrade) creates one.',
                  next: "Run 'yg init' to bootstrap a fresh graph, then re-run --upgrade.",
                })}\n`,
              ),
            );
            process.exit(1);
          }

          const currentVersion = await detectVersion(yggRoot);
          if (currentVersion === null) {
            process.stderr.write(chalk.red(`Error: ${buildIssueMessage({
              what: 'No graph version detected.',
              why: ".yggdrasil/yg-config.yaml is missing a 'version:' field, so --upgrade cannot determine which migrations to run.",
              next: "Run 'yg init' interactively once to record the current version, then retry 'yg init --upgrade --platform <name>'.",
            })}\n`));
            process.exit(1);
          }
          const result = await runVersionUpgrade(
            projectRoot,
            yggRoot,
            options.platform as Platform,
          );

          // A migration that WITHHELD the version bump (bumpVersion: false)
          // leaves yg-config.yaml at its prior version — an INCOMPLETE upgrade.
          // The interactive path surfaces this; the non-interactive flag path
          // (agents/CI) must signal it too, not report a false success. A
          // COMPLETED upgrade that merely emitted informational warnings still
          // succeeds (exit 0) but surfaces them rather than swallowing them.
          if (result.withheld) {
            process.stderr.write(
              chalk.red(
                `Error: ${buildIssueMessage({
                  what:
                    'Migration withheld — the version bump was NOT applied.\n' +
                    result.migrationWarnings.map((w) => `  - ${w}`).join('\n'),
                  why: 'A migration step could not be safely applied, so the chain stopped and yg-config.yaml was left at its prior version. Reporting success here would hide an incomplete upgrade from agents and CI.',
                  next: 'Fix the listed configuration problems, then re-run yg init --upgrade --platform <name>.',
                })}\n`,
              ),
            );
            process.exit(1);
          }

          if (result.migrationWarnings.length > 0) {
            process.stdout.write(
              chalk.yellow(
                'Migration warnings:\n' +
                  result.migrationWarnings.map((w) => `  - ${w}`).join('\n') +
                  '\n',
              ),
            );
          }

          process.stdout.write(
            `Rules refreshed: ${toPosixPath(path.relative(projectRoot, result.rulesPath))}\n`,
          );
          return;
        }

        // Check if .yggdrasil/ already exists
        let exists = false;
        try {
          const statResult = await stat(yggRoot);
          if (!statResult.isDirectory()) {
            process.stderr.write(
              chalk.red(
                `Error: ${buildIssueMessage({
                  what: '.yggdrasil exists at the project root but is not a directory.',
                  why: 'yg init requires the .yggdrasil path to be a directory it can populate.',
                  next: 'Inspect the path manually; remove or rename the conflicting file, then re-run yg init.',
                })}\n`,
              ),
            );
            process.exit(1);
          }
          exists = true;
        } catch (e: unknown) {
          debugWrite(`[init] .yggdrasil stat: ${e instanceof Error ? e.message : String(e)}`);
          // Directory does not exist
        }

        if (exists) {
          await existingInit(projectRoot);
        } else {
          await freshInit(projectRoot);
        }
      } catch (err) {
        debugWrite(`[init] command failed: ${err instanceof Error ? err.message : String(err)}`);
        abortOnUnexpectedError(err, 'running init');
      }
    });
}
