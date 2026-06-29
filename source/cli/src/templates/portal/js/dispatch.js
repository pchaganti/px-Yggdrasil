/*
 * View dispatcher — render the current route's view into the center stage.
 *
 * One pure-ish map from a route's `view` to a render function. Phase-3 ships the FOUNDATION:
 * the honest count header + the honest-state legend (rendered on every view, never
 * collapsing any state into a single "green"), the real virtualized node tree, and a
 * faithful per-view scaffold for the §3a surfaces that arrive in Phase 4 — each scaffold is
 * honest about being a foundation, never a fake "all good" screen. Selecting a node routes
 * to it; the tree view also reveals the selection.
 *
 * Browser globals only — reads the already-resolved PortalData; no network, no Node.
 */
(function () {
  'use strict';

  var Yg = (window.YgPortal = window.YgPortal || {});
  var dom = Yg.dom;

  // view id -> human title + one-line purpose (used for the per-view scaffold header).
  var VIEW_INFO = {
    overview: { title: 'Overview', blurb: 'The plain-language verdict and where the repo stands.' },
    coverage: { title: 'Coverage & audit', blurb: 'The full honest ledger — every verdict, every non-pair state.' },
    tree: { title: 'Structure', blurb: 'The component hierarchy, each row carrying its honest state.' },
    relations: { title: 'Relations & boundaries', blurb: 'The allowed-relation matrix, the hubs, and the live boundary.' },
    rulebook: { title: 'Rulebook', blurb: 'Every rule the code must satisfy, with its honest tally.' },
    types: { title: 'Type model', blurb: 'The architecture vocabulary — what can be enforced, and how.' },
    flows: { title: 'Flows', blurb: 'The business processes that span components.' },
    suppressions: { title: 'Suppressions', blurb: 'Every deliberate waiver, risk-first.' },
    start: { title: 'Start here', blurb: 'A short guided walk from the committed graph.' },
  };

  /** Render the count header — every honest state shown distinctly, never one "green". */
  function renderCounts(data) {
    var c = data.meta.counts;
    var header = dom.el('header', 'stage-header');
    header.appendChild(dom.el('h1', 'stage-title', data.meta.projectName + ' — Heartwood'));
    var sub = dom.el('p', 'stage-sub');
    sub.appendChild(Yg.glossary.term('aspect', c.aspects + ' aspects'));
    sub.appendChild(document.createTextNode(' · ' + c.nodes + ' nodes · ' + c.flows + ' flows · generated ' + data.meta.generatedAt));
    header.appendChild(sub);

    var bar = dom.el('div', 'count-bar');
    var segs = [
      { state: 'verified', value: c.verified },
      { state: 'refused', value: c.refused },
      { state: 'unverified', value: c.unverified },
      { state: 'no-rule', value: c.noRule },
      { state: 'warning', value: c.warnings },
      { state: 'suppressed', value: c.suppressed },
      { state: 'draft', value: c.draft },
    ];
    for (var i = 0; i < segs.length; i += 1) {
      bar.appendChild(countChip(segs[i].state, segs[i].value));
    }
    header.appendChild(bar);
    return header;
  }

  function countChip(state, value) {
    var chip = dom.el('span', 'count-chip ' + Yg.states.cssClass(state));
    chip.appendChild(Yg.states.badge(state));
    chip.appendChild(dom.el('span', 'chip-count', String(value)));
    var labelNode = Yg.glossary.term(state, Yg.states.label(state));
    labelNode.classList.add('chip-label');
    chip.appendChild(labelNode);
    return chip;
  }

  /** The always-visible honest legend — every state by color + glyph + plain label. */
  function renderLegend() {
    var box = dom.el('section', 'legend');
    box.appendChild(dom.el('h2', 'legend-h', 'The honest key'));
    var grid = dom.el('div', 'legend-grid');
    for (var i = 0; i < Yg.states.ORDER.length; i += 1) {
      var state = Yg.states.ORDER[i];
      var item = dom.el('div', 'legend-item ' + Yg.states.cssClass(state));
      item.appendChild(Yg.states.badge(state));
      var t = dom.el('div', 'legend-text');
      t.appendChild(dom.el('b', null, Yg.states.label(state)));
      t.appendChild(dom.el('span', null, Yg.states.plain(state)));
      item.appendChild(t);
      grid.appendChild(item);
    }
    box.appendChild(grid);
    return box;
  }

  /**
   * Render the view named by `route.view` into `stage`. `onSelect(path)` routes a node to its
   * attestation panel; `navigate(route)` is the general router hop the views wire their §3a
   * transitions through (falls back to onSelect-shaped navigation when absent). Every view gets
   * the honest count header and the shared honest legend; the body is rendered by the matching
   * Yg.views.<view> module. A view with no registered renderer yet gets an honest scaffold, so a
   * not-yet-built surface is never mistaken for a clean pass.
   */
  function render(stage, route, data, onSelect, navigate) {
    dom.clear(stage);
    stage.appendChild(renderCounts(data));

    var view = route.view || 'overview';
    var info = VIEW_INFO[view] || VIEW_INFO.overview;

    var nav =
      navigate ||
      function (r) {
        if (r && r.node && onSelect) onSelect(r.node);
      };

    var intro = dom.el('div', 'stage-intro');
    intro.appendChild(dom.el('h2', 'stage-vtitle', info.title));
    intro.appendChild(dom.el('p', 'stage-vblurb', info.blurb));
    stage.appendChild(intro);

    var body = dom.el('div', 'stage-body');
    stage.appendChild(body);

    var renderer = (Yg.views || {})[view];
    if (typeof renderer === 'function') {
      renderer(body, route, data, { onSelect: onSelect, navigate: nav });
    } else {
      body.appendChild(dom.el('p', 'stage-note', 'This surface is rendered in a later phase. Below is the honest key every view shares.'));
    }

    stage.appendChild(renderLegend());
  }

  Yg.dispatch = { render: render, VIEW_INFO: VIEW_INFO, _renderCounts: renderCounts, _renderLegend: renderLegend };
})();
