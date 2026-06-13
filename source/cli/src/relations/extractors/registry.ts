import type { DependencyExtractor } from './types.js';
import { typescriptExtractor } from './typescript.js';
import { pythonExtractor } from './python.js';
import { goExtractor } from './go.js';
import { javaExtractor } from './java.js';
import { phpExtractor } from './php.js';
import { kotlinExtractor } from './kotlin.js';
import { rustExtractor } from './rust.js';

const EXTRACTORS: DependencyExtractor[] = [
  typescriptExtractor, // TS / TSX / JS (Phase 1)
  pythonExtractor, // Python (Phase 2)
  goExtractor, // Go (Phase 3)
  javaExtractor, // Java (Phase 4)
  phpExtractor, // PHP (Phase 5)
  kotlinExtractor, // Kotlin (Phase 6) — resolves via the shared SymbolTable, not a path mapping
  rustExtractor, // Rust (Phase 7) — resolves via the crate module tree (crate::/super::/self::)
];

const byLanguage = new Map<string, DependencyExtractor>();
for (const e of EXTRACTORS) for (const lang of e.languages) byLanguage.set(lang, e);

export function extractorForLanguage(language: string): DependencyExtractor | undefined {
  return byLanguage.get(language);
}
