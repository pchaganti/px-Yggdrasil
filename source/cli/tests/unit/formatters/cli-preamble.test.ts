import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadGraphOrAbort } from '../../../src/formatters/cli-preamble.js';

describe('loadGraphOrAbort', () => {
  let dir: string;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cli-preamble-'));
    exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(((_code?: number) => {
        throw new Error('__exit__');
      }) as never);
    errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    errSpy.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns the loaded graph when .yggdrasil/ exists and is valid', async () => {
    const ygg = join(dir, '.yggdrasil');
    mkdirSync(join(ygg, 'model'), { recursive: true });
    writeFileSync(
      join(ygg, 'yg-config.yaml'),
      `schemaVersion: "4.3.0"\nproject:\n  name: t\n`,
    );
    writeFileSync(join(ygg, 'yg-architecture.yaml'), 'node_types: {}\n');

    const graph = await loadGraphOrAbort(dir, { tolerateInvalidConfig: true });
    expect(graph).toBeDefined();
    expect(graph.rootPath.endsWith('.yggdrasil')).toBe(true);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('exits 1 with structured what/why/next when .yggdrasil/ is absent', async () => {
    await expect(loadGraphOrAbort(dir)).rejects.toThrow('__exit__');
    expect(exitSpy).toHaveBeenCalledWith(1);
    const written = errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
    expect(written).toContain('No .yggdrasil/ directory found');
    expect(written).toContain("'yg init'");
  });

  it('rethrows non-ENOENT errors so callers can decide', async () => {
    const ygg = join(dir, '.yggdrasil');
    mkdirSync(ygg, { recursive: true });
    // model/ directory missing but .yggdrasil/ exists — loader emits "does not exist"
    // which loadGraphOrAbort treats as missing-graph and exits 1. To get a true
    // pass-through error we point at a syntactically broken yg-config and disable
    // tolerateInvalidConfig.
    mkdirSync(join(ygg, 'model'));
    writeFileSync(join(ygg, 'yg-config.yaml'), 'this is :: not valid yaml :::');

    // Loader rejects bad config when tolerateInvalidConfig is false.
    // The error is not ENOENT-shaped, so loadGraphOrAbort should rethrow.
    await expect(loadGraphOrAbort(dir, { tolerateInvalidConfig: false })).rejects.toThrow();
    expect(exitSpy).not.toHaveBeenCalled();
  });
});
