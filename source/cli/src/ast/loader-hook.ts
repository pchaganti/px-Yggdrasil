import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let registered = false;

export function ensureLoaderRegistered(): void {
  if (registered) return;
  // In production: dist/ast/loader-hook.js → dist/ast/loader-hook-impl.js
  // In tests: src/ast/loader-hook.ts → need dist version (built separately)
  let implPath = path.resolve(__dirname, './loader-hook-impl.js');
  /* v8 ignore next 1 */
  if (!existsSync(implPath)) {
    // Dev/test fallback: resolve from the package root via the dist/ output
    const pkgRoot = path.resolve(__dirname, '../../');
    implPath = path.resolve(pkgRoot, 'dist/loader-hook-impl.js');
  }
  register(pathToFileURL(implPath));
  registered = true;
}
