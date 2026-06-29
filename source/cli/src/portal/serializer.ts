import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { atomicWriteFile } from '../io/atomic-write.js';
import type { PortalData } from './contract.js';

/**
 * The static-emit serializer — turns one PortalData into ONE self-contained HTML file.
 *
 * Per the drift-fix (§0.5), the JSON.stringify-the-whole-PortalData seam lives HERE, on a
 * covered portal-pipeline node (the serializer), not on the command. It reads the shell
 * template plus the vendored layout library, the CSS, and the bootstrap JS, inlines all of
 * them and `JSON.stringify(data)`, and writes one file with NO network/CDN reference — the
 * page is fully offline. Read-only over the templates; the only write is the output file
 * (atomic).
 *
 * The frontend assets are committed under templates/portal/ and copied verbatim into
 * dist/templates/portal/ at build time, so they resolve next to the running bundle.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Locate the templates/portal directory next to the running bundle (dist/) or in src during tests. */
function portalTemplateDir(): string {
  // Published / built: dist/bin.js → dist/templates/portal.
  const distDir = path.resolve(__dirname, 'templates', 'portal');
  if (existsSync(distDir)) return distDir;
  // Test / dev fallback: running from src (vitest) → src/templates/portal.
  const srcDir = path.resolve(__dirname, '..', 'templates', 'portal');
  if (existsSync(srcDir)) return srcDir;
  // tsup bundles serializer.ts into dist/bin.js, so __dirname is dist/. As a final
  // fallback try one level up (dist/.. → package root + dist/templates).
  return path.resolve(__dirname, '..', 'dist', 'templates', 'portal');
}

interface PortalAssets {
  shell: string;
  css: string;
  vendor: string;
  /** Every frontend module, concatenated in dependency order (bootstrap last). */
  modules: string;
}

/**
 * The frontend modules, inlined IN ORDER. There is no module system on a single offline
 * page, so each file attaches to the shared `window.YgPortal` global and they are
 * concatenated as a plain script sequence: the namespace first, then the leaf modules, then
 * the shell/dispatch that consume them, and the bootstrap LAST (it orchestrates the rest).
 * Adding a module = adding its path here in the right position.
 */
const MODULE_ORDER = [
  'js/namespace.js',
  'js/state-model.js',
  'js/glossary.js',
  'js/router.js',
  'js/palette.js',
  'js/palette-overlay.js',
  'js/consumer.js',
  'js/export.js',
  'js/tree.js',
  'js/shell.js',
  'js/dispatch.js',
  // Per-surface view modules — registered onto Yg.views, consumed by the dispatcher. The
  // matrix module precedes the relations view that calls Yg.matrix; the panel module is read
  // by the bootstrap's panel slot. All before the bootstrap, which orchestrates the rest.
  'js/views/overview-view.js',
  'js/views/coverage-view.js',
  'js/views/tree-view.js',
  'js/views/relations-matrix.js',
  'js/views/relations-view.js',
  'js/views/rulebook-view.js',
  'js/views/types-view.js',
  'js/views/flows-view.js',
  'js/views/suppressions-view.js',
  'js/views/start-view.js',
  'js/views/panel-view.js',
  'js/bootstrap.js',
];

/**
 * The stylesheets, inlined IN ORDER (tokens → shell → components). Splitting the CSS into
 * focused files keeps each under the focused-file-size cap; the cascade order is preserved
 * here so the tokens are defined before the rules that reference them.
 */
const CSS_ORDER = [
  'tokens.css',
  'shell.css',
  'app.css',
  'views.css',
  'views-audit.css',
  'views-panel.css',
  'views-relations.css',
  'views-rulebook.css',
  'views-flows.css',
  'views-start.css',
];

/** Read the frontend assets the static page inlines (shell, css, vendor lib, and modules). */
async function readAssets(): Promise<PortalAssets> {
  const dir = portalTemplateDir();
  const read = (rel: string): Promise<string> => readFile(path.join(dir, rel), 'utf-8');
  const [shell, vendor] = await Promise.all([read('shell.html'), read('vendor/d3-hierarchy.js')]);
  const cssSources = await Promise.all(CSS_ORDER.map((rel) => read(rel)));
  const css = cssSources.join('\n');
  const moduleSources = await Promise.all(MODULE_ORDER.map((rel) => read(rel)));
  // Separate each module with a newline so a file ending without one cannot fuse into the
  // next module's first line.
  const modules = moduleSources.join('\n');
  return { shell, css, vendor, modules };
}

/**
 * Render the self-contained HTML string from a PortalData object + the frontend assets.
 * Exported (and pure) so it can be unit-tested without touching the filesystem, and so the
 * inline-assembly logic has one home. The data is embedded inside a
 * `<script type="application/json">`, so the only escaping needed is to neutralise a literal
 * `</script` sequence (and the `<!--` / `-->` comment delimiters) that could otherwise close
 * the element early — standard JSON-in-HTML hardening.
 */
export function renderStaticHtml(data: PortalData, assets: PortalAssets): string {
  const json = safeJsonForScript(data);
  return assets.shell
    .replace('/* __PORTAL_CSS__ */', () => assets.css)
    .replace('/* __PORTAL_DATA__ */', () => json)
    .replace('/* __PORTAL_VENDOR__ */', () => assets.vendor)
    .replace('/* __PORTAL_MODULES__ */', () => assets.modules);
}

// U+2028 (line separator) and U+2029 (paragraph separator) are valid in JSON but are
// line terminators in a <script> body, so they must be escaped. Built from char codes so
// no literal line-separator byte appears in this source file.
const LINE_SEPARATORS = new RegExp(`[${String.fromCharCode(0x2028)}${String.fromCharCode(0x2029)}]`, 'g');

/** JSON for safe embedding in a <script type="application/json"> element. */
function safeJsonForScript(data: PortalData): string {
  return JSON.stringify(data)
    .replace(LINE_SEPARATORS, (ch) => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'))
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
}

/**
 * Emit a self-contained static portal page for `data` to `outPath`. Reads the committed
 * frontend assets, inlines them with the data, and writes ONE offline file (atomic). No
 * network reference is produced; the vendored layout lib is inlined verbatim.
 */
export async function emitStatic(data: PortalData, outPath: string): Promise<void> {
  const assets = await readAssets();
  const html = renderStaticHtml(data, assets);
  await atomicWriteFile(outPath, html);
}

/**
 * Render the self-contained portal page for `data` to an in-memory HTML string — the
 * loopback server's `/` body. Same assembly as `emitStatic`, minus the file write, so the
 * served page is byte-identical to the static export for the same data. The server reaches
 * the committed frontend assets ONLY through this serializer function (and `readPortalAsset`),
 * keeping all template-asset location in one node.
 */
export async function renderPortalPage(data: PortalData): Promise<string> {
  const assets = await readAssets();
  return renderStaticHtml(data, assets);
}

/** A committed frontend asset resolved for serving over `/static/*`: its bytes + content type. */
export interface PortalAsset {
  content: Buffer;
  contentType: string;
}

/** Content type for a committed asset, by extension. Unknown extensions are served as bytes. */
function contentTypeFor(relPath: string): string {
  if (relPath.endsWith('.html')) return 'text/html; charset=utf-8';
  if (relPath.endsWith('.css')) return 'text/css; charset=utf-8';
  if (relPath.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (relPath.endsWith('.json')) return 'application/json; charset=utf-8';
  if (relPath.endsWith('.svg')) return 'image/svg+xml';
  return 'application/octet-stream';
}

/**
 * Read one committed frontend asset for serving over `/static/*`, returning its bytes and
 * content type, or `null` when the path is unsafe or the file does not exist. The relative
 * path is resolved UNDER the committed templates/portal directory and rejected if it escapes
 * that root (no `..` traversal, no absolute path) — the server never serves outside the
 * committed asset tree. Read-only.
 */
export async function readPortalAsset(relPath: string): Promise<PortalAsset | null> {
  const root = portalTemplateDir();
  // Strip any leading slash, then resolve against the asset root.
  const cleaned = relPath.replace(/^\/+/, '');
  if (cleaned.length === 0) return null;
  const resolved = path.resolve(root, cleaned);
  // Containment check (separator-agnostic): the path from root to resolved must not climb
  // out (no leading `..`) and must not be absolute — otherwise it escapes the asset tree.
  const rel = path.relative(root, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  if (!existsSync(resolved)) return null;
  const content = await readFile(resolved);
  return { content, contentType: contentTypeFor(cleaned) };
}
