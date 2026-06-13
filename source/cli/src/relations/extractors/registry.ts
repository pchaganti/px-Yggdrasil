import type { DependencyExtractor } from './types.js';

const EXTRACTORS: DependencyExtractor[] = [
  // typescriptExtractor (Phase 1), pythonExtractor (Phase 2), ...
];

const byLanguage = new Map<string, DependencyExtractor>();
for (const e of EXTRACTORS) for (const lang of e.languages) byLanguage.set(lang, e);

export function extractorForLanguage(language: string): DependencyExtractor | undefined {
  return byLanguage.get(language);
}
