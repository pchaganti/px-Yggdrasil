import { pathToFileURL } from 'node:url';

export async function resolve(
  specifier: string,
  context: unknown,
  nextResolve: (specifier: string, context: unknown) => Promise<{ url: string; shortCircuit?: boolean }>
): Promise<{ url: string; shortCircuit?: boolean }> {
  if (specifier.startsWith('@chrisdudek/yg/')) {
    // Redirect to the CLI's own dist/ — works whether or not the adopter has the package installed.
    // Use import.meta.resolve so the exports map is honoured (CJS require.resolve does not
    // understand ESM-only export conditions).
    const target = import.meta.resolve(specifier);
    return { url: target, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
