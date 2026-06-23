import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';

// The check command must route EVERY terminal exit through exitAfterFlush — which
// drains stdout and force-exits via an unref'd 2s backstop — so a lingering libuv
// handle left by the LLM provider (an undici keep-alive socket, an AbortSignal
// timer) can never hang a CLEAN `--approve`. Before the fix the success path fell
// through to a bare `return`, relying on the event loop draining; with a dangling
// handle that never happens and the process hangs after the report is printed.
//
// These tests pin the control flow in-process: a clean --approve calls
// exitAfterFlush(0); an --approve with errors calls exitAfterFlush(1). The real
// exitAfterFlush is covered by exit-after-flush.test.ts; here it is mocked to
// process.exit so the requested code surfaces.

vi.mock('../../../src/cli/preamble.js', () => ({
  loadGraphOrAbort: vi.fn(),
  abortOnUnexpectedError: vi.fn(),
}));
vi.mock('../../../src/utils/debug-log.js', () => ({
  initDebugLog: vi.fn(),
  debugWrite: vi.fn(),
}));
vi.mock('../../../src/io/debug-log-writer.js', () => ({ appendToDebugLog: vi.fn() }));
vi.mock('../../../src/core/check.js', () => ({ runCheck: vi.fn() }));

vi.mock('../../../src/core/fill.js', () => ({
  runFill: vi.fn(),
  FillGatingError: class FillGatingError extends Error {},
}));
vi.mock('../../../src/cli/exit-after-flush.js', () => ({
  exitAfterFlush: vi.fn((code: number) => process.exit(code)),
}));

import { registerCheckCommand } from '../../../src/cli/check.js';
import { loadGraphOrAbort } from '../../../src/cli/preamble.js';
import { runFill } from '../../../src/core/fill.js';
import { exitAfterFlush } from '../../../src/cli/exit-after-flush.js';
import type { CheckIssue, CheckResult } from '../../../src/core/check.js';

const mockLoadGraph = vi.mocked(loadGraphOrAbort);
const mockRunFill = vi.mocked(runFill);
const mockExitAfterFlush = vi.mocked(exitAfterFlush);

class ExitSignal extends Error {
  constructor(public readonly code: number) {
    super(`exit:${code}`);
  }
}

function makeCheckResult(issues: CheckIssue[]): CheckResult {
  return {
    projectName: 'p',
    nodeCount: 1,
    nodeTypeCounts: new Map(),
    aspectCount: 0,
    flowCount: 0,
    coveredFiles: 0,
    totalFiles: 0,
    issues,
    suggestedNext: null,
    advisoryWarnings: 0,
    draftSkipped: 0,
  };
}

const ERROR_ISSUE: CheckIssue = {
  severity: 'error',
  code: 'unverified',
  rule: 'unverified',
  messageData: { what: 'x', why: 'y', next: 'z' },
};

describe('check --approve always force-exits via exitAfterFlush', () => {
  let exitCode: number | undefined;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    exitCode = undefined;
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      exitCode = code ?? 0;
      throw new ExitSignal(exitCode);
    }) as never);
    mockLoadGraph.mockReset();
    mockRunFill.mockReset();
    mockExitAfterFlush.mockClear();
    mockExitAfterFlush.mockImplementation(((code: number) => process.exit(code)) as never);
    // dirname is a non-existent path so collectGitFiles' `git ls-files` fails fast → null.
    mockLoadGraph.mockResolvedValue({ rootPath: '/nonexistent-yg-test/.yggdrasil', config: {} } as never);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    stdoutSpy.mockRestore();
  });

  async function runApprove(issues: CheckIssue[]): Promise<void> {
    mockRunFill.mockResolvedValue({
      checkResult: makeCheckResult(issues),
      reviewerCallsMade: 0,
      infraFailures: 0,
      runtimeErrors: 0,
      companionRuntimeErrors: 0,
    });
    const program = new Command();
    program.exitOverride();
    registerCheckCommand(program);
    try {
      await program.parseAsync(['node', 'yg', 'check', '--approve']);
    } catch (e) {
      if (!(e instanceof ExitSignal)) throw e;
    }
  }

  it('a CLEAN --approve (no errors) force-exits via exitAfterFlush(0) — never relies on event-loop drain', async () => {
    await runApprove([]);
    expect(mockExitAfterFlush).toHaveBeenCalledWith(0);
    expect(exitCode).toBe(0);
  });

  it('an --approve with errors force-exits via exitAfterFlush(1)', async () => {
    await runApprove([ERROR_ISSUE]);
    expect(mockExitAfterFlush).toHaveBeenCalledWith(1);
    expect(exitCode).toBe(1);
  });
});
