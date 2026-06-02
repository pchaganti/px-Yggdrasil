import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { GoogleProvider } from '../../../src/llm/google.js';
import type { LlmConfig } from '../../../src/model/graph.js';

const baseCfg: LlmConfig = {
  provider: 'google', model: 'gemini-2.5-flash', temperature: 0,
  consensus: 1,
};

describe('GoogleProvider', () => {
  beforeEach(() => { delete process.env.GOOGLE_API_KEY; });
  afterEach(() => { delete process.env.GOOGLE_API_KEY; });

  it('constructs with config', () => {
    expect(new GoogleProvider({ ...baseCfg, api_key: 'goog-test' })).toBeDefined();
  });

  it('isAvailable returns true when api_key set', async () => {
    expect(await new GoogleProvider({ ...baseCfg, api_key: 'goog-test' }).isAvailable()).toBe(true);
  });

  it('isAvailable returns false when no api_key', async () => {
    expect(await new GoogleProvider(baseCfg).isAvailable()).toBe(false);
  });

  it('returns fallback on connection failure', async () => {
    const provider = new GoogleProvider({ ...baseCfg, api_key: 'goog-test', endpoint: 'http://localhost:99999' });
    const result = await provider.verifyAspect('test prompt');
    expect(result.satisfied).toBe(false);
  });

  it('sends the api key in the x-goog-api-key header, NOT the URL query string', async () => {
    let capturedUrl = '';
    let capturedHeaders: Record<string, string> = {};
    const fakeFetch = vi.fn(async (url: string, init: RequestInit) => {
      capturedUrl = url;
      capturedHeaders = (init.headers ?? {}) as Record<string, string>;
      return new Response(
        JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"satisfied":true,"reason":"ok"}' }] } }] }),
        { status: 200 },
      );
    });
    vi.stubGlobal('fetch', fakeFetch);
    try {
      const provider = new GoogleProvider({ ...baseCfg, api_key: 'goog-SECRET-123' });
      await provider.verifyAspect('test prompt');
      // The secret must NOT appear in the URL (logged by proxies/CDNs/servers).
      expect(capturedUrl).not.toContain('key=');
      expect(capturedUrl).not.toContain('goog-SECRET-123');
      // It is carried in the header instead.
      expect(capturedHeaders['x-goog-api-key']).toBe('goog-SECRET-123');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
