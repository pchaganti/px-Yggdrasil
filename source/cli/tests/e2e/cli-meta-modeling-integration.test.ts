// =============================================================================
// META-MODELING — integration E2E.
//
// Proves the graph can model and verify files UNDER its own .yggdrasil/ directory,
// via the four access channels, and that the reachability negative ("no relation →
// error") fails closed.
//
// Fixture: a `requirements` doc node + an `enforcers` meta node that MAPS the
// enforcer check files under .yggdrasil/aspects/enforced/. The check
// `.yggdrasil/aspects/enforced/no-foo/check.mjs` reaches a reviewer four ways:
//   1. mapping → subject  (enforcers maps it; meta/maps-check reviews it)        <source-files>
//   2. references         (meta/cites-check references it)                       <references>
//   3. companion          (meta/audits-check companion returns it per-document)  <companions>
//   4. companion ctx.fs   (that companion ctx.fs-reads it — relation-reachable)
// Negatives:
//   N1 remove the requirements→enforcers relation → the companion/ctx.fs read is
//      out of allowed-reads → audits-check fails closed; references + mapping,
//      which need no relation, still pass.
//   N2 a mapped meta .mjs with an undeclared cross-node import → the built-in
//      relation check refuses it (mapped .yggdrasil/ code is held to the same rule).
//
// HERMETIC: fresh mkdtemp copy per test, in-process Ollama-protocol mock reviewer.
// =============================================================================

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, cpSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockReviewer, runAsync, type ChatRequest } from './support/mock-reviewer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '..', '..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'e2e-meta-modeling');
const distExists = existsSync(BIN_PATH);

const CHECK = '.yggdrasil/aspects/enforced/no-foo/check.mjs';
const cfgPath = (d: string) => path.join(d, '.yggdrasil', 'yg-config.yaml');
const nodeYaml = (d: string, n: string) => path.join(d, '.yggdrasil', 'model', n, 'yg-node.yaml');
const mappedCheck = (d: string) => path.join(d, '.yggdrasil', 'aspects', 'enforced', 'no-foo', 'check.mjs');

function run(args: string[], cwd: string): { all: string; status: number | null } {
  const r = spawnSync('node', [BIN_PATH, ...args], { cwd, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });
  return { all: (r.stdout ?? '') + (r.stderr ?? ''), status: r.status };
}
function pointReviewer(dir: string, endpoint: string): void {
  const p = cfgPath(dir);
  writeFileSync(p, readFileSync(p, 'utf-8').replace(/endpoint:\s*["']?[^"'\n]+["']?/g, `endpoint: "${endpoint}"`), 'utf-8');
}
function copyFixture(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-meta-${label}-`));
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}
const promptFor = (prompts: string[], aspectId: string): string | undefined =>
  prompts.find((p) => p.includes(`<aspect id="${aspectId}"`));

describe.skipIf(!distExists)('CLI E2E — meta-modeling (.yggdrasil mapped / referenced / companion)', () => {
  it('all four channels reach a .yggdrasil check; structure + relation check stay clean', async () => {
    const dir = copyFixture('happy');
    const prompts: string[] = [];
    const mock = await startMockReviewer({
      respond: (req: ChatRequest) => {
        prompts.push(req.prompt);
        return { satisfied: true, reason: 'ok' };
      },
    });
    try {
      pointReviewer(dir, mock.endpoint);
      const fill = await runAsync(['check', '--approve'], dir);
      expect(fill.status).toBe(0);
      // Mapping a .yggdrasil/ .mjs does NOT false-positive the built-in relation check.
      expect(fill.all).not.toContain('relation-undeclared-dependency');

      // Channel 1 — mapping → subject: the mapped check is a SOURCE FILE in the prompt.
      const maps = promptFor(prompts, 'meta/maps-check');
      expect(maps).toBeDefined();
      expect(maps).toContain(`<file path="${CHECK}"`);

      // Channel 2 — references: the check rides the <references> block.
      const cites = promptFor(prompts, 'meta/cites-check');
      expect(cites).toBeDefined();
      expect(cites).toContain(`<reference path="${CHECK}"`);

      // Channel 3 (+4 ctx.fs): the check is injected as a <companion> per document.
      const audits = promptFor(prompts, 'meta/audits-check');
      expect(audits).toBeDefined();
      expect(audits).toContain(`<companion path="${CHECK}"`);

      // Clean end-to-end.
      expect(run(['check'], dir).status).toBe(0);
    } finally {
      await mock.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60000);

  it('N1: removing the uses relation breaks the companion/ctx.fs channel; references + mapping still pass', async () => {
    const dir = copyFixture('n1');
    const mock = await startMockReviewer({ respond: () => ({ satisfied: true, reason: 'ok' }) });
    try {
      pointReviewer(dir, mock.endpoint);
      // Remove the requirements → enforcers relation.
      const np = nodeYaml(dir, 'requirements');
      writeFileSync(np, readFileSync(np, 'utf-8').replace(/relations:\n {2}- target: enforcers\n {4}type: uses\n/, ''), 'utf-8');

      const fill = await runAsync(['check', '--approve'], dir);
      // The companion can no longer read/return the .yggdrasil/ check → fail closed.
      expect(fill.status).not.toBe(0);
      expect(fill.all).toContain('audits-check');
      // The check (no longer reachable) was the audited target; the message points at it.
      expect(fill.all).toContain('enforced/no-foo');

      // references (cites-check) and mapping (maps-check) do NOT need the relation.
      const after = run(['check'], dir);
      expect(after.all).not.toContain("aspect 'meta/cites-check'");
      expect(after.all).not.toContain("aspect 'meta/maps-check'");
    } finally {
      await mock.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60000);

  it('N2: a mapped .yggdrasil/ check with an undeclared cross-node import is refused by the relation check', async () => {
    const dir = copyFixture('n2');
    const mock = await startMockReviewer({ respond: () => ({ satisfied: true, reason: 'ok' }) });
    try {
      pointReviewer(dir, mock.endpoint);
      // Add an undeclared static import of the app node's source to the MAPPED check.
      const cp = mappedCheck(dir);
      writeFileSync(cp, `import '../../../../src/app.ts';\n${readFileSync(cp, 'utf-8')}`, 'utf-8');

      // The built-in relation check runs live on plain `yg check`.
      const after = run(['check'], dir);
      expect(after.status).toBe(1);
      expect(after.all).toContain('relation-undeclared-dependency');
      expect(after.all).toContain(CHECK);
    } finally {
      await mock.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60000);
});
