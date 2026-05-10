import { defineConfig } from 'tsup';
import { copyFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

async function copyWasmGrammars() {
  const grammarsDir = path.resolve('dist/grammars');
  await mkdir(grammarsDir, { recursive: true });

  const tsWasm = findWasm('tree-sitter-typescript', [
    'tree-sitter-typescript.wasm',
    'bindings/node/tree-sitter-typescript.wasm',
  ]);
  const tsxWasm = findWasm('tree-sitter-typescript', [
    'tree-sitter-tsx.wasm',
    'bindings/node/tree-sitter-tsx.wasm',
  ]);
  const jsWasm = findWasm('tree-sitter-javascript', [
    'tree-sitter-javascript.wasm',
    'bindings/node/tree-sitter-javascript.wasm',
  ]);

  await copyFile(tsWasm, path.join(grammarsDir, 'typescript.wasm'));
  await copyFile(tsxWasm, path.join(grammarsDir, 'tsx.wasm'));
  await copyFile(jsWasm, path.join(grammarsDir, 'javascript.wasm'));

  console.log('Copied WASM grammars to dist/grammars/');
}

function findWasm(pkg: string, candidates: string[]): string {
  const pkgDir = path.dirname(require.resolve(`${pkg}/package.json`));
  for (const candidate of candidates) {
    const p = path.join(pkgDir, candidate);
    if (existsSync(p)) return p;
  }
  throw new Error(
    `Could not find WASM file for ${pkg}. Tried: ${candidates.join(', ')}`
  );
}

export default defineConfig({
  entry: {
    bin: 'src/bin.ts',
    ast: 'src/ast/index.ts',
  },
  format: ['esm'],
  target: 'node22',
  outDir: 'dist',
  clean: true,
  dts: true,
  sourcemap: true,
  splitting: false,
  async onSuccess() {
    // Copy templates (existing behavior)
    const { execSync } = await import('node:child_process');
    execSync('node scripts/copy-templates.cjs', { stdio: 'inherit' });
    // Copy WASM grammars
    await copyWasmGrammars();
  },
});
