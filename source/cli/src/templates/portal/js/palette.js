/*
 * Command palette (⌘K) — fuzzy jump to any node / aspect / flow or view action.
 *
 * One keyboard-first overlay over the whole graph: type a few characters and the palette
 * fuzzy-matches every node, aspect, flow, and view action, ranked; Enter routes to the
 * selection (a node opens its panel, an aspect/flow its detail, an action runs). It is
 * never empty — with no query it shows view actions and a few entities so the door is
 * always open.
 *
 * The index builder and the fuzzy matcher are PURE functions over plain data (no DOM), so
 * the ranking is unit-testable directly; the overlay below is the thin DOM layer. Browser
 * globals only — no network, no Node.
 */
(function () {
  'use strict';

  var Yg = (window.YgPortal = window.YgPortal || {});

  /**
   * Build the flat searchable index from a PortalData object. Each entry is
   * { id, label, sub, kind, route } — `route` is a router route the selection navigates to.
   * View actions come first so an empty query always has somewhere to go.
   */
  function buildIndex(data) {
    var items = [];

    // View actions — always present, even on an empty/blank graph.
    var VIEW_ACTIONS = [
      { id: 'view:overview', label: 'Overview', sub: 'the landing', kind: 'view', route: { view: 'overview' } },
      { id: 'view:coverage', label: 'Coverage & audit', sub: 'the full ledger', kind: 'view', route: { view: 'coverage' } },
      { id: 'view:tree', label: 'Structure (tree)', sub: 'the hierarchy', kind: 'view', route: { view: 'tree' } },
      { id: 'view:relations', label: 'Relations & boundaries', sub: 'matrix · hubs · boundary', kind: 'view', route: { view: 'relations' } },
      { id: 'view:rulebook', label: 'Rulebook', sub: "what's enforced", kind: 'view', route: { view: 'rulebook' } },
      { id: 'view:types', label: 'Type model', sub: "what's possible", kind: 'view', route: { view: 'types' } },
      { id: 'view:flows', label: 'Flows', sub: 'what the system does', kind: 'view', route: { view: 'flows' } },
      { id: 'view:suppressions', label: 'Suppressions', sub: 'waiver inventory', kind: 'view', route: { view: 'suppressions' } },
      { id: 'view:start', label: 'Start here', sub: 'the on-ramp', kind: 'view', route: { view: 'start' } },
    ];
    for (var a = 0; a < VIEW_ACTIONS.length; a += 1) items.push(VIEW_ACTIONS[a]);

    var nodes = (data && data.nodes) || [];
    for (var n = 0; n < nodes.length; n += 1) {
      var node = nodes[n];
      items.push({
        id: 'node:' + node.path,
        label: node.name || node.path,
        sub: node.path + ' · ' + (node.type || ''),
        kind: 'node',
        state: node.state,
        route: { view: 'tree', node: node.path },
      });
    }

    var aspects = (data && data.aspects) || [];
    for (var s = 0; s < aspects.length; s += 1) {
      var asp = aspects[s];
      items.push({
        id: 'aspect:' + asp.id,
        label: asp.id,
        sub: 'aspect · ' + (asp.kind || '') + ' · ' + (asp.status || ''),
        kind: 'aspect',
        route: { view: 'rulebook', aspect: asp.id },
      });
    }

    var flows = (data && data.flows) || [];
    for (var f = 0; f < flows.length; f += 1) {
      var flow = flows[f];
      items.push({
        id: 'flow:' + flow.name,
        label: flow.name,
        sub: 'flow · ' + ((flow.participants && flow.participants.length) || 0) + ' participants',
        kind: 'flow',
        route: { view: 'flows', flow: flow.name },
      });
    }

    return items;
  }

  /**
   * Subsequence fuzzy score of `query` against `text`. Returns a number (higher = better)
   * or -1 when the query is not a subsequence. Rewards contiguous runs and a match at a word
   * boundary, so "fill" ranks "cli/core/fill" above an incidental scatter of those letters.
   */
  function fuzzyScore(query, text) {
    var q = query.toLowerCase();
    var t = text.toLowerCase();
    if (q.length === 0) return 0;
    var score = 0;
    var ti = 0;
    var prevMatch = -2;
    for (var qi = 0; qi < q.length; qi += 1) {
      var ch = q.charAt(qi);
      var found = t.indexOf(ch, ti);
      if (found === -1) return -1;
      score += 1;
      if (found === prevMatch + 1) score += 3; // contiguous run
      if (found === 0 || /[\/\-_. ]/.test(t.charAt(found - 1))) score += 2; // word boundary
      prevMatch = found;
      ti = found + 1;
    }
    // Prefer shorter targets (a tighter match) and an exact-substring hit.
    if (t.indexOf(q) !== -1) score += 4;
    score -= t.length * 0.01;
    return score;
  }

  /**
   * Rank index `items` against `query`. An empty query returns the first `limit` items in
   * index order (view actions first — never an empty palette). A non-empty query keeps only
   * subsequence matches, ranked by score, capped at `limit`.
   */
  function search(items, query, limit) {
    var cap = limit || 50;
    var q = String(query || '').trim();
    if (q.length === 0) return items.slice(0, cap);
    var scored = [];
    for (var i = 0; i < items.length; i += 1) {
      var item = items[i];
      var best = Math.max(fuzzyScore(q, item.label), fuzzyScore(q, item.sub || '') - 1);
      if (best >= 0) scored.push({ item: item, score: best });
    }
    scored.sort(function (a, b) {
      return b.score - a.score;
    });
    return scored.slice(0, cap).map(function (s) {
      return s.item;
    });
  }

  Yg.paletteSearch = { buildIndex: buildIndex, fuzzyScore: fuzzyScore, search: search };
})();
