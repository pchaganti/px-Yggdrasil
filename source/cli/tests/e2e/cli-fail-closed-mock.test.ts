// Hermetic E2E — FAIL-CLOSED reviewer (#2 / A3). A reviewer INFRA failure (provider
// unreachable, non-200/garbled response, no reviewer configured for an LLM aspect)
// must leave the pair UNVERIFIED with the prior lock entry fully intact — never commit
// an advanced verdict over code the reviewer never saw, which would make the next
// `yg check` green over unverified code (a false-green). The fill (`yg check --approve`)
// writes NOTHING for an infra-failed pair: its lock verdict entry stays byte-identical
// (old hash + prior verdict), so a later `yg check` still sees the edited source as
// unverified and exits 1. Driven deterministically by the in-process mock
// (support/mock-reviewer.ts) — no network, no Ollama, runs in CI.
//
// Uses async spawn (runAsync) so this process's event loop stays alive to serve the
// mock while the child `yg` makes its HTTP calls (spawnSync would deadlock).

import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, rmSync, cpSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockReviewer, runAsync, type ChatReply } from './support/mock-reviewer.js';
import { readLock } from '../../src/io/lock-store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '..', '..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'e2e-lifecycle');
const distExists = existsSync(BIN_PATH);

const cfgPath = (dir: string) => path.join(dir, '.yggdrasil', 'yg-config.yaml');
const ordersFile = (dir: string) => path.join(dir, 'src', 'services', 'orders.ts');
const yggPath = (dir: string) => path.join(dir, '.yggdrasil');

/** The recorded lock entry (hash + verdict) for one aspect/unit pair, serialized. */
function lockEntry(dir: string, aspectId: string, unitKey: string): string {
  const v = readLock(yggPath(dir)).verdicts[aspectId]?.[unitKey];
  return JSON.stringify(v);
}

function fixture(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-failclosed-${label}-`));
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}
function pointReviewer(dir: string, endpoint: string): void {
  const p = cfgPath(dir);
  writeFileSync(p, readFileSync(p, 'utf-8').replace(/endpoint:\s*["']?[^"'\n]+["']?/, `endpoint: "${endpoint}"`), 'utf-8');
}
const OK: () => ChatReply = () => ({ satisfied: true, reason: 'ok' });

describe.skipIf(!distExists)('CLI E2E — fail-closed reviewer (#2)', () => {
  it('1: an infra failure (provider 500) on a source change does NOT advance the lock entry — yg check stays RED', async () => {
    const dir = fixture('provider-500');
    const okMock = await startMockReviewer({ respond: OK });
    try {
      pointReviewer(dir, okMock.endpoint);
      // Clean fill → green lock for the enforced LLM aspect on both service nodes.
      expect((await runAsync(['check', '--approve'], dir)).status).toBe(0);
      // Snapshot the lock entries BEFORE the infra failure.
      const ordersBefore = lockEntry(dir, 'has-doc-comment', 'node:services/orders');
      const paymentsBefore = lockEntry(dir, 'has-doc-comment', 'node:services/payments');
      expect(JSON.parse(ordersBefore).verdict).toBe('approved');
      await okMock.close();

      // Edit the orders source (its pair is now unverified), then fill with the
      // provider returning 500.
      writeFileSync(ordersFile(dir), readFileSync(ordersFile(dir), 'utf-8') + '\nexport const edited = 1;\n', 'utf-8');
      const infraMock = await startMockReviewer({ respond: () => ({ httpStatus: 500 }) });
      try {
        pointReviewer(dir, infraMock.endpoint);
        const fill = await runAsync(['check', '--approve'], dir);
        expect(fill.status).toBe(1); // infra → run ends red, nothing written
        // The infra summary is printed, naming the failed pairs.
        expect(fill.all).toContain('pairs failed on provider/config errors');

        // FAIL-CLOSED: the EDITED pair's lock entry must NOT have advanced — it is
        // byte-identical to the green entry (old hash + prior verdict), so the
        // edited+unverified source still shows as unverified. The reviewer never
        // saw the new code, so no green was committed over it.
        expect(lockEntry(dir, 'has-doc-comment', 'node:services/orders')).toBe(ordersBefore);
        // The untouched sibling's entry is intact too.
        expect(lockEntry(dir, 'has-doc-comment', 'node:services/payments')).toBe(paymentsBefore);

        // Plain `yg check` sees the new source != stored hash → unverified, exit 1.
        const check = await runAsync(['check'], dir);
        expect(check.status).toBe(1); // RED — unverified visible, no false-green
        expect(check.all).toContain('services/orders');
        expect(check.all).toContain("aspect 'has-doc-comment'");
      } finally {
        await infraMock.close();
      }
    } finally {
      await okMock.close().catch(() => {});
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('2: a garbled (unparseable) reviewer response is treated as infra (red), not a code PASS', async () => {
    const dir = fixture('garbled');
    const okMock = await startMockReviewer({ respond: OK });
    try {
      pointReviewer(dir, okMock.endpoint);
      expect((await runAsync(['check', '--approve'], dir)).status).toBe(0);
      const ordersBefore = lockEntry(dir, 'has-doc-comment', 'node:services/orders');
      await okMock.close();

      writeFileSync(ordersFile(dir), readFileSync(ordersFile(dir), 'utf-8') + '\nexport const edited2 = 2;\n', 'utf-8');
      // A junk response that happens to contain the word "satisfied" must NOT become a PASS.
      const junkMock = await startMockReviewer({ respond: () => ({ rawContent: 'sure, looks satisfied to me!!! {{{' }) });
      try {
        pointReviewer(dir, junkMock.endpoint);
        const fill = await runAsync(['check', '--approve'], dir);
        expect(fill.status).toBe(1);
        expect(fill.all).toContain('pairs failed on provider/config errors');
        // The garbled "satisfied" did NOT advance the edited pair's lock entry.
        expect(lockEntry(dir, 'has-doc-comment', 'node:services/orders')).toBe(ordersBefore);
        expect((await runAsync(['check'], dir)).status).toBe(1); // RED
      } finally {
        await junkMock.close();
      }
    } finally {
      await okMock.close().catch(() => {});
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('3: regression — a clean fill still commits (green), and a genuine refuse still records red', async () => {
    const dir = fixture('regression');
    const mock = await startMockReviewer({ respond: OK });
    try {
      pointReviewer(dir, mock.endpoint);
      const fill = await runAsync(['check', '--approve'], dir);
      expect(fill.status).toBe(0);
      // A clean fill writes a green lock entry for the enforced LLM aspect.
      expect(JSON.parse(lockEntry(dir, 'has-doc-comment', 'node:services/orders')).verdict).toBe('approved');
      // A clean re-check is green — orders is not flagged as unverified.
      const check = await runAsync(['check'], dir);
      expect(check.status).toBe(0);
      expect(check.all).not.toContain("aspect 'has-doc-comment' on node:services/orders");
    } finally {
      await mock.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
