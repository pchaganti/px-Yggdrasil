import { Command } from 'commander';
import chalk from 'chalk';
import { existsSync } from 'node:fs';
import { mkdir, writeFile, readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as p from '@clack/prompts';
import { parse as yamlParse, stringify as yamlStringify } from 'yaml';
import { DEFAULT_CONFIG, DEFAULT_ARCHITECTURE } from '../templates/default-config.js';
import { installRulesForPlatform, PLATFORMS, type Platform } from '../templates/platform.js';
import { fetchAnthropicModels, fetchOpenAIModels, fetchGoogleModels, fetchOllamaModels } from '../llm/model-fetcher.js';
import { testApiProvider, testCliProvider } from '../llm/reviewer-test.js';
import type { ReviewerProvider } from '../model/graph.js';
import { detectVersion } from '../core/migrator.js';
import { runVersionUpgrade as coreRunVersionUpgrade } from '../core/migrator-runner.js';
import { MIGRATIONS } from '../migrations/index.js';
import { buildIssueMessage } from '../formatters/message-builder.js';
import { debugWrite } from '../utils/debug-log.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getPackageRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  while (dir !== path.dirname(dir)) {
    if (existsSync(path.join(dir, 'package.json'))) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  throw new Error('Could not locate package root (no package.json found walking up from init module).');
}

function getGraphSchemasDir(): string {
  return path.join(getPackageRoot(), 'graph-schemas');
}

async function getCliVersion(): Promise<string> {
  const pkgPath = path.join(getPackageRoot(), 'package.json');
  const pkg = JSON.parse(await readFile(pkgPath, 'utf-8'));
  return pkg.version;
}

async function refreshSchemas(yggRoot: string): Promise<void> {
  const schemasDir = path.join(yggRoot, 'schemas');
  await mkdir(schemasDir, { recursive: true });
  const graphSchemasDir = getGraphSchemasDir();
  try {
    const entries = await readdir(graphSchemasDir, { withFileTypes: true });
    const schemaFiles = entries.filter((e) => e.isFile()).map((e) => e.name);
    for (const file of schemaFiles) {
      const srcPath = path.join(graphSchemasDir, file);
      const content = await readFile(srcPath, 'utf-8');
      await writeFile(path.join(schemasDir, file), content, 'utf-8');
    }
  } catch (e: unknown) {
    debugWrite(`[init] refreshSchemas schema copy failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function isTTY(): boolean {
  return process.stdout.isTTY === true && process.stdin.isTTY === true;
}

function assertNotCancelled<T>(value: T | symbol): asserts value is T {
  if (p.isCancel(value)) {
    p.cancel('Operation cancelled.');
    process.exit(0);
  }
}

const GITIGNORE_CONTENT = `yg-secrets.yaml
`;

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

function needsApiKey(provider: ReviewerProvider): boolean {
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

async function writeReviewerConfig(
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
    debugWrite(`[init] writeReviewerConfig: ${configPath} not found, starting fresh`);
  }

  // Build reviewer section with visible defaults
  const providerConfig: Record<string, unknown> = { model: config.model };
  if (config.endpoint) {
    providerConfig.endpoint = config.endpoint;
  }
  if (API_PROVIDERS.includes(config.provider)) {
    providerConfig.temperature = 0;
  }

  const reviewer: Record<string, unknown> = {
    consensus: 1,
    [config.provider]: providerConfig,
  };

  raw.reviewer = reviewer;

  await writeFile(configPath, yamlStringify(raw), 'utf-8');
}

// ---------------------------------------------------------------------------
// Write API key to yg-secrets.yaml
// ---------------------------------------------------------------------------

async function writeSecretsFile(
  yggRoot: string,
  provider: ReviewerProvider,
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
    debugWrite(`[init] writeSecretsFile: ${secretsPath} not found, starting fresh`);
  }

  if (!raw.reviewer || typeof raw.reviewer !== 'object') {
    raw.reviewer = {};
  }
  const reviewerSection = raw.reviewer as Record<string, unknown>;

  if (!reviewerSection[provider] || typeof reviewerSection[provider] !== 'object') {
    reviewerSection[provider] = {};
  }
  (reviewerSection[provider] as Record<string, unknown>).api_key = apiKey;

  await writeFile(secretsPath, yamlStringify(raw), { encoding: 'utf-8', mode: 0o600 });
}

// ---------------------------------------------------------------------------
// Fresh init
// ---------------------------------------------------------------------------

async function freshInit(projectRoot: string): Promise<void> {
  const yggRoot = path.join(projectRoot, '.yggdrasil');

  if (!isTTY()) {
    process.stderr.write(chalk.red(buildIssueMessage({
      what: 'yg init requires an interactive terminal.',
      why: 'Setup requires interactive prompts to configure platform and reviewer.',
      next: 'Run yg init in an interactive terminal session.',
    }) + '\n'));
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
    'The reviewer checks your source code against aspect rules during yg approve.\n' +
    '  API providers make HTTP calls. CLI providers delegate to an installed agent.\n' +
    '  For local review without API costs, use Ollama.',
  );
  const reviewerConfig = await runReviewerConfigFlow();

  // 3. Create structure + write config
  await createYggdrasilStructure(projectRoot, yggRoot, platform);

  await writeReviewerConfig(yggRoot, reviewerConfig);
  if (reviewerConfig.apiKey) {
    await writeSecretsFile(yggRoot, reviewerConfig.provider, reviewerConfig.apiKey);
  }

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
  const schemasDir = path.join(yggRoot, 'schemas');
  await mkdir(schemasDir, { recursive: true });

  const graphSchemasDir = getGraphSchemasDir();
  try {
    const entries = await readdir(graphSchemasDir, { withFileTypes: true });
    const schemaFiles = entries.filter((e) => e.isFile()).map((e) => e.name);
    for (const file of schemaFiles) {
      const srcPath = path.join(graphSchemasDir, file);
      const content = await readFile(srcPath, 'utf-8');
      await writeFile(path.join(schemasDir, file), content, 'utf-8');
    }
  } catch (err) {
    debugWrite(`[init] createYggdrasilStructure schema copy failed: ${err instanceof Error ? err.message : String(err)}`);
    process.stderr.write(
      chalk.yellow(`Warning: Could not copy graph schemas: ${(err as Error).message}\n`),
    );
  }

  await writeFile(path.join(yggRoot, 'yg-config.yaml'), DEFAULT_CONFIG, 'utf-8');
  await writeFile(path.join(yggRoot, 'yg-architecture.yaml'), DEFAULT_ARCHITECTURE, 'utf-8');
  await writeFile(path.join(yggRoot, '.gitignore'), GITIGNORE_CONTENT, 'utf-8');
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
}

export async function runVersionUpgrade(
  projectRoot: string,
  yggRoot: string,
  fromVersion: string,
  toVersion: string,
  platform: Platform,
): Promise<VersionUpgradeResult> {
  const { migrationActions, migrationWarnings } = await coreRunVersionUpgrade({
    yggRoot, fromVersion, toVersion, migrations: MIGRATIONS,
  });

  await refreshSchemas(yggRoot);

  const architecturePath = path.join(yggRoot, 'yg-architecture.yaml');
  try {
    await stat(architecturePath);
  } catch (e: unknown) {
    debugWrite(`[init] runVersionUpgrade architecture file missing, writing default: ${e instanceof Error ? e.message : String(e)}`);
    await writeFile(architecturePath, DEFAULT_ARCHITECTURE, 'utf-8');
  }

  const rulesPath = await installRulesForPlatform(projectRoot, platform);

  return { rulesPath, migrationActions, migrationWarnings };
}

// ---------------------------------------------------------------------------
// Existing repo menu
// ---------------------------------------------------------------------------

async function existingInit(projectRoot: string): Promise<void> {
  const yggRoot = path.join(projectRoot, '.yggdrasil');

  if (!isTTY()) {
    process.stderr.write(chalk.yellow(buildIssueMessage({
      what: '.yggdrasil/ already exists.',
      why: 'Re-configuration requires interactive prompts which are not available in non-TTY mode.',
      next: 'Run yg init interactively in a terminal to reconfigure.',
    }) + '\n'));
    return;
  }

  p.intro(chalk.bold('Yggdrasil Configuration'));

  // Check for pending migrations
  const currentVersion = await detectVersion(yggRoot);
  const cliVersion = await getCliVersion();

  if (currentVersion && currentVersion !== cliVersion) {
    p.log.step(`Graph version ${currentVersion} detected — CLI is ${cliVersion}. Upgrade required.`);
    p.log.info('Select the agent platform so rules and schemas advance together.');
    const platform = await promptPlatform();

    const s = p.spinner();
    s.start('Running migrations and installing rules...');
    const result = await runVersionUpgrade(projectRoot, yggRoot, currentVersion, cliVersion, platform);
    s.stop('Upgrade complete.');

    for (const action of result.migrationActions) {
      p.log.info(action);
    }
    for (const warning of result.migrationWarnings) {
      p.log.warning(warning);
    }

    p.log.step('Next steps:');
    p.log.info('1. Run yg check to verify graph integrity');
    p.log.info('2. Run yg approve on all nodes to establish baselines');
    p.outro(
      chalk.green(
        `Migrated from ${currentVersion} to ${cliVersion}. Rules installed: ${path.relative(projectRoot, result.rulesPath).replace(/\\/g, '/').replace(/\/+$/, '')}`,
      ),
    );
    return;
  }

  const action = await p.select<string>({
    message: 'What would you like to do?',
    options: [
      { value: 'upgrade', label: 'Upgrade rules and schemas' },
      { value: 'reviewer', label: 'Configure reviewer' },
      { value: 'platform', label: 'Change platform' },
    ],
  });
  assertNotCancelled(action);

  switch (action) {
    case 'upgrade': {
      const platform = await promptPlatform();
      const fromVersion = currentVersion ?? cliVersion;
      const result = await runVersionUpgrade(projectRoot, yggRoot, fromVersion, cliVersion, platform);
      p.outro(chalk.green(`Rules and schemas refreshed: ${path.relative(projectRoot, result.rulesPath).replace(/\\/g, '/').replace(/\/+$/, '')}`));
      break;
    }
    case 'reviewer': {
      const reviewerConfig = await runReviewerConfigFlow();
      await writeReviewerConfig(yggRoot, reviewerConfig);
      if (reviewerConfig.apiKey) {
        await writeSecretsFile(yggRoot, reviewerConfig.provider, reviewerConfig.apiKey);
      }
      p.outro(chalk.green('Reviewer configured.'));
      break;
    }
    case 'platform': {
      const platform = await promptPlatform();
      const rulesPath = await installRulesForPlatform(projectRoot, platform);
      p.outro(chalk.green(`Platform changed: ${path.relative(projectRoot, rulesPath).replace(/\\/g, '/').replace(/\/+$/, '')}`));
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
    .option('--upgrade', 'Non-interactive: refresh rules and schemas')
    .option('--platform <name>', `Platform for rules file (${PLATFORMS.join(', ')})`)
    .action(async (options: { upgrade?: boolean; platform?: string }) => {
      try {
        const projectRoot = process.cwd();
        const yggRoot = path.join(projectRoot, '.yggdrasil');

        // Non-interactive upgrade: --upgrade --platform <name>
        if (options.upgrade) {
          if (!options.platform) {
            process.stderr.write(chalk.red('Error: --upgrade requires --platform.\n'));
            process.exit(1);
          }
          if (!PLATFORMS.includes(options.platform as Platform)) {
            process.stderr.write(chalk.red(`Error: Unknown platform '${options.platform}'. Valid: ${PLATFORMS.join(', ')}\n`));
            process.exit(1);
          }
          try {
            await stat(yggRoot);
          } catch (e: unknown) {
            debugWrite(`[init] upgrade: .yggdrasil not found: ${e instanceof Error ? e.message : String(e)}`);
            process.stderr.write(chalk.red('Error: No .yggdrasil/ directory found. Run \'yg init\' first.\n'));
            process.exit(1);
          }

          const toVersion = await getCliVersion();
          const fromVersion = await detectVersion(yggRoot);
          if (fromVersion === null) {
            process.stderr.write(chalk.red(buildIssueMessage({
              what: 'No graph version detected.',
              why: ".yggdrasil/yg-config.yaml is missing a 'version:' field, so --upgrade cannot determine which migrations to run.",
              next: "Run 'yg init' interactively once to record the current version, then retry 'yg init --upgrade --platform <name>'.",
            }) + '\n'));
            process.exit(1);
          }
          const result = await runVersionUpgrade(
            projectRoot,
            yggRoot,
            fromVersion,
            toVersion,
            options.platform as Platform,
          );
          process.stdout.write(
            `Rules and schemas refreshed: ${path.relative(projectRoot, result.rulesPath).replace(/\\/g, '/').replace(/\/+$/, '')}\n`,
          );
          return;
        }

        // Check if .yggdrasil/ already exists
        let exists = false;
        try {
          const statResult = await stat(yggRoot);
          if (!statResult.isDirectory()) {
            process.stderr.write(chalk.red('Error: .yggdrasil exists but is not a directory.\n'));
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
        process.stderr.write(chalk.red(`Error: ${(err as Error).message}\n`));
        process.exit(1);
      }
    });
}
