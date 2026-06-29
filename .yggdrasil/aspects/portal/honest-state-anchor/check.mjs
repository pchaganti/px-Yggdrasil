import { walk, report } from '@chrisdudek/yg/ast';

// Invariant 3 (POSITIVE anchor): a portal view module must render verdict state THROUGH
// the single shared honest-state model (window.YgPortal.states) — the one source of truth
// for glyph + color-class + border + plain label, where 'verified' is the only green and
// the distinct states never collapse. This check makes that anchor mechanical, so a future
// refactor cannot silently grow a view that invents its own green:
//
//   A. POSITIVE — if a view file renders state at all (it touches the honest-state
//      vocabulary: a `state-*` class string, or a state-helper member name like cssClass /
//      badge / glyph / plain), it MUST reference the shared model: a member access
//      `<ns>.states` where <ns> is the portal namespace (`Yg` or `YgPortal`). Absence is a
//      violation. A view with no state rendering at all has nothing to anchor and is exempt.
//
//   B. NEGATIVE — a hardcoded GREEN state-class string literal ('state-verified' /
//      'state-green' / 'state-ok') is always a violation: the verified color-class must come
//      from the shared states.cssClass(), never be hand-written, so a green can never be
//      fabricated outside the honest model.
//
// AST-only over JavaScript (HTML/CSS have no grammar and are skipped — a view is always JS).
// We inspect real string literals and member accesses, so the word in a comment or an
// identifier is never a false positive.

// State-helper property names the shared model exposes — touching one means the file renders
// state and so must be anchored to the shared model.
const STATE_HELPER_PROPS = new Set(['cssClass', 'badge', 'glyph', 'plain']);

// Hardcoded GREEN state-class tokens that must never be written by hand.
const BANNED_GREEN_CLASSES = new Set(['state-verified', 'state-green', 'state-ok']);

// The portal namespace object names the shared model hangs off (Yg.states / YgPortal.states).
const PORTAL_NS = new Set(['Yg', 'YgPortal']);

/** Static text of a `string` / no-substitution `template_string` node, else undefined. */
function literalText(node) {
  if (!node) return undefined;
  if (node.type === 'string') {
    const frag = node.namedChildren.find((c) => c.type === 'string_fragment');
    if (frag) return frag.text;
    const t = node.text;
    return t.length >= 2 ? t.slice(1, -1) : '';
  }
  if (node.type === 'template_string') {
    if (node.namedChildren.some((c) => c.type === 'template_substitution')) return undefined;
    return node.namedChildren
      .filter((c) => c.type === 'string_fragment')
      .map((c) => c.text)
      .join('');
  }
  return undefined;
}

/** The class tokens in a literal value (space-separated, e.g. 'count-chip state-verified'). */
function classTokens(text) {
  return typeof text === 'string' ? text.split(/\s+/).filter(Boolean) : [];
}

export function check(ctx) {
  const violations = [];

  for (const file of ctx.files) {
    if (!file.ast) continue;

    let referencesSharedModel = false; // saw `<ns>.states`
    let rendersState = false; // saw any honest-state vocabulary
    let firstStateNode = null; // for the POSITIVE-anchor report position
    const bannedHits = [];

    walk(file.ast.rootNode, (node) => {
      // Member access: `<ns>.states` anchors the file; a state-helper property means it renders state.
      if (node.type === 'member_expression') {
        const obj = node.childForFieldName('object');
        const prop = node.childForFieldName('property');
        const propName = prop && prop.type === 'property_identifier' ? prop.text : prop && prop.text;
        if (propName === 'states' && obj && PORTAL_NS.has(obj.text)) {
          referencesSharedModel = true;
        }
        if (propName && STATE_HELPER_PROPS.has(propName)) {
          rendersState = true;
          if (!firstStateNode) firstStateNode = node;
        }
        return true;
      }

      // String literal: a `state-*` class token means the file renders state; a GREEN
      // state-class token is a hardcoded-green violation outright.
      if (node.type === 'string' || node.type === 'template_string') {
        const text = literalText(node);
        const tokens = classTokens(text);
        for (const tok of tokens) {
          if (tok.indexOf('state-') === 0) {
            rendersState = true;
            if (!firstStateNode) firstStateNode = node;
          }
          if (BANNED_GREEN_CLASSES.has(tok)) {
            bannedHits.push(node);
          }
        }
        return true;
      }

      return true;
    });

    // Rule B — every hardcoded green class literal.
    for (const node of bannedHits) {
      violations.push(
        report(
          file,
          node,
          `Portal view hardcodes a green state-class string. The verified color-class must come ` +
            `from the shared honest-state model (Yg.states.cssClass(state)), never be hand-written — ` +
            `a green can never be fabricated outside the one honest taxonomy.`,
        ),
      );
    }

    // Rule A — a view that renders state must anchor to the shared model.
    if (rendersState && !referencesSharedModel) {
      violations.push(
        report(
          file,
          firstStateNode ?? file.ast.rootNode,
          `Portal view renders verdict state but never references the shared honest-state model ` +
            `(Yg.states). Every view must read glyph + color-class + label from the one shared model ` +
            `so 'verified' stays the only green and the distinct states are never collapsed.`,
        ),
      );
    }
  }

  return violations;
}
