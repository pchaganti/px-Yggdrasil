import { walk, report, inFile } from '@chrisdudek/yg/ast';

// Raw write functions from node:fs/promises that persistence adapters must not call directly
const RAW_WRITE_FNS = new Set(['writeFile', 'appendFile', 'writeFileSync', 'appendFileSync', 'createWriteStream']);

const FS_MODULES = new Set(['node:fs', 'node:fs/promises', 'fs', 'fs/promises']);

export function check(ctx) {
  const violations = [];
  for (const file of ctx.files) {
    // atomic-write.ts itself is the implementation — exempt
    if (inFile(file, { glob: '**/atomic-write.ts' })) continue;
    // debug-log-writer.ts uses append semantics, not atomic-write semantics — exempt
    if (inFile(file, { glob: '**/debug-log-writer.ts' })) continue;
    // graph-fs.ts is the low-level fs facade layer — exempt (wraps raw fs for other adapters)
    if (inFile(file, { glob: '**/graph-fs.ts' })) continue;
    // Only check persistence-adapter files (src/io/)
    if (!inFile(file, { glob: '**/src/io/*.ts' })) continue;

    // Collect names imported from node:fs or node:fs/promises
    const fsImports = new Set();
    walk(file.ast.rootNode, (node) => {
      if (node.type !== 'import_statement') return;
      const sourceNode = node.childForFieldName('source');
      if (!sourceNode) return;
      const source = sourceNode.text.slice(1, -1);
      if (!FS_MODULES.has(source)) return;
      // Walk named imports to collect imported specifiers
      for (const child of node.children) {
        if (child.type !== 'import_clause') continue;
        for (const clause of child.children) {
          if (clause.type !== 'named_imports') continue;
          for (const specifier of clause.children) {
            if (specifier.type !== 'import_specifier') continue;
            const id = specifier.children.find((c) => c.type === 'identifier');
            if (id && RAW_WRITE_FNS.has(id.text)) {
              fsImports.add(id.text);
            }
          }
        }
      }
    });

    if (fsImports.size === 0) continue;

    // Check if any of the imported write functions are actually called
    walk(file.ast.rootNode, (node) => {
      if (node.type !== 'call_expression') return;
      const fn = node.childForFieldName('function');
      if (!fn) return;
      const name = fn.text;
      if (fsImports.has(name)) {
        violations.push(
          report(
            file,
            node,
            `raw fs write call '${name}()' — persistence adapters must use atomicWriteFile() from io/atomic-write instead`,
          ),
        );
      }
    });
  }
  return violations;
}
