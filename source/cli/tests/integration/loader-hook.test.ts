import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('loader-hook', () => {
  it('resolve redirects @chrisdudek/yg/ast to CLI dist', async () => {
    const implPath = path.resolve(__dirname, '../../dist/loader-hook-impl.js');

    if (!existsSync(implPath)) {
      console.warn('loader-hook-impl.js not built, skipping');
      return;
    }

    const { resolve } = await import(pathToFileURL(implPath).href);

    let nextCalled = false;
    const nextResolve = async (spec: string) => {
      nextCalled = true;
      return { url: `file:///mock/${spec}`, shortCircuit: false };
    };

    // Test: @chrisdudek/yg/ast specifier gets redirected
    const result = await resolve('@chrisdudek/yg/ast', {}, nextResolve);
    expect(result.shortCircuit).toBe(true);
    expect(result.url).toContain('ast');
    expect(nextCalled).toBe(false);
  });

  it('resolve passes through non-@chrisdudek specifiers', async () => {
    const implPath = path.resolve(__dirname, '../../dist/loader-hook-impl.js');

    if (!existsSync(implPath)) {
      console.warn('loader-hook-impl.js not built, skipping');
      return;
    }

    const { resolve } = await import(pathToFileURL(implPath).href);

    let nextCalled = false;
    const nextResolve = async (spec: string) => {
      nextCalled = true;
      return { url: `file:///mock/${spec}`, shortCircuit: false };
    };

    const result = await resolve('minimatch', {}, nextResolve);
    expect(nextCalled).toBe(true);
    expect(result.url).toBe('file:///mock/minimatch');
  });

  it('ensureLoaderRegistered export exists and is a function', async () => {
    // Import the source module to verify the export shape
    // We only verify the export exists — calling register() in tests has side effects
    const { ensureLoaderRegistered } = await import(
      '../../src/ast/loader-hook.js'
    );
    expect(typeof ensureLoaderRegistered).toBe('function');
  });
});
