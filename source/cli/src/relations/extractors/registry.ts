import type { DependencyExtractor } from './types.js';
import { typescriptExtractor } from './typescript.js';
import { pythonExtractor } from './python.js';

const EXTRACTORS: DependencyExtractor[] = [
  typescriptExtractor, // TS / TSX / JS (Phase 1)
  pythonExtractor, // Python (Phase 2)
];

const byLanguage = new Map<string, DependencyExtractor>();
for (const e of EXTRACTORS) for (const lang of e.languages) byLanguage.set(lang, e);

export function extractorForLanguage(language: string): DependencyExtractor | undefined {
  return byLanguage.get(language);
}
