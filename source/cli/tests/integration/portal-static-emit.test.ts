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

  it('has NO externally-loadable network / CDN reference (fully offline)', () => {
    // The OFFLINE guarantee is that the browser loads nothing off-origin: no <script src>,
    // no external <link href>, no off-origin CSS url(), no fetch/XHR/WebSocket. (A bare
    // attribution URL inside the vendored library's license COMMENT is provenance, not a
    // load — it is inert and not asserted against.)
    const loadable = [
      /<script[^>]*\ssrc\s*=/i,
      /<link[^>]*\shref\s*=\s*["'](?:https?:)?\/\//i,
      /\bsrc\s*=\s*["'](?:https?:)?\/\//i,
      /url\(\s*["']?(?:https?:)?\/\//i,
      /\bfetch\s*\(/i,
      /\bnew\s+(?:WebSocket|XMLHttpRequest|EventSource)\b/i,
      /\b(?:cdn\.jsdelivr\.net|unpkg\.com|cdnjs\.cloudflare\.com|esm\.sh|skypack\.dev|googleapis\.com|gstatic\.com)\b/i,
    ];
    for (const re of loadable) {
      expect(html, `offline violation: ${re}`).not.toMatch(re);
    }
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
