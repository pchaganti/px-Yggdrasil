/*
 * Plain-language glossary — the engine words said simply.
 *
 * The portal must be legible to a human who does not speak the engine's vocabulary, so
 * every internal term (aspect, pair, deterministic vs LLM, relation, flow, reviewer /
 * tier / consensus, no-rule, draft, when-filtered, waived) carries a plain definition
 * that appears as a tooltip wherever the term is shown. The wording here is the same
 * text as the glossary-key reference card, so the in-app tooltip and the key never drift.
 *
 * Browser globals only — the tooltip is a hover/focus popover built from page DOM; no
 * network, no Node.
 */
(function () {
  'use strict';

  var Yg = (window.YgPortal = window.YgPortal || {});

  // term id -> plain definition. Keyed by a stable lowercase id, not display text.
  var TERMS = {
    aspect: 'A rule the code must satisfy — e.g. “UI must not import the database”.',
    deterministic:
      'A rule is checked either by a free local script (mechanical, repeatable) or by an AI reviewer reading it (judgment, may cost).',
    llm: 'An AI reviewer reads the rule and judges the code against it — judgment, and it may cost.',
    pair: 'One rule checked against one thing — the unit a verdict is recorded for.',
    relation:
      "A declared dependency between two components (calls / uses / …). The code's real dependencies must match what's declared.",
    flow: 'A business process that spans several components — “place an order”.',
    reviewer:
      'Which model judged a rule, and how many times it voted — so you can weigh how much a green is worth.',
    tier: 'The named reviewer setting an aspect uses — which model judges it, and how strictly.',
    consensus: 'How many times the reviewer voted on a rule — more votes, more confidence in the verdict.',
    'no-rule': 'Nothing is checking this part. Not broken — just unguarded. Absence of red is not a pass.',
    draft: 'A rule parked as not-ready — it is removed from the expected set and verifies nothing.',
    'when-filtered': 'A rule was deliberately filtered out here — it does not apply to this node.',
    waived: 'Someone told the reviewer to skip a rule here, on purpose, with a reason. Not the same as verified.',
    unverified: "The code changed, so no reviewer has confirmed it yet. Not a pass — just “we don’t know”.",
    suppressed: 'A waiver tells the reviewer to skip a rule on specific lines, with a reason. Waived is not verified.',
  };

  /** The plain definition for a term id, or null when the term is unknown. */
  function lookup(termId) {
    var key = String(termId || '').toLowerCase();
    return Object.prototype.hasOwnProperty.call(TERMS, key) ? TERMS[key] : null;
  }

  /**
   * Wrap a piece of text as a glossary term: a <span class="term"> carrying the plain
   * definition both as a native title and as an aria-label, so the meaning is reachable on
   * hover AND by a screen reader. Falls back to plain text when the term is unknown.
   */
  function term(termId, displayText) {
    var def = lookup(termId);
    var text = displayText === undefined ? String(termId) : displayText;
    if (!def) return Yg.dom.el('span', null, text);
    var node = Yg.dom.el('span', 'term', text);
    node.setAttribute('tabindex', '0');
    node.setAttribute('title', def);
    node.setAttribute('aria-label', text + ': ' + def);
    node.setAttribute('data-term', String(termId).toLowerCase());
    return node;
  }

  Yg.glossary = { lookup: lookup, term: term, _terms: TERMS };
})();
