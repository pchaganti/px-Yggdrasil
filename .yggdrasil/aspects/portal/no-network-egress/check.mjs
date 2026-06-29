import { walk, report } from '@chrisdudek/yg/ast';

// Vendored third-party frontend code (the inlined layout library) is trusted to do
// layout MATH and nothing else. It must perform NO network egress: a vendored file that
// opens a socket, issues a fetch, or constructs an XMLHttpRequest / WebSocket / EventSource
// is exfiltrating or phoning home — exactly what vendoring-and-auditing is meant to prevent.
// The vendor file is exempt from the focused-file-size cap (third-party code is taken as
// shipped), so this egress ban is the guard that keeps the exemption safe.
//
// BANNED:
//   - a call to a network-egress API: fetch(...), XMLHttpRequest, WebSocket, EventSource,
//     navigator.sendBeacon(...), importScripts(...) — whether bare or as a member call.
//   - an image/audio BEACON: `new Image()` / `new Audio()` whose `.src` is assigned a URL
//     (inline `new Image().src = '/track?x='+document.cookie`, or constructed into a variable
//     whose `.src` is set later). Setting `.src` on an Image/Audio fires an immediate GET —
//     the classic cookie/data exfil channel that needs no fetch and no socket. A layout-math
//     library never constructs one, so any beacon construction in vendored code is egress.
//   - an http(s):// or protocol-relative //host URL anywhere in the file (content scan),
//     so a URL passed to some other transport is still caught.
//
// AST for the call/constructor forms (precise — a string 'fetch' in a comment is not a
// call); a content scan only for the URL scheme.
//
// KNOWN DETERMINISTIC LIMIT: a network-API callee assembled entirely at runtime from a
// COMPUTED name — `window['XML'+'HttpRequest']`, `window[['f','e','t','c','h'].join('')]`,
// `window[atob('ZmV0Y2g=')]` — is not statically resolvable to an EGRESS_NAMES token by this
// check, so it is NOT flagged here. That obfuscation is deliberately out of scope for the
// deterministic tripwire; the content URL scan still catches a literal URL it then loads, and
// the live offline e2e (the served page proven to make no off-origin request) is the real
// proof. This is a tripwire to stop the obvious egress shapes, not a sandbox.

// Egress API names — called bare (`fetch(...)`) or constructed (`new WebSocket(...)`)
// or as a member (`window.fetch(...)`, `navigator.sendBeacon(...)`).
const EGRESS_NAMES = new Set([
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'EventSource',
  'sendBeacon',
  'importScripts',
]);

// Image/audio beacon constructors — `new Image()` / `new Audio()`. Constructing one is only a
// network primitive once its `.src` is assigned (which fires a GET), so the construction is
// flagged when a `.src` assignment on the same object is found (inline or via a variable).
const BEACON_CTORS = new Set(['Image', 'Audio']);

const ABSOLUTE_URL_RE = /\bhttps?:\/\/[^\s"'`)<>]+/i;
const PROTOCOL_RELATIVE_URL_RE = /["'`]\/\/[a-z0-9.-]+\.[a-z]{2,}[/"'`]/i;

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

/** Trailing callee/constructor name: bare `f` or member `ns.f` → `f`. */
function calleeName(fnNode) {
  if (!fnNode) return '';
  if (fnNode.type === 'identifier') return fnNode.text;
  if (fnNode.type === 'member_expression') {
    return fnNode.childForFieldName('property')?.text ?? '';
  }
  return '';
}

/** The constructor name of a `new_expression` node (`new Image()` → 'Image'), else ''. */
function newCtorName(node) {
  if (!node || node.type !== 'new_expression') return '';
  const ctor = node.childForFieldName('constructor');
  return ctor ? calleeName(ctor) : '';
}

/**
 * Collect, from the file AST, the set of variable names that were assigned a beacon
 * constructor (`var i = new Image()` / `let a = new Audio()`). Used to flag a later
 * `<var>.src = …` assignment as an image/audio beacon — the construct-then-set-src exfil shape.
 */
function collectBeaconVars(rootNode) {
  const names = new Set();
  walk(rootNode, (node) => {
    // `var i = new Image()` — a declarator whose value is a beacon `new` expression.
    if (node.type === 'variable_declarator') {
      const nameNode = node.childForFieldName('name');
      const valueNode = node.childForFieldName('value');
      if (nameNode && nameNode.type === 'identifier' && BEACON_CTORS.has(newCtorName(valueNode))) {
        names.add(nameNode.text);
      }
    }
    // `i = new Image()` — a plain assignment of a beacon to an existing identifier.
    if (node.type === 'assignment_expression') {
      const left = node.childForFieldName('left');
      const right = node.childForFieldName('right');
      if (left && left.type === 'identifier' && BEACON_CTORS.has(newCtorName(right))) {
        names.add(left.text);
      }
    }
    return true;
  });
  return names;
}

export function check(ctx) {
  const violations = [];

  for (const file of ctx.files) {
    // AST pass — call + new expressions on an egress API.
    if (file.ast) {
      // Variables holding a beacon constructor, so `var i = new Image(); i.src = …` is caught.
      const beaconVars = collectBeaconVars(file.ast.rootNode);
      walk(file.ast.rootNode, (node) => {
        // Image/audio beacon: a `.src` assignment on a `new Image()`/`new Audio()` (inline) or on
        // a variable that holds one. Assigning `.src` fires an immediate GET — a cookie/data
        // exfil channel needing no fetch. (Bare `new Image()` with no `.src` set is a no-op and
        // not flagged; the egress only exists once a URL is loaded through `.src`.)
        if (node.type === 'assignment_expression') {
          const left = node.childForFieldName('left');
          if (
            left &&
            left.type === 'member_expression' &&
            left.childForFieldName('property')?.text === 'src'
          ) {
            const obj = left.childForFieldName('object');
            const objIsInlineBeacon = obj && BEACON_CTORS.has(newCtorName(obj));
            const objIsBeaconVar = obj && obj.type === 'identifier' && beaconVars.has(obj.text);
            if (objIsInlineBeacon || objIsBeaconVar) {
              violations.push(
                report(
                  file,
                  node,
                  `Vendored frontend code sets the .src of an image/audio beacon ('new Image()' / ` +
                    `'new Audio()' with .src assigned). Assigning .src fires an immediate network GET — ` +
                    `the classic cookie/data exfil channel that needs no fetch. Vendored layout-math code ` +
                    `must never construct a network beacon.`,
                ),
              );
            }
          }
          return true;
        }
        if (node.type === 'call_expression') {
          const name = calleeName(node.childForFieldName('function'));
          if (EGRESS_NAMES.has(name)) {
            violations.push(
              report(
                file,
                node,
                `Vendored frontend code performs network egress ('${name}(...)'). Vendored third-party ` +
                  `code may do layout math only — never open a socket or issue a request. If the library ` +
                  `genuinely needs network access it must not be vendored into the offline portal.`,
              ),
            );
          }
          return true;
        }
        if (node.type === 'new_expression') {
          const ctor = node.childForFieldName('constructor');
          const name = ctor ? calleeName(ctor) : '';
          if (EGRESS_NAMES.has(name)) {
            violations.push(
              report(
                file,
                node,
                `Vendored frontend code constructs a network transport ('new ${name}(...)'). Vendored ` +
                  `third-party code may do layout math only — never open a socket or stream.`,
              ),
            );
          }
          return true;
        }
        return true;
      });
    }

    // Content pass — an http(s) / protocol-relative URL in EXECUTABLE code (catches a URL
    // handed to some other transport). A URL inside a comment (a license header, an
    // attribution) is provenance, not egress, so comment lines are skipped. Comment line
    // ranges come from the AST when the file parsed; if it did not parse we scan every line.
    const commentLines = file.ast ? collectCommentLines(file.ast.rootNode) : null;
    const lines = file.content.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      if (commentLines && commentLines.has(i)) continue; // skip a commented line
      const m = ABSOLUTE_URL_RE.exec(lines[i]) ?? PROTOCOL_RELATIVE_URL_RE.exec(lines[i]);
      if (m) {
        violations.push({
          file: file.path,
          line: i + 1,
          column: m.index,
          message:
            `Vendored frontend code contains a network URL ('${m[0].slice(0, 80)}') in executable code. ` +
            `Vendored code in the offline portal must reference nothing off-origin. Remove the URL.`,
        });
      }
    }
  }

  // De-duplicate by (file, line, column, message).
  const seen = new Set();
  return violations.filter((v) => {
    const key = `${v.file}:${v.line}:${v.column}:${v.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
