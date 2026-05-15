import { ast } from '@chrisdudek/yg/ast';

// Raw write functions from node:fs/promises that persistence adapters must not call directly
const RAW_WRITE_FNS = new Set(['writeFile', 'appendFile', 'writeFileSync', 'appendFileSync', 'createWriteStream']);

export function check(ctx) {
  const violations = [];
  for (const file of ctx.files) {
    // atomic-write.ts itself is the implementation — exempt
    if (ast.inFile(file, '**/atomic-write.ts')) continue;
    // Only check persistence-adapter files (src/io/)
    if (!ast.inFile(file, 'src/io/*.ts')) continue;

    // Collect names imported from node:fs or node:fs/promises
    const fsImports = new Set();
    for (const imp of ast.imports(file.ast.rootNode)) {
      const src = imp.source;
      if (src === 'node:fs' || src === 'node:fs/promises' || src === 'fs' || src === 'fs/promises') {
        for (const spec of (imp.specifiers ?? [])) {
          if (spec.local && RAW_WRITE_FNS.has(spec.local)) {
            fsImports.add(spec.local);
          }
        }
      }
    }

    if (fsImports.size === 0) continue;

    // Check if any of the imported write functions are actually called
    for (const node of ast.within(file.ast.rootNode, 'call_expression', { crossFunctions: true })) {
      const fn = node.childForFieldName('function');
      if (!fn) continue;
      const name = fn.text;
      if (fsImports.has(name)) {
        violations.push(
          ast.report(
            file,
            node,
            `raw fs write call '${name}()' — persistence adapters must use atomicWriteFile() from io/atomic-write instead`,
          ),
        );
      }
    }
  }
  return violations;
}
