import { walk } from '@chrisdudek/yg/ast';

// The portal frontend must be fully self-contained and offline. A static export is one
// file with everything inlined; a served page loads only same-origin assets the local
// server emits. NOTHING in a frontend file may point at the network: no absolute
// http(s):// URL, no protocol-relative //host URL, no CDN host, and no <script>/<link>
// that loads an EXTERNAL resource. A single CDN reference breaks the offline guarantee
// and the "page never phones home" trust property.
//
// This rule must work on HTML and CSS as well as JS. Those have no tree-sitter grammar,
// so file.ast is undefined and an AST walk is impossible — this is a deliberately
// CONTENT-based scan over physical lines. To avoid false positives it only fires on
// genuine reference shapes (a URL in a src/href/url(), a protocol-relative //host, an
// http(s) scheme, an @import URL) — not on every occurrence of the substring "http".
//
// One asymmetry the scan must respect: for a JavaScript file (file.ast present) an
// http(s):// URL inside a COMMENT is provenance — a license, attribution, or doc link —
// NOT a network reference. A real `<script src=http>` / `url(http)` is never inside a JS
// comment, so skipping comment lines (mirroring sibling no-network-egress's
// collectCommentLines) loses no real coverage while killing the license-link false
// positive. HTML/CSS have no grammar, so their lines are scanned raw (their comment forms
// do not host a callable network reference either, and the reference shapes still gate).

// An absolute http(s) URL.
const ABSOLUTE_URL_RE = /\bhttps?:\/\/[^\s"'`)<>]+/i;
// A protocol-relative //host reference behind a src= / href= attribute.
const PROTOCOL_RELATIVE_RE = /(?:src|href)\s*=\s*["']\/\/[^"']+/i;
// A bare protocol-relative //host reference ANYWHERE in quoted / executable context — a
// `'//host/x.js'` assigned to a variable then handed to setAttribute('src', …), or any other
// indirection past a literal src=/href=/url(. Mirrors no-network-egress's PROTOCOL_RELATIVE_URL_RE:
// an unanchored //host where the char before `//` is NOT a scheme separator or word char (so
// `https://` is not matched — that is caught by ABSOLUTE_URL_RE) and the host has a real TLD.
const PROTOCOL_RELATIVE_ANYWHERE_RE = /(^|[^:\w])\/\/[a-z0-9.-]+\.[a-z]{2,}/i;
// CSS url(...) pointing at an absolute or protocol-relative URL.
const CSS_REMOTE_URL_RE = /url\(\s*["']?(?:https?:)?\/\/[^)"']+/i;
// CSS @import pulling an off-origin stylesheet — `@import "//host/x.css"` or
// `@import url("//host/x.css")` or an http(s) scheme. A relative @import (./x.css) is fine.
const CSS_IMPORT_REMOTE_RE = /@import\s+(?:url\(\s*)?["']?(?:https?:)?\/\/[^)"';]+/i;
// An external <script src> / <link href> — a src/href whose value starts with a scheme
// or protocol-relative //. A relative path (./app.js) is fine; it is same-origin.
const EXTERNAL_TAG_SRC_RE = /<(?:script|link)\b[^>]*\b(?:src|href)\s*=\s*["'](?:https?:)?\/\//i;
// Common CDN / package-host substrings — caught even if reached some other way.
const CDN_HOST_RE =
  /\b(?:cdn\.jsdelivr\.net|unpkg\.com|cdnjs\.cloudflare\.com|esm\.sh|skypack\.dev|googleapis\.com|gstatic\.com|jsdelivr\.net)\b/i;

const PATTERNS = [
  { re: ABSOLUTE_URL_RE, what: 'an absolute http(s) URL' },
  { re: PROTOCOL_RELATIVE_RE, what: 'a protocol-relative //host reference' },
  { re: PROTOCOL_RELATIVE_ANYWHERE_RE, what: 'a protocol-relative //host reference' },
  { re: CSS_REMOTE_URL_RE, what: 'a CSS url() pointing off-origin' },
  { re: CSS_IMPORT_REMOTE_RE, what: 'a CSS @import pulling an off-origin stylesheet' },
  { re: EXTERNAL_TAG_SRC_RE, what: 'a <script>/<link> loading an external resource' },
  { re: CDN_HOST_RE, what: 'a CDN / package-host reference' },
];

/** Every 0-based line index covered by a comment node, so URLs in comments can be skipped. */
function collectCommentLines(rootNode) {
  const lines = new Set();
  walk(rootNode, (node) => {
    if (node.type === 'comment') {
      for (let r = node.startPosition.row; r <= node.endPosition.row; r += 1) lines.add(r);
    }
    return true;
  });
  return lines;
}

export function check(ctx) {
  const violations = [];

  for (const file of ctx.files) {
    // For a JavaScript file the AST gives comment line ranges; an http(s)/protocol-relative URL
    // inside a comment is provenance (a license / doc link), not a network reference, so those
    // lines are skipped. HTML/CSS have no grammar (file.ast undefined) — every line is scanned.
    const commentLines = file.ast ? collectCommentLines(file.ast.rootNode) : null;
    const lines = file.content.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      if (commentLines && commentLines.has(i)) continue; // skip a JS comment line
      const line = lines[i];
      for (const { re, what } of PATTERNS) {
        const m = re.exec(line);
        if (m) {
          violations.push({
            file: file.path,
            line: i + 1,
            column: m.index,
            message:
              `Frontend file references ${what} ('${m[0].slice(0, 80)}'). The portal frontend must be ` +
              `fully self-contained and offline — inline every asset (vendor it), never load from the ` +
              `network or a CDN. Remove the reference and ship the resource inline.`,
          });
          break; // one violation per line is enough
        }
      }
    }
  }

  return violations;
}
