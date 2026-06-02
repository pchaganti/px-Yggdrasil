// Hermetic E2E — further LLM REVIEWER mechanics via the in-process mock (see
// support/mock-reviewer.ts and cli-llm-reviewer-mock.test.ts). Covers the paths the
// first mock suite does not: prompt chunking by token budget, a node mixing a
// deterministic and an LLM aspect (only the LLM one calls the reviewer), several LLM
// aspects each consuming consensus calls, the 429 retry, and how a refused LLM verdict
// renders in `yg check` (advisory warning vs enforced error). All deterministic, in CI.

import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, rmSync, cpSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
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
const ordersNodeYaml = (dir: string) => path.join(dir, '.yggdrasil', 'model', 'services', 'orders', 'yg-node.yaml');

function fixture(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-llmmockx-${label}-`));
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

function pointReviewer(dir: string, endpoint: string): void {
  const p = cfgPath(dir);
  writeFileSync(p, readFileSync(p, 'utf-8').replace(/endpoint:\s*["']?[^"'\n]+["']?/, `endpoint: "${endpoint}"`), 'utf-8');
}

const ALWAYS_OK: () => ChatReply = () => ({ satisfied: true, reason: 'ok' });

describe.skipIf(!distExists)('CLI E2E — LLM reviewer mechanics via mock (extended)', () => {
  it('1: a large node with multiple source files sends exactly ONE reviewer call per LLM aspect (no chunking)', async () => {
    const dir = fixture('no-chunk');
    // Chunking has been removed. The size gate (max_node_chars) is the sole
    // guarantee a node fits one prompt — no matter the total source size below
    // that gate, the reviewer is called exactly once per LLM aspect.
    const mock = await startMockReviewer({ respond: ALWAYS_OK });
    try {
      pointReviewer(dir, mock.endpoint);
      // Add two large source files (~4000 chars each, still well under the
      // 40000-char max_node_chars gate) so the former chunking logic would
      // have produced multiple calls — verifying that it no longer does.
      const big = (tag: string) => `// ${tag}\nexport const ${tag} = ${JSON.stringify('x'.repeat(4000))};\n`;
      writeFileSync(path.join(dir, 'src', 'services', 'big1.ts'), big('big1'), 'utf-8');
      writeFileSync(path.join(dir, 'src', 'services', 'big2.ts'), big('big2'), 'utf-8');
      writeFileSync(
        ordersNodeYaml(dir),
        [
          'name: OrdersService',
          'description: Creates and retrieves customer orders.',
          'type: service',
          'mapping:',
          '  - src/services/orders.ts',
          '  - src/services/big1.ts',
          '  - src/services/big2.ts',
          '',
        ].join('\n'),
        'utf-8',
      );
      const r = await runAsync(['approve', '--node', 'services/orders'], dir);
      expect(r.status).toBe(0);
      // One LLM aspect (has-doc-comment) at consensus 1 → exactly ONE reviewer call.
      expect(mock.chatCount()).toBe(1);
      // The single prompt contains ALL source files.
      const prompt = mock.chatRequests[0].prompt;
      expect(prompt).toContain('big1');
      expect(prompt).toContain('big2');
    } finally {
      await mock.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('2: a node mixing a deterministic and an LLM aspect calls the reviewer only for the LLM aspect', async () => {
    const dir = fixture('mixed');
    const mock = await startMockReviewer({ respond: ALWAYS_OK });
    try {
      pointReviewer(dir, mock.endpoint);
      // The service type already carries deterministic aspects (no-todo-comments,
      // requires-named-export) AND the LLM has-doc-comment. A clean approve runs the
      // deterministic checks locally and issues exactly ONE reviewer call.
      const r = await runAsync(['approve', '--node', 'services/orders'], dir);
      expect(r.status).toBe(0);
      expect(mock.chatCount()).toBe(1);
      // The single reviewer call is for the LLM aspect, not the deterministic ones.
      expect(mock.chatRequests[0].prompt).toContain('has-doc-comment');
      expect(mock.chatRequests[0].prompt).not.toContain('no-todo-comments');
    } finally {
      await mock.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('3: two LLM aspects on one node each issue their own reviewer call', async () => {
    const dir = fixture('two-llm');
    const mock = await startMockReviewer({ respond: ALWAYS_OK });
    try {
      pointReviewer(dir, mock.endpoint);
      // Author a second LLM aspect and attach it to the orders node directly.
      const aspDir = path.join(dir, '.yggdrasil', 'aspects', 'second-llm');
      mkdirSync(aspDir, { recursive: true });
      writeFileSync(path.join(aspDir, 'yg-aspect.yaml'), 'name: SecondLlm\ndescription: A second LLM rule.\nreviewer:\n  type: llm\nstatus: enforced\n', 'utf-8');
      writeFileSync(path.join(aspDir, 'content.md'), 'The file must be reasonable.\n', 'utf-8');
      writeFileSync(
        ordersNodeYaml(dir),
        [
          'name: OrdersService',
          'description: Creates and retrieves customer orders.',
          'type: service',
          'aspects:',
          '  - second-llm',
          'mapping:',
          '  - src/services/orders.ts',
          '',
        ].join('\n'),
        'utf-8',
      );
      const r = await runAsync(['approve', '--node', 'services/orders'], dir);
      expect(r.status).toBe(0);
      // has-doc-comment (type default) + second-llm (own) = two LLM aspects, one call each.
      expect(mock.chatCount()).toBe(2);
      const prompts = mock.chatRequests.map((c) => c.prompt).join('\n');
      expect(prompts).toContain('has-doc-comment');
      expect(prompts).toContain('second-llm');
    } finally {
      await mock.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('4: a 429 is retried once and then succeeds (two requests, approve passes)', async () => {
    const dir = fixture('retry');
    // First chat call returns 429, the retry returns a verdict.
    const mock = await startMockReviewer({
      respond: (_r, i) => (i === 0 ? { httpStatus: 429 } : { satisfied: true, reason: 'ok after retry' }),
    });
    try {
      pointReviewer(dir, mock.endpoint);
      const r = await runAsync(['approve', '--node', 'services/orders'], dir);
      expect(r.status).toBe(0);
      // apiFetch retries once on 429 → two requests for the one consensus vote.
      expect(mock.chatCount()).toBe(2);
    } finally {
      await mock.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('5: a refused ENFORCED LLM verdict renders as a blocking error in yg check', async () => {
    const dir = fixture('check-enforced');
    const mock = await startMockReviewer({ respond: () => ({ satisfied: false, reason: 'missing the file comment' }) });
    try {
      pointReviewer(dir, mock.endpoint);
      // Approve BOTH service nodes (both carry the enforced LLM aspect) so the only
      // check findings are the recorded verdicts, not an unapproved sibling.
      const approve = await runAsync(['approve', '--node', 'services/orders'], dir);
      expect(approve.status).toBe(1); // refused enforced verdict
      await runAsync(['approve', '--node', 'services/payments'], dir);
      // yg check renders the stored refused enforced verdict as a blocking error
      // WITHOUT re-calling the reviewer.
      const before = mock.chatCount();
      const check = await runAsync(['check'], dir);
      expect(check.status).toBe(1);
      expect(check.all).toContain('has-doc-comment');
      expect(check.all).toContain('enforced');
      expect(mock.chatCount()).toBe(before); // check does not call the reviewer
    } finally {
      await mock.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('6: a refused ADVISORY LLM verdict renders as a non-blocking warning in yg check (exit 0)', async () => {
    const dir = fixture('check-advisory');
    const mock = await startMockReviewer({ respond: () => ({ satisfied: false, reason: 'advisory: no comment' }) });
    try {
      pointReviewer(dir, mock.endpoint);
      // Flip has-doc-comment to advisory.
      const aspPath = path.join(dir, '.yggdrasil', 'aspects', 'has-doc-comment', 'yg-aspect.yaml');
      writeFileSync(aspPath, readFileSync(aspPath, 'utf-8').replace(/status:\s*\w+/, 'status: advisory'), 'utf-8');
      // Advisory refusal does not block approve (exit 0) but records the verdict.
      // Approve both service nodes so no unapproved sibling forces a check failure.
      const approve = await runAsync(['approve', '--node', 'services/orders'], dir);
      expect(approve.status).toBe(0);
      expect(approve.all).toContain('not blocking');
      await runAsync(['approve', '--node', 'services/payments'], dir);
      // yg check renders the advisory violations as non-blocking warnings (exit 0).
      const check = await runAsync(['check'], dir);
      expect(check.status).toBe(0);
      expect(check.all).toContain('has-doc-comment');
      expect(check.all.toLowerCase()).toContain('advisory');
    } finally {
      await mock.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
