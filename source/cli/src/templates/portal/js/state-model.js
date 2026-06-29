/*
 * The honest-state taxonomy — the spine of the whole portal.
 *
 * Eight distinct render states, each carried by color + GLYPH + label + border-style
 * (never color alone — accessibility), exactly as the visual-foundations reference
 * defines them. "verified" is the ONLY green: a reviewer ran, approved, AND the stored
 * hash still matches the current inputs. The others are deliberately, visibly distinct
 * and must NEVER be collapsed into one "green". This module is the single source of
 * truth a renderer reads — no view re-invents a glyph or a color.
 *
 * Five of these (verified / refused / unverified / no-rule / warning) are the
 * PortalNode.state values the contract enumerates; the remaining three
 * (not-applicable / suppressed / draft) are pair/aspect-level honest states, plus
 * "boundary" for a live undeclared-dependency violation. All eight render here so the
 * legend, the panels, and the cells share one honest vocabulary.
 */
(function () {
  'use strict';

  var Yg = (window.YgPortal = window.YgPortal || {});

  // Glyph + border + plain-language label for every honest state. The plain text is the
  // same wording as the glossary key card, so a tooltip and the legend never diverge.
  var STATE_META = {
    verified: {
      glyph: '✓', // check
      label: 'verified',
      border: 'solid',
      plain: 'A reviewer actually checked this against the current code and it passed. The only green.',
    },
    refused: {
      glyph: '✕', // cross
      label: 'refused',
      border: 'solid',
      plain: 'A reviewer checked it and it broke a rule — with a reason you can read.',
    },
    unverified: {
      glyph: '◌', // dashed circle
      label: 'unverified',
      border: 'dashed',
      plain: "The code changed, so no reviewer has confirmed it yet. Not a pass — just “we don’t know”.",
    },
    'no-rule': {
      glyph: '⊖', // minus-circle
      label: 'no rule',
      border: 'dotted',
      plain: 'Nothing is checking this part. Not broken — just unguarded. Absence of red is not a pass.',
    },
    warning: {
      glyph: '▲', // triangle (advisory)
      label: 'warning',
      border: 'dashed',
      plain: 'An advisory rule flagged this. It does not block — it is signal worth a look, not a failure.',
    },
    'not-applicable': {
      glyph: '–', // en-dash
      label: 'not applicable',
      border: 'none',
      plain: 'A rule was filtered out here on purpose — an empty cell, distinct from unverified.',
    },
    suppressed: {
      glyph: '⛉', // shield-like waiver mark
      label: 'waived',
      border: 'dashed',
      plain: 'Someone told the reviewer to skip a rule here, on purpose, with a reason. Not the same as verified.',
    },
    draft: {
      glyph: '‖', // double bar (paused)
      label: 'draft',
      border: 'dotted',
      plain: 'Parked — removed from the expected set. It verifies nothing while it is a draft.',
    },
    boundary: {
      glyph: '⚡', // zap
      label: 'live boundary',
      border: 'hazard',
      plain: 'An undeclared code dependency, recomputed live right now — never read from the stored lock.',
    },
  };

  // The canonical order the legend renders in (mirrors the foundations reference).
  var STATE_ORDER = [
    'verified',
    'refused',
    'unverified',
    'no-rule',
    'warning',
    'not-applicable',
    'suppressed',
    'draft',
    'boundary',
  ];

  /** Metadata for a state, falling back to no-rule for an unknown value (never throws). */
  function meta(state) {
    return STATE_META[state] || STATE_META['no-rule'];
  }

  /** The glyph for a state (color is carried by the CSS class, never alone). */
  function glyph(state) {
    return meta(state).glyph;
  }

  /** The plain-language label for a state. */
  function label(state) {
    return meta(state).label;
  }

  /** The plain-language one-line explanation (tooltip text) for a state. */
  function plain(state) {
    return meta(state).plain;
  }

  /** The CSS state class a renderer attaches so color + border come from one place. */
  function cssClass(state) {
    return 'state-' + (STATE_META[state] ? state : 'no-rule');
  }

  /**
   * Build an accessible state badge: a glyph element carrying the state color/border (from
   * the CSS class) plus an aria-label of the plain wording, so the state is conveyed by
   * shape AND text, never color alone. Returns a <span> ready to insert.
   */
  function badge(state) {
    var m = meta(state);
    var node = Yg.dom.el('span', 'state-glyph ' + cssClass(state), m.glyph);
    node.setAttribute('role', 'img');
    node.setAttribute('aria-label', m.label);
    node.setAttribute('title', m.plain);
    return node;
  }

  Yg.states = {
    ORDER: STATE_ORDER,
    meta: meta,
    glyph: glyph,
    label: label,
    plain: plain,
    cssClass: cssClass,
    badge: badge,
  };
})();
