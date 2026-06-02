// In-process mock LLM reviewer for hermetic E2E tests. Speaks the Ollama wire
// protocol the CLI's OllamaProvider expects (src/llm/ollama.ts): GET /api/tags
// (availability), POST /api/show (context window), POST /api/chat (verdict). The
// spawned `yg` child makes real HTTP calls to this server, so the ENTIRE reviewer
// mechanism — request shape, consensus call-count, chunking, prompt construction,
// response parsing, provider-error fallback — is exercised end-to-end and
// deterministically, with no dependency on a real model.
//
// The mock binds to an EPHEMERAL loopback port (never a fixed port number, per the
// test-determinism rule) and captures every /api/chat request for assertions.
//
// IMPORTANT: pair this with runAsync (below), NOT a synchronous spawn. spawnSync
// freezes this process's event loop while the child runs, so the in-process server
// could not answer the child's requests — a deadlock. runAsync uses async spawn so
// the loop stays alive to serve the mock.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// tests/e2e/support -> tests/e2e -> tests -> cli root
const BIN_PATH = path.join(__dirname, '..', '..', '..', 'dist', 'bin.js');

/** A captured POST /api/chat request. `prompt` is the verifier prompt the CLI sent. */
export interface ChatRequest {
  model: string;
  prompt: string;
  body: unknown;
}

/** How the mock answers one /api/chat call. */
export type ChatReply =
  | { satisfied: boolean; reason?: string } // a parseable verdict -> {message:{content:"<json>"}}
  | { httpStatus: number } // a non-200 status (provider-error path)
  | { rawContent: string }; // arbitrary message.content (e.g. malformed JSON)

export interface MockReviewerOptions {
  /** Decide the reply per /api/chat call (receives the request and its 0-based index). Default: always satisfied. */
  respond?: (req: ChatRequest, callIndex: number) => ChatReply;
  /** context_length returned by /api/show (legacy; no longer used for chunking). Default 32768. */
  contextWindow?: number;
  /** Whether /api/tags reports the model available. Default true. */
  available?: boolean;
}

export interface MockReviewer {
  /** http://127.0.0.1:<ephemeral-port> — write this into a tier's `endpoint:`. */
  readonly endpoint: string;
  readonly port: number;
  /** Every /api/chat request received, in arrival order. */
  readonly chatRequests: ChatRequest[];
  chatCount(): number;
  close(): Promise<void>;
}

/** Start an in-process mock reviewer on an ephemeral loopback port. */
export async function startMockReviewer(options: MockReviewerOptions = {}): Promise<MockReviewer> {
  const respond = options.respond ?? ((): ChatReply => ({ satisfied: true, reason: 'mock-approve' }));
  const contextWindow = options.contextWindow ?? 32768;
  const available = options.available ?? true;
  const chatRequests: ChatRequest[] = [];

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
    });
    req.on('end', () => {
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        body = {};
      }
      const json = (status: number, obj: unknown): void => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      if (req.url === '/api/tags') {
        if (available) json(200, { models: [{ name: body.model ?? 'mock' }] });
        else json(503, { error: 'unavailable' });
        return;
      }
      if (req.url === '/api/show') {
        json(200, { model_info: { 'general.context_length': contextWindow } });
        return;
      }
      if (req.url === '/api/chat') {
        const messages = body.messages as Array<{ content?: string }> | undefined;
        const cr: ChatRequest = { model: String(body.model ?? ''), prompt: messages?.[0]?.content ?? '', body };
        const idx = chatRequests.length;
        chatRequests.push(cr);
        const reply = respond(cr, idx);
        if ('httpStatus' in reply) {
          json(reply.httpStatus, { error: 'mock-error' });
          return;
        }
        const content =
          'rawContent' in reply ? reply.rawContent : JSON.stringify({ satisfied: reply.satisfied, reason: reply.reason ?? '' });
        json(200, { message: { content } });
        return;
      }
      json(404, { error: 'not found' });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;

  return {
    endpoint: `http://127.0.0.1:${port}`,
    port,
    chatRequests,
    chatCount: () => chatRequests.length,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

export interface RunResult {
  stdout: string;
  stderr: string;
  status: number | null;
  all: string;
}

/**
 * Spawn `yg` ASYNCHRONOUSLY and resolve on exit. Required when an in-process mock
 * must serve the child during its run (spawnSync would deadlock the event loop).
 */
export function runAsync(args: string[], cwd: string): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn('node', [BIN_PATH, ...args], { cwd });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += String(d);
    });
    child.stderr.on('data', (d) => {
      stderr += String(d);
    });
    child.on('close', (code) => resolve({ stdout, stderr, status: code, all: stdout + stderr }));
  });
}
