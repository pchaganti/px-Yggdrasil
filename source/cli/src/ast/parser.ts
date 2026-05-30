import { Parser, Language, Tree } from 'web-tree-sitter';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { getGrammarForExtension } from '../core/graph/language-registry.js';

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
