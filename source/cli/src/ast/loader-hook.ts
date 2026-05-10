import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let registered = false;

export function ensureLoaderRegistered(): void {
  if (registered) return;
  // In production: dist/ast/loader-hook.js → dist/ast/loader-hook-impl.js
  // In tests: src/ast/loader-hook.ts → need dist version (built separately)
  const implPath = path.resolve(__dirname, './loader-hook-impl.js');
  register(pathToFileURL(implPath));
  registered = true;
}
