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

/**
 * Scan `text` for balanced `{...}` spans (respecting string literals and escapes)
 * and return the LAST one that parses to an object carrying a boolean `satisfied`
 * field — i.e. the actual verdict. A greedy `\{[\s\S]*\}` cannot be used: a model
 * that wraps its JSON verdict in prose (markdown analysis, code snippets, the
 * literal text `{ what, why, next }`) has brace characters BEFORE the verdict, so
 * a greedy match spans unrelated braces and fails to parse. Requiring a boolean
 * `satisfied` key means brace-laden prose without a real verdict still yields
 * nothing here (→ fail closed), preserving the A3b guarantee.
 */
function extractLastVerdict(text: string): Record<string, unknown> | undefined {
  let last: Record<string, unknown> | undefined;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') continue;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let j = i; j < text.length; j++) {
      const c = text[j];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) {
          try {
            const obj = JSON.parse(text.slice(i, j + 1)) as Record<string, unknown>;
            if (obj && typeof obj.satisfied === 'boolean') last = obj;
          } catch { /* not a JSON object — keep scanning */ }
          break;
        }
      }
    }
  }
  return last;
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

  // 3. Embedded JSON verdict — the model may emit its JSON verdict surrounded by
  // prose that itself contains braces, so locate the balanced object that holds a
  // boolean `satisfied` rather than greedy-matching the outermost braces.
  const verdict = extractLastVerdict(trimmed);
  if (verdict) return normalizeResponse(verdict);

  // 4. Unparseable response — no valid JSON verdict found. Do NOT heuristically
  // guess "satisfied" from a substring match: a garbled/non-JSON reply that happens
  // to contain the word would become a false code-PASS that commits green over
  // unverified code (A3b). Classify it as a PROVIDER (infrastructure) error so the
  // fail-closed gate refuses without committing.
  debugWrite('[parseAspectResponse] no parseable JSON verdict — classifying as provider error');
  return { satisfied: false, reason: `Unparseable reviewer response: ${trimmed.slice(0, 160)}`, errorSource: 'provider' };
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
