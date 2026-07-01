// =============================================================================
// The shipped examples/ projects must be valid and self-contained: the README
// walks adopters through `cd examples/passing && yg check` (PASS) and
// `cd examples/failing && yg check` (the requires-audit refusal). Each example
// ships a COMMITTED .yggdrasil/yg-lock.json, so `yg check` is a PURE READ that
// reproduces the verdict from the lock with NO API key / NO reviewer — exactly
// what an adopter (and CI) sees. This test spawns the built binary against both
// examples and asserts the documented outcome, so the examples cannot silently
// rot (they predate the verdict-lock model once already).
//
// The LLM examples (passing/failing) are READ-ONLY here — plain `yg check` only,
// reproducing the committed verdict with no reviewer. The keyless examples use a
// deterministic `check.mjs` or the built-in relation check, so they need no key
// either: the relation example is green on plain `yg check`, and the
// deterministic examples reach green via the FREE, keyless
// `yg check --approve --only-deterministic` fill (no reviewer, no network).
// =============================================================================

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '..', '..');       // source/cli
const REPO_ROOT = path.join(CLI_ROOT, '..', '..');       // repo root
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const distExists = existsSync(BIN_PATH);

function ygCheck(exampleDir: string): { all: string; status: number | null } {
  const r = spawnSync('node', [BIN_PATH, 'check'], {
    cwd: path.join(REPO_ROOT, 'examples', exampleDir),
    encoding: 'utf-8',
  });
  return { all: (r.stdout ?? '') + (r.stderr ?? ''), status: r.status };
}

// Free, keyless deterministic fill: runs the example's check.mjs locally and
// writes ONLY the gitignored deterministic cache — no reviewer, no API key, no
// network. This is how the keyless deterministic examples reach green from a
// clean clone (their verdict is not committed; it is rebuilt for free).
function ygFillDeterministic(exampleDir: string): { all: string; status: number | null } {
  const r = spawnSync('node', [BIN_PATH, 'check', '--approve', '--only-deterministic'], {
    cwd: path.join(REPO_ROOT, 'examples', exampleDir),
    encoding: 'utf-8',
  });
  return { all: (r.stdout ?? '') + (r.stderr ?? ''), status: r.status };
}

describe.skipIf(!distExists)('CLI E2E — shipped examples are valid + reproducible (read-only, no reviewer)', () => {
  it('examples/passing — yg check PASS from the committed lock, no API key', () => {
    const r = ygCheck('passing');
    expect(r.status).toBe(0);
    expect(r.all).toContain('yg check: PASS');
  });

  it('examples/failing — yg check FAIL showing the requires-audit refusal on payments', () => {
    const r = ygCheck('failing');
    expect(r.status).toBe(1);
    expect(r.all).toContain('refused');
    expect(r.all).toContain("requires-audit");
    expect(r.all).toContain('payments');
  });

  // --- Keyless examples (deterministic check.mjs + built-in relation check) ---
  // No reviewer, no API key. The relation example is green on plain `yg check`;
  // the deterministic examples reach green via the free `--only-deterministic`
  // fill (which writes only the gitignored cache).

  it('examples/layered-architecture — plain yg check PASS (live relation check, no key)', () => {
    const r = ygCheck('layered-architecture');
    expect(r.status).toBe(0);
    expect(r.all).toContain('yg check: PASS');
  });

  for (const name of ['no-secrets-in-logs', 'pure-transforms', 'checkout-flow']) {
    it(`examples/${name} — free deterministic fill reaches PASS, no key`, () => {
      const fill = ygFillDeterministic(name);
      expect(fill.status).toBe(0);
      expect(fill.all).toContain('yg check: PASS');
      // Plain check then re-hashes the cached verdict — still green, still keyless.
      const r = ygCheck(name);
      expect(r.status).toBe(0);
      expect(r.all).toContain('yg check: PASS');
    });
  }
});
