import { Parser, Language, Tree } from 'web-tree-sitter';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

const _require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Production: dist/ast/../grammars; Dev (tests): src/ast/../grammars (may not exist)
const GRAMMARS_DIR = path.resolve(__dirname, '../grammars');

let initialized = false;
const langCache = new Map<string, Language>();

async function init(): Promise<void> {
  if (initialized) return;
  await Parser.init();
  initialized = true;
}

function resolveWasm(filename: string, pkg: string): string {
  // Production: check dist/grammars/ first
  const distPath = path.join(GRAMMARS_DIR, filename);
  if (existsSync(distPath)) return distPath;
  // Dev fallback: resolve from installed node_modules package
  const pkgDir = path.dirname(_require.resolve(`${pkg}/package.json`));
  const candidates = [
    path.join(pkgDir, filename),
    path.join(pkgDir, 'bindings/node', filename),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`Could not find WASM file ${filename} in dist/grammars/ or ${pkg}`);
}

function wasmFileFor(ext: string): { file: string; pkg: string } | null {
  const lower = ext.toLowerCase();
  if (lower === '.ts') return { file: 'tree-sitter-typescript.wasm', pkg: 'tree-sitter-typescript' };
  if (lower === '.tsx') return { file: 'tree-sitter-tsx.wasm', pkg: 'tree-sitter-typescript' };
  if (lower === '.js' || lower === '.mjs' || lower === '.cjs' || lower === '.jsx') {
    return { file: 'tree-sitter-javascript.wasm', pkg: 'tree-sitter-javascript' };
  }
  return null;
}

export async function getParser(extension: string): Promise<Parser> {
  await init();
  const info = wasmFileFor(extension);
  if (!info) {
    throw new Error(`no parser for extension '${extension}'`);
  }
  const cacheKey = info.file;
  let lang = langCache.get(cacheKey);
  if (!lang) {
    const wasmPath = resolveWasm(info.file, info.pkg);
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
