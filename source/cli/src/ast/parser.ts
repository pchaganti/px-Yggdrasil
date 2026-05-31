import { Parser, Language, Tree } from 'web-tree-sitter';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { getGrammarForExtension } from '../core/graph/language-registry.js';

const _require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Candidate grammar dirs, in order. The published package bundles entry files FLAT
// (dist/bin.js, dist/ast.js …), so the WASM at dist/grammars/ is `__dirname/grammars`.
// `../grammars` covers a legacy dist/ast/ subdir layout and the src/ast/ dev tree.
const GRAMMAR_DIRS = [
  path.resolve(__dirname, 'grammars'),
  path.resolve(__dirname, '..', 'grammars'),
];

let initialized = false;
const langCache = new Map<string, Language>();

async function init(): Promise<void> {
  if (initialized) return;
  await Parser.init();
  initialized = true;
}

function resolveWasm(filename: string, pkg: string): string {
  // Published package: the WASM ships under dist/grammars/.
  for (const dir of GRAMMAR_DIRS) {
    const p = path.join(dir, filename);
    if (existsSync(p)) return p;
  }
  // Dev fallback: resolve from the installed grammar package. This is a devDep, so it
  // is ABSENT in a published install — the dist/grammars path above must succeed there.
  // Wrapped so an absent devDep yields a clean error, not a raw 'Cannot find module'.
  try {
    const pkgDir = path.dirname(_require.resolve(`${pkg}/package.json`));
    for (const candidate of [path.join(pkgDir, filename), path.join(pkgDir, 'bindings/node', filename)]) {
      if (existsSync(candidate)) return candidate;
    }
  } catch {
    /* devDep not installed (published package) — fall through to the error below */
  }
  throw new Error(`Could not find WASM grammar ${filename} in dist/grammars/ or in the ${pkg} package.`);
}

export async function getParser(extension: string): Promise<Parser> {
  await init();
  const info = getGrammarForExtension(extension);
  if (!info) {
    throw new Error(`no parser for extension '${extension}'`);
  }
  const cacheKey = info.wasmFile;
  let lang = langCache.get(cacheKey);
  if (!lang) {
    const wasmPath = resolveWasm(info.wasmFile, info.wasmPackage);
    lang = await Language.load(wasmPath);
    langCache.set(cacheKey, lang);
  }
  const parser = new Parser();
  parser.setLanguage(lang);
  return parser;
}

export async function parseFile(filePath: string, content: string): Promise<Tree> {
  const ext = path.extname(filePath);
  const parser = await getParser(ext);
  const tree = parser.parse(content);
  if (tree === null) {
    throw new Error(`tree-sitter failed to parse file: ${filePath}`);
  }
  return tree;
}
