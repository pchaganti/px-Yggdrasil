import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { debugWrite } from './debug-log.js';

const execFileAsync = promisify(execFile);

/**
 * Probe whether a CLI binary can be run on this machine, cross-platform.
 *
 * The previous approach shelled out to `which <binary>`, but `which` is a
 * Unix-only command. On Windows there is no `which` (the equivalent is `where`),
 * so the probe failed to spawn `which` itself (ENOENT) and reported every CLI
 * provider as absent even when the binary was installed and resolvable — a false
 * negative on every Windows machine.
 *
 * Instead we run the binary directly with `--version` and treat a clean exit as
 * "available". This needs no platform-specific lookup tool. On Windows `shell`
 * is enabled so the OS resolves PATHEXT shims (e.g. a `claude.cmd` installed by
 * npm) that a bare process spawn cannot launch; the binary name is always a
 * fixed internal constant, never user input, so there is no shell-injection
 * surface. The probe also confirms the binary actually runs, which `which`
 * (a mere path lookup) never did.
 */
export async function binaryAvailable(binary: string): Promise<boolean> {
  try {
    await execFileAsync(binary, ['--version'], {
      timeout: 10_000,
      shell: process.platform === 'win32',
    });
    return true;
  } catch (err) {
    debugWrite(`[binary-check] ${binary} --version: ${(err as Error).message}`);
    return false;
  }
}
