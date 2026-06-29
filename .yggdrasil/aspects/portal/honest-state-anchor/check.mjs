import { walk, report } from '@chrisdudek/yg/ast';

// Invariant 3 (POSITIVE anchor): a portal view module must render verdict state THROUGH
// the single shared honest-state model (window.YgPortal.states) — the one source of truth
// for glyph + color-class + border + plain label, where 'verified' is the only green and
// the distinct states never collapse. This check makes that anchor mechanical, so a future
// refactor cannot silently grow a view that invents its own green:
//
//   A. POSITIVE — if a view file renders state at all, it MUST reference the shared model:
//      a member access `<ns>.states` where <ns> is the portal namespace (`Yg` or `YgPortal`).
//      A file "renders state" when it touches the honest-state vocabulary in ANY of these
//      forms (broadened so an ad-hoc green via an unrelated class can no longer slip the net):
//        - a `state-*` class token (the canonical honest-state class), or
//        - a state-helper member name like cssClass / badge / glyph / plain, or
//        - a GREEN / pass color class token — a class string that paints its own green via a
//          word like `green` / `ok` / `pass` / `verified` (e.g. `is-green`, `ok-cell`,
//          `bg-green`, `verified-row`). Painting green by hand is exactly the state-rendering
//          that must be anchored; a view that fabricates `el.className = ok ? 'is-green' : ...`
//          with no `state-` token and no helper now still trips the anchor requirement.
//      Absence of the shared-model reference is a violation. A view with no state rendering at
//      all has nothing to anchor and is exempt.
//
//   B. NEGATIVE — a hardcoded GREEN state-class string literal ('state-verified' /
//      'state-green' / 'state-ok') is always a violation: the verified color-class must come
//      from the shared states.cssClass(), never be hand-written, so a green can never be
//      fabricated outside the honest model.
//
// AST-only over JavaScript (HTML/CSS have no grammar and are skipped — a view is always JS).
// We inspect real string literals and member accesses, so the word in a comment or an
// identifier is never a false positive. The green-token trigger is per CLASS TOKEN (space-split),
// matching only CSS-class-shaped greens — a bare prose string ('grammar, not a verdict: nothing
// here is green or red') or a glossary key ('verified') is NOT a class token and never trips it.

// State-helper property names the shared model exposes — touching one means the file renders
// state and so must be anchored to the shared model.
const STATE_HELPER_PROPS = new Set(['cssClass', 'badge', 'glyph', 'plain']);

// Hardcoded GREEN state-class tokens that must never be written by hand.
const BANNED_GREEN_CLASSES = new Set(['state-verified', 'state-green', 'state-ok']);

// Green/pass words that, in a CSS-class token, mark a hand-painted green. A class token renders
// state if it is a COMPOUND class (hyphen/underscore-delimited) whose parts include one of these
// (`is-green`, `ok-cell`, `bg-green`, `verified-row`, `sup-flag-ok`), or the bare unambiguous
// class words `green` / `pass`. Bare `ok` / `verified` alone are NOT triggers (they collide with
// glossary keys and comparison literals); they only count as a part of a compound class token.
const GREEN_WORDS = new Set(['green', 'ok', 'pass', 'verified']);
const BARE_GREEN_CLASSES = new Set(['green', 'pass']);

// The portal namespace object names the shared model hangs off (Yg.states / YgPortal.states).
const PORTAL_NS = new Set(['Yg', 'YgPortal']);

// A CSS-class identifier shape (single class token): starts with a letter / `_` / `-`, then
// word chars or hyphens. Used to tell a class-list string from a prose sentence.
const CLASS_IDENT = /^-?[A-Za-z_][\w-]*$/;

/**
 * Does `text` look like a CSS class-list (e.g. 'count-chip is-green'), as opposed to a prose
 * sentence ('nothing here is green or red.')? True iff it has a small number of tokens and EVERY
 * token is a class identifier. This gates the bare-green-word trigger so a prose string that
 * merely contains the word "green" never trips the anchor.
 */
function looksLikeClassList(text, tokens) {
  if (tokens.length === 0 || tokens.length > 6) return false;
  return tokens.every((t) => CLASS_IDENT.test(t));
}

/**
 * Is `tok` a CSS-class token that paints its own green/pass state? A COMPOUND class whose
 * hyphen/underscore parts include a green word (is-green, ok-cell, bg-green, verified-row,
 * sup-flag-ok) always counts — it is class-shaped and specific. A BARE green class word (green /
 * pass) counts only when the surrounding string `isClassList` (so the word "green" inside a prose
 * sentence does not). A bare `ok` / `verified` is never a trigger on its own — it collides with
 * glossary keys and equality checks in honest views; it only counts as part of a compound token.
 */
function isGreenStateToken(tok, isClassList) {
  const parts = tok.split(/[-_]/).filter(Boolean);
  if (parts.length > 1 && parts.some((p) => GREEN_WORDS.has(p))) return true;
  if (isClassList && BARE_GREEN_CLASSES.has(tok)) return true;
  return false;
}

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
        const isClassList = looksLikeClassList(text, tokens);
        for (const tok of tokens) {
          // A canonical `state-*` class OR an ad-hoc green/pass color class both mean the file
          // renders verdict state and so must anchor to the shared honest-state model.
          if (tok.indexOf('state-') === 0 || isGreenStateToken(tok, isClassList)) {
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
