import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';

// Mock the graph preamble so the command never touches the real filesystem.
// loadGraphOrAbort returns whatever graph we stage per-test; abortOnUnexpectedError
// is kept real-ish (we don't expect it on the happy paths under test).
vi.mock('../../../src/formatters/cli-preamble.js', () => ({
  loadGraphOrAbort: vi.fn(),
  abortOnUnexpectedError: vi.fn(),
}));

// Mock both deterministic runners so we control violations / non-determinism
// without authoring real check.mjs fixtures. This is the unit-level companion to
// the integration suite: it drives the merged command's branch logic directly.
vi.mock('../../../src/ast/runner.js', () => ({ runAstAspect: vi.fn() }));
vi.mock('../../../src/structure/runner.js', () => ({ runStructureAspect: vi.fn() }));

import { registerDeterministicTestCommand } from '../../../src/cli/deterministic-test.js';
import { loadGraphOrAbort } from '../../../src/formatters/cli-preamble.js';
import { runAstAspect } from '../../../src/ast/runner.js';
import { runStructureAspect } from '../../../src/structure/runner.js';

const mockLoadGraph = vi.mocked(loadGraphOrAbort);
const mockRunAst = vi.mocked(runAstAspect);
const mockRunStructure = vi.mocked(runStructureAspect);

// A minimal graph: an aspects array + a nodes Map are all the command consults.
// Cast through unknown — the command only reads .aspects and .nodes.get().
function makeGraph(opts: {
  aspects: Array<{ id: string; reviewer: { type: string } }>;
  nodes?: Array<[string, { path: string; meta: Record<string, unknown> }]>;
}): unknown {
  return {
    aspects: opts.aspects,
    nodes: new Map(opts.nodes ?? []),
  };
}

describe('registerDeterministicTestCommand', () => {
  function findCommand(program: Command, name: string) {
    return program.commands.find((c) => c.name() === name);
  }

  it('registers a deterministic-test command', () => {
    const program = new Command();
    registerDeterministicTestCommand(program);
    const cmd = findCommand(program, 'deterministic-test');
    expect(cmd).toBeDefined();
  });

  it('exposes --aspect, --node, --files, and --check-determinism options', () => {
    const program = new Command();
    registerDeterministicTestCommand(program);
    const cmd = findCommand(program, 'deterministic-test')!;
    const flags = cmd.options.map((o) => o.long);
    expect(flags).toContain('--aspect');
    expect(flags).toContain('--node');
    expect(flags).toContain('--files');
    expect(flags).toContain('--check-determinism');
  });

  it('requires the --aspect option', () => {
    const program = new Command();
    registerDeterministicTestCommand(program);
    const cmd = findCommand(program, 'deterministic-test')!;
    const aspectOpt = cmd.options.find((o) => o.long === '--aspect');
    expect(aspectOpt?.required).toBe(true);
  });
});

describe('deterministic-test command behavior (mocked runners)', () => {
  let stdout: string;
  let stderr: string;
  let exitCode: number | undefined;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  // Run the merged command's action by parsing argv. parseAsync resolves once the
  // async action settles. We stub process.exit to throw so the action's
  // `process.exit(1); return;` unwinds immediately (commander's exitOverride only
  // covers commander's own exits, not our action's).
  class ExitSignal extends Error {
    constructor(public readonly code: number) {
      super(`exit:${code}`);
    }
  }

  async function runCommand(argv: string[]): Promise<void> {
    const program = new Command();
    program.exitOverride();
    registerDeterministicTestCommand(program);
    try {
      await program.parseAsync(['node', 'yg', 'deterministic-test', ...argv]);
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
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('errors and exits 1 when the aspect is not found (message mentions yg deterministic-test)', async () => {
    mockLoadGraph.mockResolvedValue(makeGraph({ aspects: [] }) as never);
    await runCommand(['--aspect', 'missing', '--node', 'N']);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("'missing' not found");
    expect(stderr).toContain('yg deterministic-test');
  });

  it('errors and exits 1 when the aspect reviewer is not deterministic (llm)', async () => {
    mockLoadGraph.mockResolvedValue(
      makeGraph({ aspects: [{ id: 'a', reviewer: { type: 'llm' } }] }) as never,
    );
    await runCommand(['--aspect', 'a', '--node', 'N']);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("not 'deterministic'");
  });

  it('errors and exits 1 when neither --node nor --files is provided', async () => {
    mockLoadGraph.mockResolvedValue(
      makeGraph({ aspects: [{ id: 'a', reviewer: { type: 'deterministic' } }] }) as never,
    );
    await runCommand(['--aspect', 'a']);
    expect(exitCode).toBe(1);
    expect(stderr).toContain('Neither --node nor --files');
  });

  it('errors and exits 1 when BOTH --node and --files are provided', async () => {
    mockLoadGraph.mockResolvedValue(
      makeGraph({ aspects: [{ id: 'a', reviewer: { type: 'deterministic' } }] }) as never,
    );
    await runCommand(['--aspect', 'a', '--node', 'N', '--files', 'src/a.ts']);
    expect(exitCode).toBe(1);
    expect(stderr).toContain('Both --node and --files');
  });

  it('--node: errors and exits 1 when the node is unknown', async () => {
    mockLoadGraph.mockResolvedValue(
      makeGraph({ aspects: [{ id: 'a', reviewer: { type: 'deterministic' } }] }) as never,
    );
    await runCommand(['--aspect', 'a', '--node', 'missing/node']);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Node 'missing/node' not found");
  });

  it('--node happy path: routes runStructureAspect; clean prints "No violations."', async () => {
    mockLoadGraph.mockResolvedValue(
      makeGraph({
        aspects: [{ id: 'a', reviewer: { type: 'deterministic' } }],
        nodes: [['N', { path: 'N', meta: {} }]],
      }) as never,
    );
    mockRunStructure.mockResolvedValue({ violations: [], touchedFiles: [] } as never);
    await runCommand(['--aspect', 'a', '--node', 'N']);
    expect(mockRunStructure).toHaveBeenCalledTimes(1);
    expect(mockRunAst).not.toHaveBeenCalled();
    expect(exitCode).toBeUndefined();
    expect(stdout).toContain('No violations.');
  });

  it('--node violations: prints graph-level <graph>: and file-grouped L<line>, exits 1', async () => {
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
    } as never);
    await runCommand(['--aspect', 'a', '--node', 'N']);
    expect(exitCode).toBe(1);
    expect(stdout).toContain('<graph>: graph problem');
    expect(stdout).toContain('src/a.ts');
    expect(stdout).toContain('L3: file problem');
  });

  it('--files happy path: routes runAstAspect; clean prints "No violations."', async () => {
    mockLoadGraph.mockResolvedValue(
      makeGraph({ aspects: [{ id: 'a', reviewer: { type: 'deterministic' } }] }) as never,
    );
    mockRunAst.mockResolvedValue({ violations: [] } as never);
    await runCommand(['--aspect', 'a', '--files', 'src/a.ts']);
    expect(mockRunAst).toHaveBeenCalledTimes(1);
    expect(mockRunStructure).not.toHaveBeenCalled();
    expect(exitCode).toBeUndefined();
    expect(stdout).toContain('No violations.');
  });

  it('--files violations: prints file-grouped L<line>, exits 1', async () => {
    mockLoadGraph.mockResolvedValue(
      makeGraph({ aspects: [{ id: 'a', reviewer: { type: 'deterministic' } }] }) as never,
    );
    mockRunAst.mockResolvedValue({
      violations: [{ message: 'sync fs', file: 'src/a.ts', line: 2 }],
    } as never);
    await runCommand(['--aspect', 'a', '--files', 'src/a.ts']);
    expect(exitCode).toBe(1);
    expect(stdout).toContain('src/a.ts');
    expect(stdout).toContain('L2: sync fs');
  });

  it('--node --check-determinism: stable across runs prints "No violations."', async () => {
    mockLoadGraph.mockResolvedValue(
      makeGraph({
        aspects: [{ id: 'a', reviewer: { type: 'deterministic' } }],
        nodes: [['N', { path: 'N', meta: {} }]],
      }) as never,
    );
    mockRunStructure.mockResolvedValue({ violations: [], touchedFiles: [] } as never);
    await runCommand(['--aspect', 'a', '--node', 'N', '--check-determinism']);
    expect(mockRunStructure).toHaveBeenCalledTimes(2);
    expect(exitCode).toBeUndefined();
    expect(stdout).toContain('No violations.');
  });

  it('--node --check-determinism: mismatch dumps Run 1/Run 2 and exits 1', async () => {
    mockLoadGraph.mockResolvedValue(
      makeGraph({
        aspects: [{ id: 'a', reviewer: { type: 'deterministic' } }],
        nodes: [['N', { path: 'N', meta: {} }]],
      }) as never,
    );
    mockRunStructure
      .mockResolvedValueOnce({ violations: [{ message: 'first only' }], touchedFiles: [] } as never)
      .mockResolvedValueOnce({ violations: [], touchedFiles: [] } as never);
    await runCommand(['--aspect', 'a', '--node', 'N', '--check-determinism']);
    expect(exitCode).toBe(1);
    expect(stderr).toContain('non-deterministic');
    expect(stderr).toContain('Run 1:');
    expect(stderr).toContain('Run 2:');
  });

  it('--files --check-determinism: stable across runs exits 0', async () => {
    mockLoadGraph.mockResolvedValue(
      makeGraph({ aspects: [{ id: 'a', reviewer: { type: 'deterministic' } }] }) as never,
    );
    mockRunAst.mockResolvedValue({ violations: [] } as never);
    await runCommand(['--aspect', 'a', '--files', 'src/a.ts', '--check-determinism']);
    expect(mockRunAst).toHaveBeenCalledTimes(2);
    expect(exitCode).toBeUndefined();
    expect(stdout).toContain('No violations.');
  });

  it('--files --check-determinism: mismatch drives writeNonDeterministicError (Run 1/Run 2) and exits 1', async () => {
    mockLoadGraph.mockResolvedValue(
      makeGraph({ aspects: [{ id: 'a', reviewer: { type: 'deterministic' } }] }) as never,
    );
    mockRunAst
      .mockResolvedValueOnce({
        violations: [{ message: 'flaky', file: 'src/a.ts', line: 1 }],
      } as never)
      .mockResolvedValueOnce({ violations: [] } as never);
    await runCommand(['--aspect', 'a', '--files', 'src/a.ts', '--check-determinism']);
    expect(exitCode).toBe(1);
    expect(stderr).toContain('non-deterministic');
    expect(stderr).toContain('Run 1:');
    expect(stderr).toContain('Run 2:');
  });
});
