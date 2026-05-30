import { describe, it, expect, vi, afterEach } from 'vitest';
import { Command } from 'commander';
import { registerApproveCommand, runBatch } from '../../../src/cli/approve.js';
import type { LlmApproveResult } from '../../../src/cli/approve.js';

// ── Harness ───────────────────────────────────────────────────
//
// Drives the registered `yg approve` action with a controlled process.exit
// and captured stderr/stdout. process.exit is stubbed to throw a sentinel so
// the action's `try` body stops at the first exit (mirroring the real abort),
// and the registered catch in the action treats it as expected (the sentinel
// carries the code and is re-thrown out of parseAsync by commander's
// exitOverride? — we instead assert on the captured code directly).

class ExitSignal extends Error {
  constructor(public code: number) {
    super(`process.exit(${code})`);
  }
}

async function runApprove(argv: string[]): Promise<{ code: number | undefined; out: string }> {
  const chunks: string[] = [];
  const origStdout = process.stdout.write.bind(process.stdout);
  const origStderr = process.stderr.write.bind(process.stderr);
  const origExit = process.exit;
  let captured: number | undefined;

  process.stdout.write = (chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
    return true;
  };
  process.stderr.write = (chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
    return true;
  };
  // Stub process.exit to record the first code and abort the action body.
  process.exit = ((code?: number) => {
    if (captured === undefined) captured = code ?? 0;
    throw new ExitSignal(code ?? 0);
  }) as typeof process.exit;

  const program = new Command();
  program.exitOverride();
  registerApproveCommand(program);

  try {
    await program.parseAsync(['node', 'yg', 'approve', ...argv]);
  } catch (err) {
    // The ExitSignal thrown by our stubbed exit is caught by the action's
    // try/catch and routed to abortOnUnexpectedError, which itself calls
    // process.exit → throws another ExitSignal that escapes parseAsync. Either
    // way the FIRST captured code is the one we asserted the guard set.
    if (!(err instanceof ExitSignal)) {
      throw err;
    }
  } finally {
    process.stdout.write = origStdout;
    process.stderr.write = origStderr;
    process.exit = origExit;
  }
  return { code: captured, out: chunks.join('') };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('yg approve — --dry-run guard for batch targets (BUG 1)', () => {
  it('rejects --dry-run with --aspect: exits 1 with a structured message', async () => {
    const { code, out } = await runApprove(['--dry-run', '--aspect', 'x']);
    expect(code).toBe(1);
    expect(out).toContain('dry-run');
    expect(out).toContain('only supported with --node');
  });

  it('rejects --dry-run with --flow: exits 1 with a structured message', async () => {
    const { code, out } = await runApprove(['--dry-run', '--flow', 'y']);
    expect(code).toBe(1);
    expect(out).toContain('dry-run');
    expect(out).toContain('only supported with --node');
  });
});

// ── BUG 4: runBatch isolates a worker that throws ─────────────

describe('runBatch — worker throw isolation (BUG 4)', () => {
  it('reports every node even when one approveOne throws; thrown node is refused', async () => {
    const approveOne = vi.fn(async (nodePath: string): Promise<LlmApproveResult> => {
      if (nodePath === 'b') {
        throw new Error('disk on fire');
      }
      return { action: 'approved', currentHash: 'h' };
    });

    const results = await runBatch(['a', 'b', 'c'], 1, approveOne);

    // All three nodes represented, in input order.
    expect(results.map(r => r.nodePath)).toEqual(['a', 'b', 'c']);
    // The thrown node is rendered as a failure (refused).
    const b = results.find(r => r.nodePath === 'b')!;
    expect(b.result.action).toBe('refused');
    // The error message is surfaced somewhere in the synthetic result.
    expect(JSON.stringify(b.result)).toContain('disk on fire');
    // The other nodes succeeded.
    expect(results.find(r => r.nodePath === 'a')!.result.action).toBe('approved');
    expect(results.find(r => r.nodePath === 'c')!.result.action).toBe('approved');
    // Every node ran exactly once.
    expect(approveOne).toHaveBeenCalledTimes(3);
  });

  it('isolates a throw under concurrency > 1', async () => {
    const approveOne = vi.fn(async (nodePath: string): Promise<LlmApproveResult> => {
      if (nodePath === 'x') throw new Error('boom');
      return { action: 'approved', currentHash: 'h' };
    });
    const results = await runBatch(['w', 'x', 'y', 'z'], 3, approveOne);
    expect(results.map(r => r.nodePath).sort()).toEqual(['w', 'x', 'y', 'z']);
    expect(results.find(r => r.nodePath === 'x')!.result.action).toBe('refused');
    const failed = results.filter(r => r.result.action === 'refused');
    expect(failed).toHaveLength(1);
  });
});
