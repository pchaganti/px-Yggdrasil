import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extractPortalData } from '../../src/portal/extract.js';
import { emitStatic, renderStaticHtml } from '../../src/portal/serializer.js';
import type { PortalData } from '../../src/portal/contract.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// A REAL fixture project (a real .yggdrasil/ graph + real source) — NO fabricated data.
const FIXTURE_ROOT = path.resolve(__dirname, '../fixtures/portal-basic');

// Task 1.7 — the static emit. Runs the REAL extraction pipeline on a real on-disk fixture
// and feeds its real PortalData output to emitStatic, asserting the produced file is ONE
// self-contained offline HTML document: exactly one <script> carrying the inlined real
// PortalData, no externally-loadable network/CDN reference, and well-formed HTML whose
// embedded JSON round-trips back to the same contract. No mocking; the data is the real
// fixture graph's, and the emit is the real serializer.

const tmpDirs: string[] = [];

afterAll(async () => {
  await Promise.all(tmpDirs.map((d) => rm(d, { recursive: true, force: true })));
});

describe('portal --static emit (self-contained offline page from a real fixture)', () => {
  let data: PortalData;
  let html: string;

  beforeAll(async () => {
    data = await extractPortalData(FIXTURE_ROOT, { writeEnabled: false });
    const dir = await mkdtemp(path.join(tmpdir(), 'yg-portal-static-'));
    tmpDirs.push(dir);
    const outPath = path.join(dir, 'portal.html');
    await emitStatic(data, outPath);
    html = await readFile(outPath, 'utf-8');
  }, 60_000);

  it('produced a real PortalData from the real fixture (sanity — no fabricated data)', () => {
    // The fixture has three nodes (api + two services) and one deterministic aspect.
    expect(data.meta.counts.nodes).toBe(3);
    expect(data.meta.counts.aspects).toBe(1);
    expect(data.nodes.some((n) => n.path === 'api/orders')).toBe(true);
    expect(data.nodes.some((n) => n.path === 'api/users')).toBe(true);
  });

  it('is a single self-contained HTML document', () => {
    expect(html.trimStart().toLowerCase().startsWith('<!doctype html>')).toBe(true);
    // One html / head / body each — a single well-formed document.
    expect(occurrences(html, '<html')).toBe(1);
    expect(occurrences(html, '</html>')).toBe(1);
    expect(occurrences(html, '<head>')).toBe(1);
    expect(occurrences(html, '<body>')).toBe(1);
    expect(occurrences(html, '</body>')).toBe(1);
  });

  it('carries exactly one <script> with the inlined real PortalData, which round-trips', () => {
    const matches = [...html.matchAll(/<script id="portal-data" type="application\/json">([\s\S]*?)<\/script>/g)];
    expect(matches.length).toBe(1);

    // The embedded JSON parses back to the SAME contract the pipeline produced — the data
    // is genuinely inlined, not a placeholder. The serializer escapes <, >, & and the two
    // Unicode line separators for safe <script> embedding; JSON.parse reverses the \uXXXX.
    const parsed = JSON.parse(matches[0][1]) as PortalData;
    expect(parsed.meta.counts.nodes).toBe(data.meta.counts.nodes);
    expect(parsed.nodes.length).toBe(data.nodes.length);
    expect(parsed.nodes.map((n) => n.path).sort()).toEqual(data.nodes.map((n) => n.path).sort());
  });

  it('has NO externally-loadable network / CDN reference on the executable/markup surface (fully offline)', () => {
    // The OFFLINE guarantee is that the browser loads nothing off-origin: no <script src>,
    // no external <link href>, no off-origin CSS url(), no fetch/XHR/WebSocket. (A bare
    // attribution URL inside the vendored library's license COMMENT is provenance, not a
    // load — it is inert and not asserted against.)
    //
    // The proof scans ONLY the executable/markup surface — the inlined JS modules + the
    // HTML/CSS — with the inlined application/json PortalData region PARSED OUT first. The
    // page's real data (node descriptions, source snippets, rule prose, log bodies) can
    // legitimately CONTAIN the literal text "fetch(", a URL, or "url(" — that JSON is inert
    // payload the browser never executes, so greping it would false-positive (or force the
    // assertion to be loosened). We assert no executable network reference in the REMAINDER,
    // keeping the proof strict on the surface that actually runs.
    const surface = stripDataRegion(html);
    for (const re of LOADABLE) {
      expect(surface, `offline violation on executable surface: ${re}`).not.toMatch(re);
    }
  });

  it('the offline proof is strict: a genuine network reference on the code surface still fails', () => {
    // Guard the guard — proving the parse-out did NOT blind the assertion. Inject a real
    // <script src=http> and a fetch('http…') into the EXECUTABLE surface (outside the JSON
    // data region); the stripped-surface scan must still catch both. (The same strings placed
    // only inside the inlined JSON payload are correctly ignored — see the round-trip test.)
    const tampered = html.replace(
      '</body>',
      '<script src="https://cdn.jsdelivr.net/x.js"></script><script>fetch("https://evil.example/x")</script></body>',
    );
    const surface = stripDataRegion(tampered);
    expect(surface).toMatch(/<script[^>]*\ssrc\s*=/i);
    expect(surface).toMatch(/\bfetch\s*\(/i);
    // And a fetch( that exists ONLY inside the JSON data region is correctly NOT on the surface.
    const dataOnly = renderStaticHtml(
      { ...data, nodes: data.nodes.map((n, i) => (i === 0 ? { ...n, description: 'calls fetch("https://api.example/x") internally' } : n)) },
      { shell: '<!doctype html><html><body><script id="portal-data" type="application/json">/* __PORTAL_DATA__ */</script></body></html>', css: '', vendor: '', modules: '' },
    );
    expect(dataOnly).toMatch(/fetch\(/); // present in the whole document (inside the JSON)
    expect(stripDataRegion(dataOnly)).not.toMatch(/\bfetch\s*\(/i); // but NOT on the executable surface
  });

  it('inlines the vendored layout library (no runtime dependency, no CDN)', () => {
    // The vendored d3-hierarchy is inlined verbatim and exposes the d3 global the bootstrap
    // consumes — proving the layout math ships in the page, not from the network.
    expect(html).toContain('d3.hierarchy');
    expect(html).toContain('d3-hierarchy (vendored subset)');
  });

  it('renderStaticHtml is pure over the data + assets (no filesystem needed)', () => {
    // Same data + a fixed asset set → deterministic output, with the data embedded.
    const assets = { shell: '<!doctype html><html><body><script id="portal-data" type="application/json">/* __PORTAL_DATA__ */</script></body></html>', css: '', vendor: '', modules: '' };
    const out = renderStaticHtml(data, assets);
    expect(out).toContain('"nodes"');
    expect(renderStaticHtml(data, assets)).toBe(out);
  });
});

/**
 * The executable/markup network references an offline page must never carry: an off-origin
 * <script src> / <link href>, an off-origin CSS url(), a runtime fetch/XHR/WebSocket/EventSource,
 * or a known CDN host. Asserted against the EXECUTABLE SURFACE only (the JSON data region stripped).
 */
const LOADABLE = [
  /<script[^>]*\ssrc\s*=/i,
  /<link[^>]*\shref\s*=\s*["'](?:https?:)?\/\//i,
  /\bsrc\s*=\s*["'](?:https?:)?\/\//i,
  /url\(\s*["']?(?:https?:)?\/\//i,
  /\bfetch\s*\(/i,
  /\bnew\s+(?:WebSocket|XMLHttpRequest|EventSource)\b/i,
  /\b(?:cdn\.jsdelivr\.net|unpkg\.com|cdnjs\.cloudflare\.com|esm\.sh|skypack\.dev|googleapis\.com|gstatic\.com)\b/i,
] as const;

/**
 * Return the page's executable/markup surface — the inlined JS modules + HTML/CSS — with the
 * inlined `<script id="portal-data" type="application/json">…</script>` DATA region removed. The
 * data is inert payload (the browser parses it as JSON, never executes it), and it legitimately
 * contains arbitrary strings from the graph (URLs, "fetch(", source snippets); leaving it in would
 * false-positive the offline proof. We strip the WHOLE element (open tag through close tag), so the
 * remaining text is exactly the code + markup the browser runs. The strict-guard test proves a real
 * network reference on this surface is still caught after the strip.
 */
function stripDataRegion(html: string): string {
  return html.replace(
    /<script id="portal-data" type="application\/json">[\s\S]*?<\/script>/g,
    '<script id="portal-data" type="application/json"></script>',
  );
}

/** Count non-overlapping occurrences of a literal substring. */
function occurrences(haystack: string, needle: string): number {
  let count = 0;
  let from = 0;
  for (;;) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) break;
    count += 1;
    from = idx + needle.length;
  }
  return count;
}
