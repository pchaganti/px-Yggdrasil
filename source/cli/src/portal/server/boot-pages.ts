/**
 * server/boot-pages — the two self-contained pages the loopback server sends before (or
 * instead of) the full portal: the instant loading shell for `GET /` and the human-readable
 * error page for a failed `GET /render`.
 *
 * These are LIVE-server concerns, not part of the static offline export the serializer builds,
 * so they live in the server layer. Their defining property is that they depend on NOTHING —
 * no template read, no other asset — so they render even when the asset pipeline itself is what
 * failed (a missing shell template, an unreadable stylesheet). The loading shell boots the real
 * page by fetching `/render` and swapping it in; the swap keeps the URL at `/`, preserving any
 * hash route the user opened. On a fetch failure it degrades to an inline notice.
 */

// Self-contained styling for both boot pages. It uses the portal's token VALUES with light/dark
// via prefers-color-scheme so the pages look on-brand — but it reads NOTHING from disk, which is
// the point: these pages must render even when the asset pipeline itself is broken.
const BOOT_PAGE_CSS = `
:root{color-scheme:light dark;--yg-bg:#fcfcfd;--yg-surface:#f9f9fb;--yg-fg:#1c2024;--yg-muted:#60646c;--yg-accent:#0090ff;--yg-border:#cdced6}
@media (prefers-color-scheme:dark){:root{--yg-bg:#111113;--yg-surface:#18191b;--yg-fg:#edeef0;--yg-muted:#b0b4ba;--yg-accent:#3b9eff;--yg-border:#43484e}}
html,body{height:100%}
body{margin:0;background:var(--yg-bg);color:var(--yg-fg);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;display:grid;place-items:center;padding:24px;box-sizing:border-box}
.yg-box{display:flex;flex-direction:column;align-items:center;gap:14px;text-align:center;max-width:56ch}
.yg-title{font-weight:600;font-size:16px}
.yg-sub{color:var(--yg-muted);font-size:13.5px;max-width:46ch}
.yg-sub code,.yg-detail{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.yg-sub code{font-size:12px;background:var(--yg-surface);border:1px solid var(--yg-border);border-radius:4px;padding:1px 5px}`;

/**
 * The instant loading shell served at `GET /`. It touches NOTHING on disk and depends on no
 * other asset — its whole purpose is to paint immediately (and to still render when the asset
 * pipeline or the graph is broken), then boot the real page by fetching `/render` and swapping
 * it in. The swap keeps the URL at `/`, preserving any hash route the user opened (the app is
 * hash-routed). If the fetch fails (the local server stopped), it degrades to an inline notice.
 */
export function renderLoadingShell(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Yggdrasil Portal</title>
<style>${BOOT_PAGE_CSS}
.yg-spinner{width:34px;height:34px;border-radius:50%;border:3px solid var(--yg-border);border-top-color:var(--yg-accent);animation:yg-spin .8s linear infinite}
@keyframes yg-spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.yg-spinner{animation-duration:2.4s}}
</style>
</head>
<body>
<div class="yg-box" id="yg-boot">
<div class="yg-spinner" role="status" aria-label="Loading"></div>
<div class="yg-title">Reading your architecture…</div>
<div class="yg-sub">Checking the graph and rendering the portal. This can take a moment on a large project.</div>
</div>
<script>
(function(){
  fetch('/render' + location.search, { headers: { accept: 'text/html' } })
    .then(function(r){ return r.text(); })
    .then(function(html){ document.open(); document.write(html); document.close(); })
    .catch(function(){
      var b = document.getElementById('yg-boot');
      if (b) { b.innerHTML =
        '<div class="yg-title">Couldn\\u2019t reach the portal</div>' +
        '<div class="yg-sub">The local portal process may have stopped. Restart it in your terminal, then reload this page.</div>'; }
    });
})();
</script>
</body>
</html>
`;
}

/**
 * A human-readable HTML error page for a failed top-level render (`GET /render`). A person
 * navigated here, so this returns a readable page — never a raw JSON blob. Self-contained (no
 * asset reads) so it renders even when the asset pipeline is what failed. The technical detail
 * is preserved verbatim (HTML-escaped) beneath a plain-language explanation and a next step.
 */
export function renderErrorPage(message: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Yggdrasil Portal — couldn’t load</title>
<style>${BOOT_PAGE_CSS}
.yg-detail{margin-top:4px;max-width:74ch;text-align:left;white-space:pre-wrap;word-break:break-word;font-size:12px;line-height:1.5;color:var(--yg-muted);background:var(--yg-surface);border:1px solid var(--yg-border);border-radius:8px;padding:12px 14px}
</style>
</head>
<body>
<div class="yg-box">
<div class="yg-title">The portal couldn’t load your architecture</div>
<div class="yg-sub">Something went wrong while reading the graph and building the page. Make sure this is a project with a <code>.yggdrasil/</code> graph, then reload. If it keeps happening, run <code>yg check</code> in your terminal to see the underlying problem.</div>
<div class="yg-detail">${escapeHtmlText(message)}</div>
</div>
</body>
</html>
`;
}

/** Escape text for safe inclusion in HTML element content / attributes. */
function escapeHtmlText(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
