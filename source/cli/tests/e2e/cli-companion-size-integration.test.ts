// =============================================================================
// COMPANION PROMPT-SIZE GATE — integration E2E.
//
// Regression for the verify-lock §4 size gate over-counting companion-bearing LLM
// aspects. The fixture's companion READS a large reachable file (payloads/big.txt,
// ~80 KB) to decide, but INJECTS only a small paired payload (payloads/small.txt).
//
//   Buggy behaviour: plain `yg check` reconstructed the gate's companion set from
//   the stored `touched` read: keys — which conflate the large DECISION read with
//   the small INJECTED companion — so it measured a prompt ~the size of big.txt and
//   falsely flagged prompt-too-large.
//
//   Fixed behaviour: the gate runs the companion resolver LIVE (the same path fill
//   uses) and measures ONLY the returned small.txt. A companion that fails to
//   resolve during the gate surfaces a clear diagnostic.
//
// HERMETIC: fresh mkdtemp copy of the fixture per test, in-process Ollama-protocol
// mock reviewer (runAsync, never spawnSync while the mock serves), rmSync in finally.
// =============================================================================

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, cpSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockReviewer, runAsync } from './support/mock-reviewer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '..', '..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'e2e-companion-size');
const distExists = existsSync(BIN_PATH);

const cfgPath = (d: string) => path.join(d, '.yggdrasil', 'yg-config.yaml');
const companionPath = (d: string) =>
  path.join(d, '.yggdrasil', 'aspects', 'broad-companion', 'companion.mjs');

function run(args: string[], cwd: string): { all: string; status: number | null } {
  const r = spawnSync('node', [BIN_PATH, ...args], { cwd, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });
  return { all: (r.stdout ?? '') + (r.stderr ?? ''), status: r.status };
}
function pointReviewer(dir: string, endpoint: string): void {
  const p = cfgPath(dir);
  writeFileSync(p, readFileSync(p, 'utf-8').replace(/endpoint:\s*["']?[^"'\n]+["']?/g, `endpoint: "${endpoint}"`), 'utf-8');
}
function setLimit(dir: string, chars: number): void {
  const p = cfgPath(dir);
  writeFileSync(
    p,
    readFileSync(p, 'utf-8').replace(/( {4}standard:\n {6}provider: ollama\n {6}consensus: 1\n)/, `$1      max_prompt_chars: ${chars}\n`),
    'utf-8',
  );
}
function copyFixture(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-companion-size-${label}-`));
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

describe.skipIf(!distExists)('CLI E2E — companion prompt-size gate', () => {
  // The companion injects only the small payload, so the real assembled prompt is a
  // few KB. With a limit ABOVE the real prompt but FAR BELOW big.txt (~80 KB), a
  // gate that measured the decision-read would flag prompt-too-large; the live-resolve
  // gate measures the small real prompt and stays green.
  it('a companion that reads big but injects small stays UNDER a limit above the real prompt', async () => {
    const dir = copyFixture('green');
    const mock = await startMockReviewer({ respond: () => ({ satisfied: true, reason: 'ok' }) });
    try {
      pointReviewer(dir, mock.endpoint);
      // Fill with no limit → green, stores touched with read:big.txt + read:small.txt.
      expect((await runAsync(['check', '--approve'], dir)).status).toBe(0);

      // 30000 is above the real prompt (~KB) and far below big.txt (~80 KB).
      setLimit(dir, 30000);
      const after = run(['check'], dir);
      expect(after.all).not.toContain('prompt-too-large');
      expect(after.status).toBe(0);
    } finally {
      await mock.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 40000);

  // Lower the limit BELOW the real small prompt → prompt-too-large, but the reported
  // char count must be the SMALL real prompt (a few KB), never ~80 KB. Proves the
  // gate measures the injected companion, not the decision-read.
  it('over-limit reports the REAL small char count, not the decision-read size', async () => {
    const dir = copyFixture('realsize');
    const mock = await startMockReviewer({ respond: () => ({ satisfied: true, reason: 'ok' }) });
    try {
      pointReviewer(dir, mock.endpoint);
      expect((await runAsync(['check', '--approve'], dir)).status).toBe(0);

      setLimit(dir, 200);
      const after = run(['check'], dir);
      expect(after.status).toBe(1);
      expect(after.all).toContain('prompt-too-large');
      const m = /is (\d+) chars, over the 'standard' tier limit of 200/.exec(after.all);
      expect(m).not.toBeNull();
      const chars = Number(m![1]);
      // Real small prompt is a few KB; big.txt alone is ~80 KB. Must be well under.
      expect(chars).toBeGreaterThan(200);
      expect(chars).toBeLessThan(30000);
    } finally {
      await mock.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 40000);

  // A broken companion.mjs (throws) with a tier limit set → the live gate resolver
  // surfaces a CLEAR diagnostic naming the aspect, so the agent diagnoses immediately.
  it('a broken companion surfaces a clear diagnostic on `yg check` when a limit is set', async () => {
    const dir = copyFixture('broken');
    const mock = await startMockReviewer({ respond: () => ({ satisfied: true, reason: 'ok' }) });
    try {
      pointReviewer(dir, mock.endpoint);
      setLimit(dir, 30000);
      writeFileSync(companionPath(dir), 'export function companion() {\n  throw new Error("companion boom");\n}\n', 'utf-8');

      const after = run(['check'], dir);
      expect(after.status).toBe(1);
      expect(after.all).toContain('broad-companion');
      expect(after.all.toLowerCase()).toContain('companion');
      expect(after.all).toContain('boom');
    } finally {
      await mock.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 40000);
});
