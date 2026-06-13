import { ensureLoaderRegistered } from '../../../../src/ast/loader-hook.js';
import { parseFile } from '../../../../src/ast/parser.js';
import type { DependencyExtractor, ParsedFile } from '../../../../src/relations/extractors/types.js';

export async function runExtractor(
  ex: DependencyExtractor,
  language: string,
  ext: string,
  code: string,
): Promise<{
  declarations: ReturnType<DependencyExtractor['declarations']>;
  uses: ReturnType<DependencyExtractor['uses']>;
}> {
  ensureLoaderRegistered();
  const p = `x${ext}`;
  const tree = await parseFile(p, code);
  const file: ParsedFile = { path: p, content: code, tree, language };
  return { declarations: ex.declarations(file), uses: ex.uses(file) };
}
