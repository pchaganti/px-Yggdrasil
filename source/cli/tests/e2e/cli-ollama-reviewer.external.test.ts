import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, cpSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// EXTERNAL test file. Depends on a REAL Ollama endpoint being reachable at
// host.docker.internal:11434. Named `*.external.test.ts` so the
// `test-deterministic` aspect's ambient/external-dependency exemption applies.
// This file deliberately carries an ambient dependency on external environment
// state; it is gated with `describe.skipIf` so it is a no-op where Ollama is
// not reachable (e.g. CI).
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'e2e-lifecycle');

const distExists = existsSync(BIN_PATH);

const OLLAMA_ENDPOINT = 'http://host.docker.internal:11434';

function run(
  args: string[],
  cwd: string,
): {
  stdout: string;
  stderr: string;
  status: number | null;
  all: string;
} {
  const result = spawnSync('node', [BIN_PATH, ...args], {
    cwd,
    encoding: 'utf-8',
  });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  return { stdout, stderr, status: result.status, all: stdout + stderr };
}

/** Copy the e2e-lifecycle fixture into a fresh temp dir for mutation. */
function copyFixture(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-ollama-${label}-`));
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

const baselinePath = (dir: string, node: string) =>
  path.join(dir, '.yggdrasil', '.drift-state', ...node.split('/')) + '.json';

async function probeOllama(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    const res = await fetch(`${OLLAMA_ENDPOINT}/api/tags`, { signal: controller.signal });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

const ollamaUp = await probeOllama();

// ---------------------------------------------------------------------------
// Ollama-gated LLM reviewer path. Proves the real reviewer functions
// end-to-end. Skipped when no Ollama is reachable (e.g. CI).
// ---------------------------------------------------------------------------

describe.skipIf(!ollamaUp || !distExists)('CLI E2E — Ollama-gated LLM reviewer path', () => {
  it('F14: approve reaches the LLM reviewer and records a has-doc-comment verdict', () => {
    const dir = copyFixture('ollama');
    try {
      // Verdict from a 0.5b model is not reliable, so exit code may be 0 or 1.
      // We only assert the reviewer was REACHED and produced a recorded verdict.
      const { stdout, stderr } = run(['approve', '--node', 'services/orders'], dir);
      const all = stdout + stderr;
      expect(all).not.toContain('not reachable');
      expect(all).not.toContain('Reviewer configured but not reachable');

      const blPath = baselinePath(dir, 'services/orders');
      expect(existsSync(blPath)).toBe(true);
      const baseline = JSON.parse(readFileSync(blPath, 'utf-8'));
      expect(baseline.aspectVerdicts).toBeDefined();
      expect(baseline.aspectVerdicts['has-doc-comment']).toBeDefined();
      expect(baseline.aspectVerdicts['has-doc-comment'].verdict).toMatch(/approved|refused/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
