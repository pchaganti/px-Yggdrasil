import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';

// Derived once from this module's own URL — safe in the loader worker thread where
// import.meta.url is available but import.meta.resolve is not (Node 20).
const selfDir = path.dirname(fileURLToPath(import.meta.url));

export async function resolve(
  specifier: string,
  context: unknown,
  nextResolve: (specifier: string, context: unknown) => Promise<{ url: string; shortCircuit?: boolean }>
): Promise<{ url: string; shortCircuit?: boolean }> {
  if (specifier.startsWith('@chrisdudek/yg/')) {
    // Redirect to the CLI's own dist/ — works whether or not the adopter has the package installed.
    // Resolved relative to this module (dist/loader-hook-impl.js) so it maps
    // @chrisdudek/yg/ast → dist/ast.js, @chrisdudek/yg/foo → dist/foo.js, etc.
    const exportName = specifier.slice('@chrisdudek/yg/'.length);
    const target = pathToFileURL(path.join(selfDir, `${exportName}.js`)).href;
    return { url: target, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
