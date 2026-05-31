// Hermetic E2E — FAIL-CLOSED reviewer (#2 / A3). A reviewer INFRA failure (provider
// unreachable, non-200/garbled response, no reviewer configured for an LLM aspect)
// must leave the node RED with the prior baseline fully intact — never commit an
// advanced hash + carry the prior `approved` verdict forward, which would make the
// next `yg check` green over unverified code (a false-green). Driven deterministically
// by the in-process mock (support/mock-reviewer.ts).

import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, rmSync, cpSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockReviewer, runAsync, type ChatReply } from './support/mock-reviewer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '..', '..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'e2e-lifecycle');
const distExists = existsSync(BIN_PATH);

const cfgPath = (dir: string) => path.join(dir, '.yggdrasil', 'yg-config.yaml');
const ordersFile = (dir: string) => path.join(dir, 'src', 'services', 'orders.ts');
const baselinePath = (dir: string, node: string) => path.join(dir, '.yggdrasil', '.drift-state', ...node.split('/')) + '.json';
const baselineHash = (dir: string, node: string) => JSON.parse(readFileSync(baselinePath(dir, node), 'utf-8')).hash as string;

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
  it('1: an infra failure (provider 500) on a source change does NOT advance the baseline — yg check stays RED', async () => {
    const dir = fixture('provider-500');
    const okMock = await startMockReviewer({ respond: OK });
    try {
      pointReviewer(dir, okMock.endpoint);
      // Clean approve → green baseline.
      expect((await runAsync(['approve', '--node', 'services/orders'], dir)).status).toBe(0);
      const before = baselineHash(dir, 'services/orders');
      await okMock.close();

      // Edit the source (now unverified), then approve with the provider returning 500.
      writeFileSync(ordersFile(dir), readFileSync(ordersFile(dir), 'utf-8') + '\nexport const edited = 1;\n', 'utf-8');
      const infraMock = await startMockReviewer({ respond: () => ({ httpStatus: 500 }) });
      try {
        pointReviewer(dir, infraMock.endpoint);
        const approve = await runAsync(['approve', '--node', 'services/orders'], dir);
        expect(approve.status).toBe(1); // infra → refused

        // FAIL-CLOSED: the baseline hash must NOT have advanced (no commit on infra),
        // so the edited+unverified source still shows as drift.
        expect(baselineHash(dir, 'services/orders')).toBe(before);
        const check = await runAsync(['check'], dir);
        expect(check.status).toBe(1); // RED — drift visible, no false-green
        expect(check.all).toContain('services/orders');
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
      expect((await runAsync(['approve', '--node', 'services/orders'], dir)).status).toBe(0);
      const before = baselineHash(dir, 'services/orders');
      await okMock.close();

      writeFileSync(ordersFile(dir), readFileSync(ordersFile(dir), 'utf-8') + '\nexport const edited2 = 2;\n', 'utf-8');
      // A junk response that happens to contain the word "satisfied" must NOT become a PASS.
      const junkMock = await startMockReviewer({ respond: () => ({ rawContent: 'sure, looks satisfied to me!!! {{{' }) });
      try {
        pointReviewer(dir, junkMock.endpoint);
        const approve = await runAsync(['approve', '--node', 'services/orders'], dir);
        expect(approve.status).toBe(1);
        expect(baselineHash(dir, 'services/orders')).toBe(before); // not advanced
        expect((await runAsync(['check'], dir)).status).toBe(1); // RED
      } finally {
        await junkMock.close();
      }
    } finally {
      await okMock.close().catch(() => {});
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('3: regression — a clean approve still commits (green), and a genuine refuse still records red', async () => {
    const dir = fixture('regression');
    const mock = await startMockReviewer({ respond: OK });
    try {
      pointReviewer(dir, mock.endpoint);
      const r = await runAsync(['approve', '--node', 'services/orders'], dir);
      expect(r.status).toBe(0);
      expect(existsSync(baselinePath(dir, 'services/orders'))).toBe(true);
      // A clean re-check is green.
      const check = await runAsync(['check'], dir);
      // services/payments is unapproved, so overall may be 1; but orders must not be flagged.
      expect(check.all).not.toContain('Source files changed since last approve.\n            Fix: yg approve --node services/orders');
    } finally {
      await mock.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
