import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Public-surface E2E for `yg portal --static`. Spawns the built dist/bin.js against a REAL
// fixture project (a real .yggdrasil/ graph + real source) and asserts the emitted page is
// a single self-contained offline file. No src/** import (e2e-public-surface aspect): the
// only inputs are the spawned CLI and the committed file it wrote.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const FIXTURE_ROOT = path.join(CLI_ROOT, 'tests', 'fixtures', 'portal-basic');

const distExists = existsSync(BIN_PATH);

const tmpDirs: string[] = [];

afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

function runPortalStatic(outPath: string): { stdout: string; stderr: string; status: number | null } {
  // --open is NOT passed: no browser is ever launched in a test.
  const result = spawnSync('node', [BIN_PATH, 'portal', '--static', '--out', outPath], {
    cwd: FIXTURE_ROOT,
    encoding: 'utf-8',
  });
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', status: result.status };
}

describe.skipIf(!distExists)('CLI E2E — yg portal --static (self-contained offline emit)', () => {
  let html: string;
  let outPath: string;
  let runStatus: number | null;
  let runStdout: string;

  beforeAll(() => {
    const dir = mkdtempSync(path.join(tmpdir(), 'yg-portal-e2e-'));
    tmpDirs.push(dir);
    outPath = path.join(dir, 'portal.html');
    const run = runPortalStatic(outPath);
    runStatus = run.status;
    runStdout = run.stdout;
    html = existsSync(outPath) ? readFileSync(outPath, 'utf-8') : '';
  });

  it('exits 0 and prints the written path', () => {
    expect(runStatus).toBe(0);
    expect(runStdout).toContain(outPath);
    expect(existsSync(outPath)).toBe(true);
  });

  it('emitted a single self-contained HTML document', () => {
    expect(html.trimStart().toLowerCase().startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('</html>');
    expect((html.match(/<script id="portal-data" type="application\/json">/g) ?? []).length).toBe(1);
  });

  it('inlined the real fixture PortalData (no fabricated data) which round-trips', () => {
    const m = html.match(/<script id="portal-data" type="application\/json">([\s\S]*?)<\/script>/);
    expect(m).not.toBeNull();
    const data = JSON.parse((m as RegExpMatchArray)[1]);
    expect(data.meta.counts.nodes).toBe(3);
    const paths = data.nodes.map((n: { path: string }) => n.path);
    expect(paths).toContain('api/orders');
    expect(paths).toContain('api/users');
  });

  it('has no externally-loadable network / CDN reference (fully offline)', () => {
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

  it('inlined the vendored layout library', () => {
    expect(html).toContain('d3.hierarchy');
  });

  it('lists the loopback server + static options on --help (server covered by the server E2E)', () => {
    // Plain `yg portal` now starts a foreground loopback server (covered end-to-end in
    // cli-portal-server.test.ts); spawning it here would block, so we assert the option
    // surface instead — --static and the server flags are all present and documented.
    const result = spawnSync('node', [BIN_PATH, 'portal', '--help'], { cwd: FIXTURE_ROOT, encoding: 'utf-8' });
    expect(result.status).toBe(0);
    const help = (result.stdout ?? '') + (result.stderr ?? '');
    expect(help).toMatch(/--static/);
    expect(help).toMatch(/--port/);
    expect(help).toMatch(/--no-write/);
  });
});
