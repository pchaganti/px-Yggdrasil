import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import type { LlmProvider, AspectResponse } from './types.js';
import { debugWrite } from '../utils/debug-log.js';

const execFileAsync = promisify(execFile);

function normalizeResponse(raw: unknown): AspectResponse {
  const r = raw as Record<string, unknown>;
  return {
    satisfied: typeof r.satisfied === 'boolean' ? r.satisfied : false,
    reason: typeof r.reason === 'string' ? r.reason : '',
    errorSource: 'codeViolation',
  };
}

export function parseAspectResponse(output: string): AspectResponse | undefined {
  const trimmed = output.trim();
  if (!trimmed) return undefined;

  // 1. Direct JSON
  try { return normalizeResponse(JSON.parse(trimmed)); } catch (err) { debugWrite(`[parseAspectResponse] direct JSON parse failed: ${(err as Error).message}`); }

  // 2. Markdown fence
  const fenceMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch) {
    try { return normalizeResponse(JSON.parse(fenceMatch[1].trim())); } catch (err) { debugWrite(`[parseAspectResponse] fence JSON parse failed: ${(err as Error).message}`); }
  }

  // 3. Embedded JSON object
  const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try { return normalizeResponse(JSON.parse(jsonMatch[0])); } catch (err) { debugWrite(`[parseAspectResponse] embedded JSON parse failed: ${(err as Error).message}`); }
  }

  // 4. Natural language fallback — conservative
  const lower = trimmed.toLowerCase();
  const hasSatisfied = lower.includes('satisfied') && !lower.includes('not satisfied');
  const hasExplicitYes = lower.includes('"satisfied": true') || lower.includes('"satisfied":true');
  const satisfied = hasExplicitYes || (hasSatisfied && !lower.includes('cannot') && !lower.includes('unable'));
  return { satisfied, reason: trimmed.slice(0, 200), errorSource: 'codeViolation' };
}

export abstract class CliAgentProvider implements LlmProvider {
  protected model: string;
  protected timeout: number;

  constructor(config: { model: string; timeout?: number }) {
    this.model = config.model;
    // Default 300s (was 120s). A large node's per-aspect prompt (many source
    // files + references) can take ~100-300s through a CLI provider; 120s was
    // tight enough that big-node reviews intermittently timed out as a spurious
    // "Reviewer unavailable". Keeping nodes small (node-size error) is the real
    // fix; this default just stops the boundary flakiness. Tunable via config.timeout.
    this.timeout = config.timeout ?? 300_000;
  }

  abstract get binary(): string;
  abstract buildArgs(prompt: string): string[];
  abstract get stdinMode(): boolean;

  async isAvailable(): Promise<boolean> {
    try {
      await execFileAsync('which', [this.binary], { timeout: 5000 });
      return true;
    } catch (err) {
      debugWrite(`[${this.binary}] isAvailable: ${(err as Error).message}`);
      return false;
    }
  }

  async getContextWindowSize(): Promise<number | undefined> {
    return undefined;
  }

  async verifyAspect(prompt: string): Promise<AspectResponse> {
    const fallback: AspectResponse = { satisfied: false, reason: 'Reviewer unavailable', errorSource: 'provider' };

    return new Promise((resolve) => {
      const args = this.stdinMode ? this.buildArgs('') : this.buildArgs(prompt);
      const child = spawn(this.binary, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: this.timeout,
        cwd: tmpdir(),
        env: { ...process.env },
      });

      let stdout = '';
      let stderr = '';
      let killed = false;

      const timer = setTimeout(() => {
        killed = true;
        debugWrite(`[${this.binary}] timeout after ${this.timeout}ms; stderr tail: ${stderr.slice(-500)}`);
        child.kill('SIGTERM');
      }, this.timeout);

      child.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
      // Drain stderr too. With stdio stderr piped but unread, a child that writes
      // more than the ~64KB pipe buffer blocks on its stderr write and never exits —
      // a deadlock that presents as a spurious timeout / "Reviewer unavailable" on
      // large prompts. Reading it keeps the pipe flowing and preserves diagnostics.
      child.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });
      child.on('error', (err) => {
        clearTimeout(timer);
        const isE2BIG = (err as NodeJS.ErrnoException).code === 'E2BIG';
        const msg = isE2BIG
          ? 'Prompt too large for CLI arg mode'
          : `spawn error — is '${this.binary}' installed and on PATH?`;
        debugWrite(`[${this.binary}] ${msg}`);
        resolve({ satisfied: false, reason: msg, errorSource: 'provider' });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (killed || code !== 0) {
          if (!killed && code !== 0) debugWrite(`[${this.binary}] exit_code=${code}`);
          resolve(fallback);
          return;
        }
        resolve(parseAspectResponse(stdout) ?? fallback);
      });

      if (this.stdinMode) {
        child.stdin.write(prompt);
        child.stdin.end();
      } else {
        child.stdin.end();
      }
    });
  }
}
