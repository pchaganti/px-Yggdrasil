import { defineConfig } from 'tsup';
import { copyFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// Every shipped grammar: which npm package provides the prebuilt WASM and the
// exact `.wasm` filename (matching language-registry.ts `wasmFile`, the name the
// parser resolves from dist/grammars/). Keep in sync with the registry — a parse
// smoke test per language in repo-check/CI fails the gate if a copy is missing.
const GRAMMARS: { pkg: string; wasm: string }[] = [
  { pkg: 'tree-sitter-typescript', wasm: 'tree-sitter-typescript.wasm' },
  { pkg: 'tree-sitter-typescript', wasm: 'tree-sitter-tsx.wasm' },
  { pkg: 'tree-sitter-javascript', wasm: 'tree-sitter-javascript.wasm' },
  { pkg: 'tree-sitter-python', wasm: 'tree-sitter-python.wasm' },
  { pkg: 'tree-sitter-go', wasm: 'tree-sitter-go.wasm' },
  { pkg: 'tree-sitter-rust', wasm: 'tree-sitter-rust.wasm' },
  { pkg: 'tree-sitter-java', wasm: 'tree-sitter-java.wasm' },
  { pkg: 'tree-sitter-c-sharp', wasm: 'tree-sitter-c_sharp.wasm' },
  { pkg: 'tree-sitter-c', wasm: 'tree-sitter-c.wasm' },
  { pkg: 'tree-sitter-cpp', wasm: 'tree-sitter-cpp.wasm' },
  { pkg: 'tree-sitter-php', wasm: 'tree-sitter-php_only.wasm' },
  { pkg: 'tree-sitter-ruby', wasm: 'tree-sitter-ruby.wasm' },
  { pkg: 'tree-sitter-json', wasm: 'tree-sitter-json.wasm' },
  { pkg: '@tree-sitter-grammars/tree-sitter-kotlin', wasm: 'tree-sitter-kotlin.wasm' },
  { pkg: '@tree-sitter-grammars/tree-sitter-yaml', wasm: 'tree-sitter-yaml.wasm' },
  { pkg: '@tree-sitter-grammars/tree-sitter-toml', wasm: 'tree-sitter-toml.wasm' },
];

async function copyWasmGrammars() {
  const grammarsDir = path.resolve('dist/grammars');
  await mkdir(grammarsDir, { recursive: true });

  // Copy each grammar under the name the parser actually resolves (the registry
  // `wasmFile`, e.g. `tree-sitter-<lang>.wasm`) — NOT a short `<lang>.wasm`. The
  // short names were never found in a published install (only the dev
  // `node_modules` fallback worked).
  for (const { pkg, wasm } of GRAMMARS) {
    const src = findWasm(pkg, [wasm, `bindings/node/${wasm}`]);
    await copyFile(src, path.join(grammarsDir, wasm));
  }

  console.log(`Copied ${GRAMMARS.length} WASM grammars to dist/grammars/`);
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
    structure: 'src/structure/index.ts',
    'loader-hook-impl': 'src/ast/loader-hook-impl.ts',
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
