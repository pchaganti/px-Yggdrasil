import { report, inFile } from '@chrisdudek/yg/ast';

// Every parser-adapter file that invokes parseYaml() (or yaml.parse) must
// include Array.isArray(raw) in the immediately-following shape guard.
// Rationale: typeof [] === 'object', so without an explicit Array.isArray
// check a YAML array document slips past the guard and fails later at the
// first property access. Empty-document tolerance varies per parser and is
// out of scope — only the array exclusion is required.
export function check(ctx) {
  const violations = [];
  for (const file of ctx.files) {
    if (!file.ast) continue;
    if (!inFile(file, { glob: '**/src/io/*-parser.ts' })) continue;

    const text = file.ast.rootNode.text;
    // Only parsers that actually call YAML parse need the guard.
    if (!/\bparseYaml\s*\(|\byaml\.parse\s*\(/.test(text)) continue;

    // The canonical guard inspects `raw` (the local name used by every
    // current parser). Require Array.isArray(raw) to appear somewhere in
    // the file. A coarse text check is sufficient — the guard is deliberately
    // distinctive and would not occur incidentally.
    if (!/\bArray\.isArray\s*\(\s*raw\s*\)/.test(text)) {
      violations.push(
        report(
          file,
          file.ast.rootNode,
          "missing Array.isArray(raw) in top-level shape guard — parsers must reject YAML array documents to avoid typeof-bypass bugs (typeof [] === 'object')",
        ),
      );
    }
  }
  return violations;
}
