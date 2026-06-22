import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { LlmConfig } from '../../../src/model/graph.js';

// Integration coverage for the 5.2.1 raw-response logging: it must work through
// the REAL OllamaProvider, not just the parseAspectResponse unit. The runFill
// tests mock the createLlmProvider factory (the provider returns a ready-made
// AspectResponse), so they never reach parseAspectResponse where the logging
// lives. Here we drive the genuine provider and stub only the HTTP layer
// (api-utils.apiFetch), so the chain verifyAspect → parseAspectResponse →
// debugWrite → .debug.log is exercised end to end.
const stub = vi.hoisted(() => ({ ok: true, content: '' }));
vi.mock('../../../src/llm/api-utils.js', () => ({
  apiFetch: vi.fn(async () => ({
    ok: stub.ok,
    status: stub.ok ? 200 : 500,
    statusText: stub.ok ? 'OK' : 'ERR',
    json: async () => ({ message: { content: stub.content } }),
  })),
}));

import { OllamaProvider } from '../../../src/llm/ollama.js';
import { initDebugLog, _resetForTesting } from '../../../src/utils/debug-log.js';

const cfg: LlmConfig = { provider: 'ollama', model: 'test-model', temperature: 0, consensus: 1 };

describe('OllamaProvider — raw-response debug logging (integration)', () => {
  let tmpDir: string;

  function appendFn(filePath: string, text: string): void {
    appendFileSync(filePath, text, 'utf-8');
  }
  function logContent(): string {
    return readFileSync(path.join(tmpDir, '.debug.log'), 'utf-8');
  }

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'yg-ollama-'));
    stub.ok = true;
  });

  afterEach(() => {
    _resetForTesting();
    rmSync(tmpDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('writes the raw reply to .debug.log when the model content cannot be parsed', async () => {
    stub.content = 'THINKING-WRAPPER-NO-VERDICT lots of reasoning, no json object anywhere';
    initDebugLog(tmpDir, true, appendFn);
    const result = await new OllamaProvider(cfg).verifyAspect('prompt');
    expect(result.satisfied).toBe(false);
    expect(result.errorSource).toBe('provider');
    expect(logContent()).toContain('THINKING-WRAPPER-NO-VERDICT lots of reasoning, no json object anywhere');
  });

  it('notes an empty reply (thinking model emitted no content)', async () => {
    stub.content = '';
    initDebugLog(tmpDir, true, appendFn);
    const result = await new OllamaProvider(cfg).verifyAspect('prompt');
    expect(result.errorSource).toBe('provider');
    expect(logContent()).toContain('empty');
  });

  it('does NOT write the raw reply when the model returns a valid verdict', async () => {
    stub.content = '{"satisfied": true, "reason": "UNIQUE-OK-INTEG"}';
    initDebugLog(tmpDir, true, appendFn);
    const result = await new OllamaProvider(cfg).verifyAspect('prompt');
    expect(result.satisfied).toBe(true);
    expect(logContent()).not.toContain('UNIQUE-OK-INTEG');
  });
});
