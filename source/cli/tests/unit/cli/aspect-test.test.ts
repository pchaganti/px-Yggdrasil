import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, mkdir, rm, access } from 'node:fs/promises';

// Mock the graph preamble so the command never touches the real filesystem for
// graph loading. loadGraphOrAbort returns whatever graph we stage per-test.
vi.mock('../../../src/cli/preamble.js', () => ({
  loadGraphOrAbort: vi.fn(),
  abortOnUnexpectedError: vi.fn(),
}));

// Mock both deterministic runners so we control violations / non-determinism
// without authoring real check.mjs fixtures.
vi.mock('../../../src/ast/runner.js', () => ({ runAstAspect: vi.fn() }));
vi.mock('../../../src/structure/runner.js', () => ({ runStructureAspect: vi.fn() }));

// Mock the LLM provider factory (no real reviewer).
vi.mock('../../../src/llm/index.js', () => ({
  createLlmProvider: vi.fn(),
}));

// Mock computeExpectedPairs so we can control LLM pair sets.
vi.mock('../../../src/core/pairs.js', () => ({
  computeExpectedPairs: vi.fn(),
}));

// Mock readTextFile for references.
vi.mock('../../../src/io/graph-fs.js', () => ({
  readTextFile: vi.fn(),
}));

// Mock the yg-secrets overlay loader (no local overlay during the test).
vi.mock('../../../src/io/secrets-parser.js', () => ({
  loadConfigOverlay: vi.fn().mockResolvedValue(undefined),
  deepMerge: vi.fn((base: Record<string, unknown>, overlay: Record<string, unknown>) => ({ ...base, ...overlay })),
}));

import { registerAspectTestCommand } from '../../../src/cli/aspect-test.js';
import { loadGraphOrAbort } from '../../../src/cli/preamble.js';
import { runAstAspect } from '../../../src/ast/runner.js';
import { runStructureAspect } from '../../../src/structure/runner.js';
import { createLlmProvider } from '../../../src/llm/index.js';
import { computeExpectedPairs } from '../../../src/core/pairs.js';
import type { LlmProvider } from '../../../src/llm/types.js';

const mockLoadGraph = vi.mocked(loadGraphOrAbort);
const mockRunAst = vi.mocked(runAstAspect);
const mockRunStructure = vi.mocked(runStructureAspect);
const mockCreateLlmProvider = vi.mocked(createLlmProvider);
const mockComputeExpectedPairs = vi.mocked(computeExpectedPairs);

// A minimal graph: aspects array + nodes Map are all the command consults.
function makeGraph(opts: {
  aspects: Array<{ id: string; reviewer: { type: string; tier?: string }; scope?: { per: string }; description?: string; artifacts?: Array<{ filename: string; content: string }>; references?: unknown[] }>;
  nodes?: Array<[string, { path: string; meta: Record<string, unknown> }]>;
  config?: { reviewer?: { tiers: Record<string, { provider: string; consensus: number; config: Record<string, unknown> }> } };
}): unknown {
  return {
    aspects: opts.aspects.map((a) => ({
      id: a.id,
      reviewer: a.reviewer,
      scope: a.scope,
      description: a.description ?? `${a.id} description`,
      artifacts: a.artifacts ?? [{ filename: a.reviewer.type === 'llm' ? 'content.md' : 'check.mjs', content: 'rule body' }],
      references: a.references ?? [],
    })),
    nodes: new Map(opts.nodes ?? []),
    config: opts.config ?? { reviewer: { tiers: { standard: { provider: 'ollama', consensus: 1, config: { model: 'llama3', temperature: 0 } } } } },
    rootPath: '/fake/.yggdrasil',
  };
}

function makeMockProvider(overrides: Partial<LlmProvider> = {}): LlmProvider {
  return {
    verifyAspect: async () => ({ satisfied: true, reason: 'looks good', errorSource: 'codeViolation' as const }),
    isAvailable: async () => true,
    ...overrides,
  };
}

describe('registerAspectTestCommand', () => {
  function findCommand(program: Command, name: string) {
    return program.commands.find((c) => c.name() === name);
  }

  it('registers an aspect-test command (not deterministic-test)', () => {
    const program = new Command();
    registerAspectTestCommand(program);
    expect(findCommand(program, 'aspect-test')).toBeDefined();
    expect(findCommand(program, 'deterministic-test')).toBeUndefined();
  });

  it('exposes --aspect, --node, --files, --check-determinism, and --dry-run options', () => {
    const program = new Command();
    registerAspectTestCommand(program);
    const cmd = findCommand(program, 'aspect-test')!;
    const flags = cmd.options.map((o) => o.long);
    expect(flags).toContain('--aspect');
    expect(flags).toContain('--node');
    expect(flags).toContain('--files');
    expect(flags).toContain('--check-determinism');
    expect(flags).toContain('--dry-run');
  });

  it('requires the --aspect option', () => {
    const program = new Command();
    registerAspectTestCommand(program);
    const cmd = findCommand(program, 'aspect-test')!;
    const aspectOpt = cmd.options.find((o) => o.long === '--aspect');
    expect(aspectOpt?.required).toBe(true);
  });
});

describe('aspect-test command behavior (mocked runners)', () => {
  let stdout: string;
  let stderr: string;
  let exitCode: number | undefined;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  class ExitSignal extends Error {
    constructor(public readonly code: number) {
      super(`exit:${code}`);
    }
  }

  async function runCommand(argv: string[]): Promise<void> {
    const program = new Command();
    program.exitOverride();
    registerAspectTestCommand(program);
    try {
      await program.parseAsync(['node', 'yg', 'aspect-test', ...argv]);
    } catch (e) {
      if (!(e instanceof ExitSignal)) throw e;
    }
  }

  beforeEach(() => {
    stdout = '';
    stderr = '';
    exitCode = undefined;
    stdoutSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: string | Uint8Array) => {
        stdout += chunk.toString();
        return true;
      });
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk: string | Uint8Array) => {
        stderr += chunk.toString();
        return true;
      });
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      exitCode = code ?? 0;
      throw new ExitSignal(exitCode);
    }) as never);
    mockRunAst.mockReset();
    mockRunStructure.mockReset();
    mockLoadGraph.mockReset();
    mockCreateLlmProvider.mockReset();
    mockComputeExpectedPairs.mockReset();
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    exitSpy.mockRestore();
  });

  // ── Error: aspect not found ──────────────────────────────────────────────────
  it('errors and exits 1 when the aspect is not found', async () => {
    mockLoadGraph.mockResolvedValue(makeGraph({ aspects: [] }) as never);
    await runCommand(['--aspect', 'missing', '--node', 'N']);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("'missing' not found");
  });

  // ── Deterministic: --node routes to structure runner ─────────────────────────
  it('det --node happy path: routes runStructureAspect; clean prints footer', async () => {
    mockLoadGraph.mockResolvedValue(
      makeGraph({
        aspects: [{ id: 'a', reviewer: { type: 'deterministic' } }],
        nodes: [['N', { path: 'N', meta: {} }]],
      }) as never,
    );
    mockRunStructure.mockResolvedValue({ violations: [], touchedFiles: [], observations: [] } as never);
    await runCommand(['--aspect', 'a', '--node', 'N']);
    expect(mockRunStructure).toHaveBeenCalledTimes(1);
    expect(mockRunAst).not.toHaveBeenCalled();
    expect(exitCode).toBeUndefined();
    expect(stdout).toContain('No violations.');
    expect(stdout).toContain('diagnostic only — lock unchanged');
  });

  // ── Deterministic: --files routes to AST runner ──────────────────────────────
  it('det --files happy path: routes runAstAspect; clean prints footer', async () => {
    mockLoadGraph.mockResolvedValue(
      makeGraph({ aspects: [{ id: 'a', reviewer: { type: 'deterministic' } }] }) as never,
    );
    mockRunAst.mockResolvedValue({ violations: [] } as never);
    await runCommand(['--aspect', 'a', '--files', 'src/a.ts']);
    expect(mockRunAst).toHaveBeenCalledTimes(1);
    expect(mockRunStructure).not.toHaveBeenCalled();
    expect(exitCode).toBeUndefined();
    expect(stdout).toContain('No violations.');
    expect(stdout).toContain('diagnostic only — lock unchanged');
  });

  // ── Deterministic: violations print correctly ────────────────────────────────
  it('det --node violations: prints <graph>: and file-grouped L<line>, exits 1, footer present', async () => {
    mockLoadGraph.mockResolvedValue(
      makeGraph({
        aspects: [{ id: 'a', reviewer: { type: 'deterministic' } }],
        nodes: [['N', { path: 'N', meta: {} }]],
      }) as never,
    );
    mockRunStructure.mockResolvedValue({
      violations: [
        { message: 'graph problem' },
        { message: 'file problem', file: 'src/a.ts', line: 3 },
      ],
      touchedFiles: [],
      observations: [],
    } as never);
    await runCommand(['--aspect', 'a', '--node', 'N']);
    expect(exitCode).toBe(1);
    expect(stdout).toContain('<graph>: graph problem');
    expect(stdout).toContain('L3: file problem');
    expect(stdout).toContain('diagnostic only — lock unchanged');
  });

  // ── Deterministic: neither --node nor --files ────────────────────────────────
  it('det: errors and exits 1 when neither --node nor --files is provided', async () => {
    mockLoadGraph.mockResolvedValue(
      makeGraph({ aspects: [{ id: 'a', reviewer: { type: 'deterministic' } }] }) as never,
    );
    await runCommand(['--aspect', 'a']);
    expect(exitCode).toBe(1);
    expect(stderr).toContain('Neither --node nor --files');
  });

  // ── Deterministic: both --node and --files ───────────────────────────────────
  it('det: errors and exits 1 when both --node and --files are provided', async () => {
    mockLoadGraph.mockResolvedValue(
      makeGraph({ aspects: [{ id: 'a', reviewer: { type: 'deterministic' } }] }) as never,
    );
    await runCommand(['--aspect', 'a', '--node', 'N', '--files', 'src/a.ts']);
    expect(exitCode).toBe(1);
    expect(stderr).toContain('Both --node and --files');
  });

  // ── Deterministic: --check-determinism intact ────────────────────────────────
  it('det --check-determinism: stable across runs prints "No violations." + footer', async () => {
    mockLoadGraph.mockResolvedValue(
      makeGraph({
        aspects: [{ id: 'a', reviewer: { type: 'deterministic' } }],
        nodes: [['N', { path: 'N', meta: {} }]],
      }) as never,
    );
    mockRunStructure.mockResolvedValue({ violations: [], touchedFiles: [], observations: [] } as never);
    await runCommand(['--aspect', 'a', '--node', 'N', '--check-determinism']);
    expect(mockRunStructure).toHaveBeenCalledTimes(2);
    expect(exitCode).toBeUndefined();
    expect(stdout).toContain('No violations.');
    expect(stdout).toContain('diagnostic only — lock unchanged');
  });

  it('det --check-determinism: mismatch dumps Run 1/Run 2, exits 1, footer present', async () => {
    mockLoadGraph.mockResolvedValue(
      makeGraph({
        aspects: [{ id: 'a', reviewer: { type: 'deterministic' } }],
        nodes: [['N', { path: 'N', meta: {} }]],
      }) as never,
    );
    mockRunStructure
      .mockResolvedValueOnce({ violations: [{ message: 'first only' }], touchedFiles: [], observations: [] } as never)
      .mockResolvedValueOnce({ violations: [], touchedFiles: [], observations: [] } as never);
    await runCommand(['--aspect', 'a', '--node', 'N', '--check-determinism']);
    expect(exitCode).toBe(1);
    expect(stderr).toContain('non-deterministic');
    expect(stderr).toContain('Run 1:');
    expect(stderr).toContain('Run 2:');
    expect(stdout).toContain('diagnostic only — lock unchanged');
  });

  // ── Deterministic: --dry-run errors ─────────────────────────────────────────
  it('det --dry-run errors with a clear message that deterministic checks run locally', async () => {
    mockLoadGraph.mockResolvedValue(
      makeGraph({ aspects: [{ id: 'a', reviewer: { type: 'deterministic' } }] }) as never,
    );
    await runCommand(['--aspect', 'a', '--node', 'N', '--dry-run']);
    expect(exitCode).toBe(1);
    expect(stderr).toContain('--dry-run is not supported for deterministic aspect');
    expect(stderr).toContain('locally');
  });

  // ── LLM: happy path prints verdict + makes provider calls ───────────────────
  it('LLM happy path: prints verdict per pair and makes provider calls', async () => {
    const nodeEntry = { path: 'N', meta: { type: 'service', description: 'node desc' } };
    mockLoadGraph.mockResolvedValue(
      makeGraph({
        aspects: [{ id: 'llm-a', reviewer: { type: 'llm' } }],
        nodes: [['N', nodeEntry]],
      }) as never,
    );
    mockComputeExpectedPairs.mockResolvedValue({
      pairs: [{ aspectId: 'llm-a', kind: 'llm' as const, unitKey: 'node:N', nodePath: 'N', status: 'enforced' as const, subjectFiles: [] }],
      unreadable: [],
    });
    let verifyCalls = 0;
    mockCreateLlmProvider.mockReturnValue(makeMockProvider({
      async verifyAspect() {
        verifyCalls++;
        return { satisfied: true, reason: 'all good', errorSource: 'codeViolation' as const };
      },
    }));
    await runCommand(['--aspect', 'llm-a', '--node', 'N']);
    expect(verifyCalls).toBeGreaterThan(0);
    expect(stdout).toContain('satisfied');
    expect(stdout).toContain('diagnostic only — lock unchanged');
    expect(exitCode).toBeUndefined();
  });

  // ── LLM: --dry-run prints prompt, ZERO provider calls ───────────────────────
  it('LLM --dry-run: prints prompt to stdout, makes ZERO provider calls', async () => {
    const nodeEntry = { path: 'N', meta: { type: 'service', description: 'node desc' } };
    mockLoadGraph.mockResolvedValue(
      makeGraph({
        aspects: [{ id: 'llm-a', reviewer: { type: 'llm' }, artifacts: [{ filename: 'content.md', content: 'my rule body' }] }],
        nodes: [['N', nodeEntry]],
      }) as never,
    );
    mockComputeExpectedPairs.mockResolvedValue({
      pairs: [{ aspectId: 'llm-a', kind: 'llm' as const, unitKey: 'node:N', nodePath: 'N', status: 'enforced' as const, subjectFiles: [] }],
      unreadable: [],
    });
    let verifyCalls = 0;
    mockCreateLlmProvider.mockReturnValue(makeMockProvider({
      async verifyAspect() { verifyCalls++; return { satisfied: true, reason: 'ok', errorSource: 'codeViolation' as const }; },
    }));
    await runCommand(['--aspect', 'llm-a', '--node', 'N', '--dry-run']);
    expect(verifyCalls).toBe(0);
    expect(stdout).toContain('=== prompt for node:N ===');
    expect(stdout).toContain('diagnostic only — lock unchanged');
    expect(exitCode).toBeUndefined();
  });

  // ── LLM: footer present on every output path (det, LLM, dry-run) ────────────
  it('footer is present after every successful det --files run', async () => {
    mockLoadGraph.mockResolvedValue(
      makeGraph({ aspects: [{ id: 'a', reviewer: { type: 'deterministic' } }] }) as never,
    );
    mockRunAst.mockResolvedValue({ violations: [] } as never);
    await runCommand(['--aspect', 'a', '--files', 'src/a.ts']);
    expect(stdout).toContain('diagnostic only — lock unchanged');
  });

  // ── LLM: --files errors ──────────────────────────────────────────────────────
  it('LLM + --files errors with a clear message', async () => {
    mockLoadGraph.mockResolvedValue(
      makeGraph({ aspects: [{ id: 'llm-a', reviewer: { type: 'llm' } }] }) as never,
    );
    await runCommand(['--aspect', 'llm-a', '--files', 'src/a.ts']);
    expect(exitCode).toBe(1);
    expect(stderr).toContain('LLM');
    expect(stderr).toContain('graph context');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Lock file isolation test: LLM run must NOT write yg-lock.json
// ─────────────────────────────────────────────────────────────────────────────

describe('aspect-test: lock file not written after LLM run', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
  });

  it('no yg-lock.json appears in a tmp fixture after an LLM dry-run', async () => {
    // Create a real but minimal temp project; use the already-mocked loadGraphOrAbort
    // to return a fake graph pointing into it. The lock must NOT be created.
    const root = await mkdtemp(path.join(tmpdir(), 'yg-aspect-test-lock-'));
    dirs.push(root);
    const yggRoot = path.join(root, '.yggdrasil');
    await mkdir(path.join(yggRoot, 'aspects', 'llm-x'), { recursive: true });

    const lockFile = path.join(yggRoot, 'yg-lock.json');

    // Use the already-mocked setup from the describe above — spies are fresh here.
    let stdout2 = '';
    const stdoutSpy2 = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stdout2 += chunk.toString(); return true;
    });
    const stderrSpy2 = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    let exitCode2: number | undefined;
    const exitSpy2 = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      exitCode2 = code ?? 0;
      throw new Error(`exit:${exitCode2}`);
    }) as never);

    const nodeEntry = { path: 'svc', meta: { type: 'service', description: '' } };
    mockLoadGraph.mockResolvedValue(
      makeGraph({
        aspects: [{ id: 'llm-x', reviewer: { type: 'llm' }, artifacts: [{ filename: 'content.md', content: 'rule' }] }],
        nodes: [['svc', nodeEntry]],
      }) as never,
    );
    mockComputeExpectedPairs.mockResolvedValue({
      pairs: [{ aspectId: 'llm-x', kind: 'llm' as const, unitKey: 'node:svc', nodePath: 'svc', status: 'enforced' as const, subjectFiles: [] }],
      unreadable: [],
    });
    mockCreateLlmProvider.mockReturnValue(makeMockProvider());

    const program = new Command();
    program.exitOverride();
    registerAspectTestCommand(program);
    try {
      await program.parseAsync(['node', 'yg', 'aspect-test', '--aspect', 'llm-x', '--node', 'svc', '--dry-run']);
    } catch { /* exit signal */ }

    stdoutSpy2.mockRestore();
    stderrSpy2.mockRestore();
    exitSpy2.mockRestore();

    // The lock file must NOT have been created.
    let lockExists = false;
    try {
      await access(lockFile);
      lockExists = true;
    } catch { /* expected */ }
    expect(lockExists).toBe(false);

    void exitCode2;
    void stdout2;
  });
});
