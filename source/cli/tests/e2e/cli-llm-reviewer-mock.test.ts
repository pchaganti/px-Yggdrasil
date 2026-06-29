// Hermetic E2E — the LLM REVIEWER MECHANICS, exercised end-to-end against the real
// spawned binary with an in-process mock that speaks the Ollama protocol (see
// support/mock-reviewer.ts). The mock plays the reviewer's role deterministically, so
// what is under test here is YGGDRASIL's machinery — request shape, consensus call
// count and majority aggregation, tier/model selection, response parsing, the
// provider-error fallback, prompt construction, and how an LLM verdict drives the
// fill (`yg check --approve`), the lock, and `yg check` — NOT any model's judgment.
// No network, no Ollama, runs in CI.
//
// Verification happens at FILL time: `yg check --approve` runs deterministic checks
// first (zero cost), then dispatches one reviewer call per LLM pair (×consensus). The
// fill is repo-wide — it fills EVERY unverified pair, so the e2e-lifecycle fixture's
// single enforced LLM aspect (has-doc-comment) on its TWO service nodes (orders,
// payments) means 2 reviewer calls at consensus 1, 6 at consensus 3.
//
// Uses async spawn (runAsync) so this process's event loop stays alive to serve the
// mock while the child `yg` makes its HTTP calls (spawnSync would deadlock).

import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, rmSync, cpSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockReviewer, runAsync, type ChatReply, type ChatRequest } from './support/mock-reviewer.js';
import { readLock } from './support/read-lock.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '..', '..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'e2e-lifecycle');
const distExists = existsSync(BIN_PATH);

const cfgPath = (dir: string) => path.join(dir, '.yggdrasil', 'yg-config.yaml');
const aspectYaml = (dir: string) => path.join(dir, '.yggdrasil', 'aspects', 'has-doc-comment', 'yg-aspect.yaml');
const ordersFile = (dir: string) => path.join(dir, 'src', 'services', 'orders.ts');
const yggDir = (dir: string) => path.join(dir, '.yggdrasil');
// The 5.1.0 triad: LLM verdicts live in the committed nondeterministic file; readLock
// merges the three on-disk files back into one { version, verdicts, nodes } view.
const nondetLockPath = (dir: string) => path.join(dir, '.yggdrasil', 'yg-lock.nondeterministic.json');

/** Fresh temp copy of the lifecycle fixture (both service nodes carry the enforced LLM aspect has-doc-comment). */
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
  it('1: an LLM-aspect APPROVE verdict from the reviewer is recorded in the lock and the fill exits 0', async () => {
    const dir = fixture('approve');
    const mock = await startMockReviewer({ respond: ALWAYS_OK });
    try {
      pointReviewer(dir, mock.endpoint);
      const r = await runAsync(['check', '--approve'], dir);
      expect(r.status).toBe(0);
      expect(r.all).toContain('yg check: PASS');
      // The verdict is written to the lock with an approved entry.
      const lock = readLock(yggDir(dir));
      expect(lock.verdicts['has-doc-comment']['node:services/orders'].verdict).toBe('approved');
      // One enforced LLM aspect (has-doc-comment) at consensus 1 across the TWO
      // service nodes → two /api/chat calls.
      expect(mock.chatCount()).toBe(2);
    } finally {
      await mock.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('2: an LLM-aspect REFUSE verdict blocks the fill (exit 1) and the cached refusal surfaces the reviewer reason', async () => {
    const dir = fixture('refuse');
    const mock = await startMockReviewer({ respond: ALWAYS_REFUSE });
    try {
      pointReviewer(dir, mock.endpoint);
      const r = await runAsync(['check', '--approve'], dir);
      expect(r.status).toBe(1);
      expect(r.all).toContain('[llm] has-doc-comment on node:services/orders — refused');
      expect(mock.chatCount()).toBe(2);

      // Plain `yg check` renders the cached refusal WITHOUT re-calling the reviewer.
      const before = mock.chatCount();
      const check = await runAsync(['check'], dir);
      expect(check.status).toBe(1);
      expect(check.all).toContain('enforced');
      expect(check.all).toContain('has-doc-comment');
      // The cached refusal renders as an `enforced` group for the aspect; the group
      // header (the old "...cached verdict — the reviewer did NOT re-run..." what
      // line 0) is no longer a per-issue line. The member node line carries the
      // retained refusal detail (refusals are a FULL_WHAT code) — the reviewer reason.
      expect(check.all).toContain("aspect 'has-doc-comment'");
      expect(check.all).toContain('- services/orders  Reviewer reason: the file has no leading comment');
      // The reviewer's reason is folded into the stored verdict (asserted directly
      // against the lock — the `yg check` renderer prints only the first `what`
      // line; `yg aspect-test` would print the full body).
      const lock = readLock(yggDir(dir));
      expect(lock.verdicts['has-doc-comment']['node:services/orders'].reason).toBe('the file has no leading comment');
      expect(mock.chatCount()).toBe(before); // check did not call the reviewer

      // A SECOND fill makes ZERO new calls — the cached refusal is final for
      // identical inputs.
      const fill2 = await runAsync(['check', '--approve'], dir);
      expect(fill2.status).toBe(1);
      expect(mock.chatCount() - before).toBe(0);
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
      await runAsync(['check', '--approve'], dir);
      expect(mock.chatCount()).toBe(2);
      const prompt = mock.chatRequests.map((c) => c.prompt).join('\n');
      expect(prompt).toContain('has-doc-comment'); // aspect id
      expect(prompt).toContain('Every source file must begin with a comment.'); // content.md
      expect(prompt).toContain('services/orders'); // node path
      expect(prompt).toContain('orders.ts'); // a mapped source file name
    } finally {
      await mock.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('4: consensus N issues exactly N reviewer calls per LLM pair', async () => {
    const dir = fixture('consensus-count');
    const mock = await startMockReviewer({ respond: ALWAYS_OK });
    try {
      pointReviewer(dir, mock.endpoint);
      setConsensus(dir, 3);
      const r = await runAsync(['check', '--approve'], dir);
      expect(r.status).toBe(0);
      // One LLM aspect × two service nodes × consensus 3 = 6 calls.
      expect(mock.chatCount()).toBe(6);
    } finally {
      await mock.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('5: consensus majority SATISFIED (split 2-1) approves the pair', async () => {
    const dir = fixture('consensus-majority-ok');
    // For EACH pair the 3 votes are: refuse, satisfy, satisfy → 2 > 1 → approved.
    const mock = await startMockReviewer({
      respond: (_r, i) => (i % 3 === 0 ? { satisfied: false, reason: 'no' } : { satisfied: true, reason: 'ok' }),
    });
    try {
      pointReviewer(dir, mock.endpoint);
      setConsensus(dir, 3);
      const r = await runAsync(['check', '--approve'], dir);
      expect(mock.chatCount()).toBe(6);
      expect(r.status).toBe(0);
    } finally {
      await mock.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('6: consensus majority NOT-SATISFIED (split 1-2) refuses the pair', async () => {
    const dir = fixture('consensus-majority-refuse');
    // For EACH pair the 3 votes are: satisfy, refuse, refuse → 1 < 2 → refused.
    const mock = await startMockReviewer({
      respond: (_r, i) => (i % 3 === 0 ? { satisfied: true, reason: 'ok' } : { satisfied: false, reason: 'majority says no comment' }),
    });
    try {
      pointReviewer(dir, mock.endpoint);
      setConsensus(dir, 3);
      const r = await runAsync(['check', '--approve'], dir);
      expect(mock.chatCount()).toBe(6);
      expect(r.status).toBe(1);
      expect(r.all).toContain('[llm] has-doc-comment on node:services/orders — refused');
    } finally {
      await mock.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('7: a non-200 from the provider becomes a fail-closed infra error that blocks the fill', async () => {
    const dir = fixture('provider-error');
    const mock = await startMockReviewer({ respond: () => ({ httpStatus: 500 }) });
    try {
      pointReviewer(dir, mock.endpoint);
      const r = await runAsync(['check', '--approve'], dir);
      expect(mock.chatCount()).toBeGreaterThanOrEqual(1);
      expect(r.status).toBe(1);
      expect(r.all).toContain('has-doc-comment');
      expect(r.all).toContain('pairs failed on provider/config errors');
      // Fail-closed: NOTHING written for the failed pair — it stays unverified.
      // The failed LLM aspect's verdict namespace must be absent from the lock (the
      // committed nondeterministic file is where this pair WOULD have landed).
      expect(readLock(yggDir(dir)).verdicts['has-doc-comment']).toBeUndefined();
    } finally {
      await mock.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('8: a malformed (unparseable) reviewer response becomes a fail-closed infra error (exit 1)', async () => {
    const dir = fixture('malformed');
    const mock = await startMockReviewer({ respond: () => ({ rawContent: 'not json at all {{{' }) });
    try {
      pointReviewer(dir, mock.endpoint);
      const r = await runAsync(['check', '--approve'], dir);
      expect(mock.chatCount()).toBeGreaterThanOrEqual(1);
      expect(r.status).toBe(1);
      expect(r.all).toContain('pairs failed on provider/config errors');
    } finally {
      await mock.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('9: a DRAFT LLM aspect is never sent to the reviewer (zero calls), the fill exits 0', async () => {
    const dir = fixture('draft');
    const mock = await startMockReviewer({ respond: ALWAYS_REFUSE });
    try {
      pointReviewer(dir, mock.endpoint);
      setAspectStatus(dir, 'draft');
      const r = await runAsync(['check', '--approve'], dir);
      expect(mock.chatCount()).toBe(0); // reviewer skipped for draft
      expect(r.status).toBe(0);
      // The remaining deterministic aspects still fill — only the LLM aspect is dormant.
      expect(r.all).toContain('0 reviewer calls (consensus included)');
    } finally {
      await mock.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('10: an ADVISORY LLM aspect refusal is a non-blocking warning (the fill exits 0)', async () => {
    const dir = fixture('advisory');
    const mock = await startMockReviewer({ respond: ALWAYS_REFUSE });
    try {
      pointReviewer(dir, mock.endpoint);
      setAspectStatus(dir, 'advisory');
      const r = await runAsync(['check', '--approve'], dir);
      expect(mock.chatCount()).toBeGreaterThanOrEqual(1); // advisory IS still reviewed
      expect(r.status).toBe(0); // but does not block
      expect(r.all).toContain('[llm] has-doc-comment on node:services/orders — refused');
      // The advisory refusal renders as a non-blocking warning in the subsequent check.
      const check = await runAsync(['check'], dir);
      expect(check.status).toBe(0);
      expect(check.all).toContain('advisory');
    } finally {
      await mock.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('11: aspect-test --dry-run builds the prompt but never calls the reviewer (zero calls, lock untouched)', async () => {
    const dir = fixture('dry-run');
    const mock = await startMockReviewer({ respond: ALWAYS_OK });
    try {
      pointReviewer(dir, mock.endpoint);
      const r = await runAsync(['aspect-test', '--aspect', 'has-doc-comment', '--node', 'services/orders', '--dry-run'], dir);
      expect(r.status).toBe(0);
      expect(mock.chatCount()).toBe(0);
      // dry-run previews the assembled prompt rather than recording a verdict.
      expect(r.all).toContain('=== prompt for node:services/orders ===');
      expect(r.all).toContain('has-doc-comment');
      // diagnostic only — the lock is never written.
      expect(r.all).toContain('diagnostic only — lock unchanged');
      // No LLM verdict is recorded: the committed nondeterministic lock file (where this
      // pair's verdict would land) is never written by a dry-run.
      expect(existsSync(nondetLockPath(dir))).toBe(false);
      expect(readLock(yggDir(dir)).verdicts['has-doc-comment']).toBeUndefined();
    } finally {
      await mock.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('12: a source edit after a verified fill re-invokes the reviewer on the next fill (re-review)', async () => {
    const dir = fixture('reverify');
    const mock = await startMockReviewer({ respond: ALWAYS_OK });
    try {
      pointReviewer(dir, mock.endpoint);
      const first = await runAsync(['check', '--approve'], dir);
      expect(first.status).toBe(0);
      const afterFirst = mock.chatCount();
      expect(afterFirst).toBe(2);
      // Edit the orders source → its pair is unverified → the next fill re-runs the
      // reviewer for that pair (payments stays valid, so only one new call).
      const src = readFileSync(ordersFile(dir), 'utf-8');
      writeFileSync(ordersFile(dir), src + '\nexport const extra = 1;\n', 'utf-8');
      const second = await runAsync(['check', '--approve'], dir);
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
      await runAsync(['check', '--approve'], dir);
      expect(mock.chatCount()).toBe(2);
      // The lifecycle fixture's `standard` tier sets model qwen2.5-coder:0.5b.
      expect(mock.chatRequests[0].model).toBe('qwen2.5-coder:0.5b');
    } finally {
      await mock.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
