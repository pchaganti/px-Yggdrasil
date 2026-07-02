import type { IncomingMessage, ServerResponse } from 'node:http';
import { freshPortalData, renderLivePage, readStaticAsset, loadingShell, errorPage } from './page.js';
import { runApproveViaCli, dryRunApproveViaCli } from './approve.js';

/**
 * server/router — maps one HTTP request to one response for the loopback portal server.
 *
 * Routes:
 *   GET  /              → the instant loading shell (no disk access); it boots /render client-side
 *   GET  /render        → the live portal page (fresh PortalData, rendered by the serializer);
 *                         a render failure returns a human-readable HTML error page, not JSON
 *   GET  /data          → Refresh: a fresh, read-only re-extraction of PortalData (JSON)
 *   GET  /static/*      → committed frontend assets (path-safe; 404 outside the asset tree)
 *   GET  /approve/dry-run → the reviewer-call / cost preview (shells the CLI dry-run)
 *   POST /approve       → the ONE write (shells `yg check --approve`); 409 in view-only mode
 *
 * Read-only by default: only POST /approve writes, and only by spawning the CLI. In
 * view-only mode (`writeEnabled: false`) POST /approve is rejected 409 — the page never
 * offers a write the server will not perform.
 */

export interface RouterConfig {
  projectRoot: string;
  /** false in --no-write / view-only mode: POST /approve is rejected 409. */
  writeEnabled: boolean;
}

/** Send a JSON body with a status code. */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(payload);
}

/** Send a plain-text body with a status code. */
function sendText(res: ServerResponse, status: number, contentType: string, body: string): void {
  res.writeHead(status, { 'content-type': contentType });
  res.end(body);
}

/** Read and JSON-parse a request body (best-effort; `{}` on empty / invalid). */
async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf-8').trim();
  if (text.length === 0) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Handle one request. Pure dispatch over method + pathname; all engine access is via the
 * portal's own modules (page → pipeline/serializer; approve → spawned CLI). Any handler
 * error is surfaced as a 500 with a structured message so a failure is never a silent 200.
 */
export async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  config: RouterConfig,
): Promise<void> {
  const method = req.method ?? 'GET';
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const pathname = url.pathname;

  try {
    if (method === 'GET' && pathname === '/') {
      // The instant loading shell — no graph access, so the browser paints immediately
      // instead of staring at a blank page while the whole extraction + render runs. The
      // shell fetches /render and swaps it in (URL stays / → the opened hash route survives).
      sendText(res, 200, 'text/html; charset=utf-8', loadingShell());
      return;
    }

    if (method === 'GET' && pathname === '/render') {
      // The heavy page: fresh PortalData → rendered HTML. A failure here reaches a person
      // (the shell swaps this response into the document), so surface a readable HTML error
      // page, never the raw JSON blob the generic 500 handler would emit for an API route.
      try {
        const data = await freshPortalData(config.projectRoot, config.writeEnabled);
        const html = await renderLivePage(data);
        sendText(res, 200, 'text/html; charset=utf-8', html);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        sendText(res, 500, 'text/html; charset=utf-8', errorPage(message));
      }
      return;
    }

    if (method === 'GET' && pathname === '/data') {
      // Refresh: re-extract fresh, persist nothing.
      const data = await freshPortalData(config.projectRoot, config.writeEnabled);
      sendJson(res, 200, data);
      return;
    }

    if (method === 'GET' && pathname.startsWith('/static/')) {
      const rel = pathname.slice('/static/'.length);
      const asset = await readStaticAsset(rel);
      if (!asset) {
        sendJson(res, 404, { error: 'not-found', path: pathname });
        return;
      }
      res.writeHead(200, { 'content-type': asset.contentType });
      res.end(asset.content);
      return;
    }

    if (method === 'GET' && pathname === '/approve/dry-run') {
      const llm = url.searchParams.get('llm') !== 'false';
      const preview = await dryRunApproveViaCli(config.projectRoot, llm);
      sendJson(res, 200, preview);
      return;
    }

    if (method === 'POST' && pathname === '/approve') {
      if (!config.writeEnabled) {
        sendJson(res, 409, {
          error: 'view-only',
          message: 'This portal runs in view-only mode (--no-write); the Approve write action is disabled.',
        });
        return;
      }
      const body = await readJsonBody(req);
      // Default the LLM checkbox to ON, matching the CLI's full --approve; llm:false is the free path.
      const llm = body.llm !== false;
      const result = await runApproveViaCli(config.projectRoot, llm);
      sendJson(res, 200, {
        ok: result.exitCode === 0,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
      });
      return;
    }

    sendJson(res, 404, { error: 'not-found', method, path: pathname });
  } catch (err) {
    // The raw error can carry internal detail — filesystem paths, stack frames. That belongs
    // to whoever runs the portal, not on the HTTP response: even though the server is loopback
    // only, on a shared host the loopback address is reachable by other local accounts. Write
    // the full reason to the terminal running the portal (visible only to the process owner)
    // and return a generic message to the client. The `yg check` guidance points the operator
    // there for the real cause.
    const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
    process.stderr.write(`[portal] request handler error (${method} ${pathname}): ${detail}\n`);
    sendJson(res, 500, {
      error: 'internal',
      message: 'The portal hit an internal error. Check the terminal running the portal for details.',
    });
  }
}
