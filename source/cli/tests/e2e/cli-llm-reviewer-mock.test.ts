// Hermetic E2E — the LLM REVIEWER MECHANICS, exercised end-to-end against the real
// spawned binary with an in-process mock that speaks the Ollama protocol (see
// support/mock-reviewer.ts). The mock plays the reviewer's role deterministically, so
// what is under test here is YGGDRASIL's machinery — request shape, consensus call
// count and majority aggregation, tier/model selection, response parsing, the
// provider-error fallback, prompt construction, and how an LLM verdict drives
// approve/check/drift — NOT any model's judgment. No network, no Ollama, runs in CI.
//
// Uses async spawn (runAsync) so this process's event loop stays alive to serve the
// mock while the child `yg` makes its HTTP calls (spawnSync would deadlock).

import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, rmSync, cpSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockReviewer, runAsync, type ChatReply, type ChatRequest } from './support/mock-reviewer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '..', '..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'e2e-lifecycle');
const distExists = existsSync(BIN_PATH);

const cfgPath = (dir: string) => path.join(dir, '.yggdrasil', 'yg-config.yaml');
const aspectYaml = (dir: string) => path.join(dir, '.yggdrasil', 'aspects', 'has-doc-comment', 'yg-aspect.yaml');
const ordersFile = (dir: string) => path.join(dir, 'src', 'services', 'orders.ts');
const baselinePath = (dir: string, node: string) => path.join(dir, '.yggdrasil', '.drift-state', ...node.split('/')) + '.json';

/** Fresh temp copy of the lifecycle fixture (service node has the enforced LLM aspect has-doc-comment). */
function fixture(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-llmmock-${label}-`));
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

/** Point the reviewer tier's endpoint at the mock. */
function pointReviewer(dir: string, endpoint: string): void {
  const p = cfgPath(dir);
  writeFileSync(p, readFileSync(p, 'utf-8').replace(/endpoint:\s*["']?[^"'\n]+["']?/, `endpoint: "${endpoint}"`), 'utf-8');
}

function setConsensus(dir: string, n: number): void {
  const p = cfgPath(dir);
  writeFileSync(p, readFileSync(p, 'utf-8').replace(/consensus:\s*\d+/, `consensus: ${n}`), 'utf-8');
}

function setAspectStatus(dir: string, status: 'draft' | 'advisory' | 'enforced'): void {
  const p = aspectYaml(dir);
  writeFileSync(p, readFileSync(p, 'utf-8').replace(/status:\s*\w+/, `status: ${status}`), 'utf-8');
}

const ALWAYS_OK: (r: ChatRequest, i: number) => ChatReply = () => ({ satisfied: true, reason: 'ok' });
const ALWAYS_REFUSE: (r: ChatRequest, i: number) => ChatReply = () => ({ satisfied: false, reason: 'the file has no leading comment' });

describe.skipIf(!distExists)('CLI E2E — LLM reviewer mechanics via in-process mock', () => {
  it('1: an LLM-aspect APPROVE verdict from the reviewer records a baseline and exits 0', async () => {
    const dir = fixture('approve');
    const mock = await startMockReviewer({ respond: ALWAYS_OK });
    try {
      pointReviewer(dir, mock.endpoint);
      const r = await runAsync(['approve', '--node', 'services/orders'], dir);
      expect(r.status).toBe(0);
      expect(r.all).toContain('Approved: services/orders');
      expect(existsSync(baselinePath(dir, 'services/orders'))).toBe(true);
      // Exactly one LLM aspect (has-doc-comment) at consensus 1 → one /api/chat call.
      expect(mock.chatCount()).toBe(1);
    } finally {
      await mock.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('2: an LLM-aspect REFUSE verdict blocks approve (exit 1) and surfaces the reviewer reason', async () => {
    const dir = fixture('refuse');
    const mock = await startMockReviewer({ respond: ALWAYS_REFUSE });
    try {
      pointReviewer(dir, mock.endpoint);
      const r = await runAsync(['approve', '--node', 'services/orders'], dir);
      expect(r.status).toBe(1);
      expect(r.all).toContain('has-doc-comment');
      expect(r.all).toContain('the file has no leading comment');
    } finally {
      await mock.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('3: the verifier prompt carries the aspect id, the aspect content.md, the node path, and the source', async () => {
    const dir = fixture('prompt');
    const mock = await startMockReviewer({ respond: ALWAYS_OK });
    try {
      pointReviewer(dir, mock.endpoint);
      await runAsync(['approve', '--node', 'services/orders'], dir);
      expect(mock.chatCount()).toBe(1);
      const prompt = mock.chatRequests[0].prompt;
      expect(prompt).toContain('has-doc-comment'); // aspect id
      expect(prompt).toContain('Every source file must begin with a comment.'); // content.md
      expect(prompt).toContain('services/orders'); // node path
      expect(prompt).toContain('orders.ts'); // a mapped source file name
    } finally {
      await mock.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('4: consensus N issues exactly N reviewer calls for one aspect', async () => {
    const dir = fixture('consensus-count');
    const mock = await startMockReviewer({ respond: ALWAYS_OK });
    try {
      pointReviewer(dir, mock.endpoint);
      setConsensus(dir, 3);
      const r = await runAsync(['approve', '--node', 'services/orders'], dir);
      expect(r.status).toBe(0);
      expect(mock.chatCount()).toBe(3);
    } finally {
      await mock.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('5: consensus majority SATISFIED (split 2-1) approves', async () => {
    const dir = fixture('consensus-majority-ok');
    // votes by call index: refuse, satisfy, satisfy → 2 > 1 → approved
    const mock = await startMockReviewer({
      respond: (_r, i) => (i === 0 ? { satisfied: false, reason: 'no' } : { satisfied: true, reason: 'ok' }),
    });
    try {
      pointReviewer(dir, mock.endpoint);
      setConsensus(dir, 3);
      const r = await runAsync(['approve', '--node', 'services/orders'], dir);
      expect(mock.chatCount()).toBe(3);
      expect(r.status).toBe(0);
      expect(r.all).toContain('Approved: services/orders');
    } finally {
      await mock.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('6: consensus majority NOT-SATISFIED (split 1-2) refuses', async () => {
    const dir = fixture('consensus-majority-refuse');
    // votes by call index: satisfy, refuse, refuse → 1 < 2 → refused
    const mock = await startMockReviewer({
      respond: (_r, i) => (i === 0 ? { satisfied: true, reason: 'ok' } : { satisfied: false, reason: 'majority says no comment' }),
    });
    try {
      pointReviewer(dir, mock.endpoint);
      setConsensus(dir, 3);
      const r = await runAsync(['approve', '--node', 'services/orders'], dir);
      expect(mock.chatCount()).toBe(3);
      expect(r.status).toBe(1);
      expect(r.all).toContain('has-doc-comment');
    } finally {
      await mock.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('7: a non-200 from the provider becomes a provider-error fallback that blocks approve', async () => {
    const dir = fixture('provider-error');
    const mock = await startMockReviewer({ respond: () => ({ httpStatus: 500 }) });
    try {
      pointReviewer(dir, mock.endpoint);
      const r = await runAsync(['approve', '--node', 'services/orders'], dir);
      expect(mock.chatCount()).toBeGreaterThanOrEqual(1);
      expect(r.status).toBe(1);
      expect(r.all).toContain('has-doc-comment');
    } finally {
      await mock.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('8: a malformed (unparseable) reviewer response becomes a provider-error fallback (exit 1)', async () => {
    const dir = fixture('malformed');
    const mock = await startMockReviewer({ respond: () => ({ rawContent: 'not json at all {{{' }) });
    try {
      pointReviewer(dir, mock.endpoint);
      const r = await runAsync(['approve', '--node', 'services/orders'], dir);
      expect(mock.chatCount()).toBeGreaterThanOrEqual(1);
      expect(r.status).toBe(1);
    } finally {
      await mock.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('9: a DRAFT LLM aspect is never sent to the reviewer (zero calls), approve exits 0', async () => {
    const dir = fixture('draft');
    const mock = await startMockReviewer({ respond: ALWAYS_REFUSE });
    try {
      pointReviewer(dir, mock.endpoint);
      setAspectStatus(dir, 'draft');
      const r = await runAsync(['approve', '--node', 'services/orders'], dir);
      expect(mock.chatCount()).toBe(0); // reviewer skipped for draft
      expect(r.status).toBe(0);
    } finally {
      await mock.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('10: an ADVISORY LLM aspect refusal is a non-blocking warning (approve exits 0)', async () => {
    const dir = fixture('advisory');
    const mock = await startMockReviewer({ respond: ALWAYS_REFUSE });
    try {
      pointReviewer(dir, mock.endpoint);
      setAspectStatus(dir, 'advisory');
      const r = await runAsync(['approve', '--node', 'services/orders'], dir);
      expect(mock.chatCount()).toBeGreaterThanOrEqual(1); // advisory IS still reviewed
      expect(r.status).toBe(0); // but does not block
    } finally {
      await mock.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('11: --dry-run builds the prompt but never calls the reviewer (zero calls)', async () => {
    const dir = fixture('dry-run');
    const mock = await startMockReviewer({ respond: ALWAYS_OK });
    try {
      pointReviewer(dir, mock.endpoint);
      const r = await runAsync(['approve', '--node', 'services/orders', '--dry-run'], dir);
      expect(mock.chatCount()).toBe(0);
      // dry-run previews the aspect/prompt rather than recording a baseline
      expect(existsSync(baselinePath(dir, 'services/orders'))).toBe(false);
      expect(r.all).toContain('has-doc-comment');
    } finally {
      await mock.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('12: a source edit after approval re-invokes the reviewer on re-approve (drift re-review)', async () => {
    const dir = fixture('drift');
    const mock = await startMockReviewer({ respond: ALWAYS_OK });
    try {
      pointReviewer(dir, mock.endpoint);
      const first = await runAsync(['approve', '--node', 'services/orders'], dir);
      expect(first.status).toBe(0);
      const afterFirst = mock.chatCount();
      expect(afterFirst).toBe(1);
      // Edit the source → drift → re-approve re-runs the reviewer.
      const src = readFileSync(ordersFile(dir), 'utf-8');
      writeFileSync(ordersFile(dir), src + '\nexport const extra = 1;\n', 'utf-8');
      const second = await runAsync(['approve', '--node', 'services/orders'], dir);
      expect(second.status).toBe(0);
      expect(mock.chatCount()).toBeGreaterThan(afterFirst);
    } finally {
      await mock.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('13: the reviewer request carries the configured tier model', async () => {
    const dir = fixture('tier-model');
    const mock = await startMockReviewer({ respond: ALWAYS_OK });
    try {
      pointReviewer(dir, mock.endpoint);
      await runAsync(['approve', '--node', 'services/orders'], dir);
      expect(mock.chatCount()).toBe(1);
      // The lifecycle fixture's `standard` tier sets model qwen2.5-coder:0.5b.
      expect(mock.chatRequests[0].model).toBe('qwen2.5-coder:0.5b');
    } finally {
      await mock.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
