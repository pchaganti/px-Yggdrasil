/*
 * V4 Relations & Boundaries — orchestrator (hubs + the live boundary), with the matrix.
 *
 * Three parts, all MVP (§3.4, §3a V4): (a) the allowed-relations matrix (delegated to
 * Yg.matrix), (b) the fan-in / fan-out hub ranking (the load-bearing nodes), and (c) the LIVE
 * boundary, recomputed at generation, never read from the lock.
 *
 * CRITICAL HONESTY — the boundary has THREE classes, and they are NOT the same thing:
 *   - phantom        — a real undeclared code dependency. A VIOLATION (boundary state, error).
 *   - forbiddenType  — a code dependency to a type the architecture forbids. A VIOLATION.
 *   - declaredOnly   — a DECLARED relation with no static code backing (reflection / DI / HTTP /
 *                      events). LEGITIMATE by design; rendered NEUTRALLY / informationally,
 *                      never red, never called a violation, never summed into a violation count.
 * And when the live parse could not run (boundary.unknown), the surface renders UNKNOWN — not
 * clean, not zero — never a fabricated green. Every verdict-state treatment is read from the one
 * shared honest-state model.
 *
 * Browser globals only — reads the already-resolved PortalData; no network, no Node.
 */
(function () {
  'use strict';

  var Yg = (window.YgPortal = window.YgPortal || {});
  var dom = Yg.dom;
  Yg.views = Yg.views || {};

  function hubColumn(title, cap, entries, nav) {
    var col = dom.el('div', 'rel-hubcol');
    col.appendChild(dom.el('h3', 'rel-hubh', title));
    col.appendChild(dom.el('div', 'rel-hubcap', cap));
    var max = 1;
    for (var i = 0; i < entries.length; i += 1) max = Math.max(max, entries[i].count);
    if (!entries.length) {
      col.appendChild(dom.el('p', 'rel-empty', 'None.'));
      return col;
    }
    for (var j = 0; j < entries.length; j += 1) {
      var e = entries[j];
      var row = dom.el('button', 'rel-hubrow');
      row.type = 'button';
      row.appendChild(dom.el('span', 'rel-hubname mono', e.path));
      var bar = dom.el('span', 'rel-hubbar');
      bar.style.width = Math.round((e.count / max) * 120) + 'px';
      row.appendChild(bar);
      row.appendChild(dom.el('span', 'rel-hubn', String(e.count)));
      row.addEventListener('click', function (p) {
        return function () {
          nav({ view: 'tree', node: p });
        };
      }(e.path));
      col.appendChild(row);
    }
    return col;
  }

  function summaryCard(count, label, tone) {
    var card = dom.el('div', 'rel-scard' + (tone ? ' rel-scard-' + tone : ''));
    card.appendChild(dom.el('b', null, String(count)));
    card.appendChild(dom.el('div', 'rel-scard-l', label));
    return card;
  }

  /** A phantom (undeclared) violation row — a real error, with a copy-ready relation stanza. */
  function phantomRow(v, nav) {
    var row = dom.el('div', 'rel-viol rel-viol-phantom');
    row.appendChild(Yg.states.badge('boundary'));
    var link = dom.el('button', 'rel-viol-src mono');
    link.type = 'button';
    link.textContent = v.source + ' → ' + v.target;
    link.addEventListener('click', function () {
      nav({ view: 'tree', node: v.source });
    });
    row.appendChild(link);
    var stanza = dom.el('pre', 'rel-stanza', 'relations:\n  - target: ' + v.target + '\n    type: <allowed-type>');
    row.appendChild(stanza);
    return row;
  }

  /** A forbidden-type violation — links to the Type Model / matrix that forbids the pair. */
  function forbiddenRow(v, nav) {
    var row = dom.el('div', 'rel-viol rel-viol-forbidden');
    row.appendChild(Yg.states.badge('boundary'));
    row.appendChild(dom.el('span', 'rel-viol-src mono', v.source + ' → ' + v.target));
    var to = dom.el('button', 'rel-viol-link');
    to.type = 'button';
    to.textContent = 'see the architecture decision →';
    to.addEventListener('click', function () {
      nav({ view: 'types' });
    });
    row.appendChild(to);
    return row;
  }

  /** A declared-only edge — NEUTRAL / informational. Never red, never a violation. */
  function declaredOnlyRow(v) {
    var row = dom.el('div', 'rel-decl');
    row.appendChild(dom.el('span', 'rel-decl-mark', '↪'));
    row.appendChild(dom.el('span', 'mono', v.source + ' → ' + v.target));
    row.appendChild(dom.el('span', 'rel-decl-note', 'declared, no static backing — legitimate (DI / HTTP / reflection / events)'));
    return row;
  }

  function renderBoundary(stage, boundary, nav) {
    var head = dom.el('div', 'rel-bhead');
    head.appendChild(dom.el('span', 'cov-livebadge', 'LIVE'));
    head.appendChild(dom.el('span', null, 'recomputed now, never cached · always an error · not suppressible'));
    stage.appendChild(head);

    // UNKNOWN degraded state — honest, never a fabricated clean.
    if (boundary.unknown) {
      var unk = dom.el('div', 'rel-unknown');
      unk.appendChild(Yg.states.badge('unverified'));
      unk.appendChild(dom.el('b', null, 'UNKNOWN — relation health unknown, not clean'));
      unk.appendChild(dom.el('p', null, 'The live relation parse could not run, so the boundary cannot be computed. This is not a clean result and not zero. Re-run yg check once the parse can complete.'));
      stage.appendChild(unk);
      return;
    }

    var phantom = boundary.phantom || [];
    var declaredOnly = boundary.declaredOnly || [];
    var forbidden = boundary.forbiddenType || [];

    var summary = dom.el('div', 'rel-summary');
    summary.appendChild(summaryCard(phantom.length, 'phantom (undeclared) ' + (phantom.length === 0 ? '— clean' : '— error'), phantom.length === 0 ? 'clean' : 'err'));
    summary.appendChild(summaryCard(declaredOnly.length, 'declared-only (informational)', 'info'));
    summary.appendChild(summaryCard(forbidden.length, 'forbidden-type crossings', forbidden.length === 0 ? 'clean' : 'err'));
    stage.appendChild(summary);

    // Phantom — violations.
    var phSect = dom.el('section', 'rel-class');
    phSect.appendChild(dom.el('h3', 'rel-classh', 'Phantom — code depends on a node it never declared'));
    if (phantom.length === 0) {
      phSect.appendChild(dom.el('p', 'rel-clean', '✓ clean — no undeclared dependency on current inputs.'));
    } else {
      for (var i = 0; i < phantom.length; i += 1) phSect.appendChild(phantomRow(phantom[i], nav));
    }
    stage.appendChild(phSect);

    // Forbidden-type — violations.
    var fbSect = dom.el('section', 'rel-class');
    fbSect.appendChild(dom.el('h3', 'rel-classh', 'Forbidden-type — a dependency the architecture allows no relation for'));
    if (forbidden.length === 0) {
      fbSect.appendChild(dom.el('p', 'rel-clean', '✓ clean — no forbidden-type crossing on current inputs.'));
    } else {
      for (var f = 0; f < forbidden.length; f += 1) fbSect.appendChild(forbiddenRow(forbidden[f], nav));
    }
    stage.appendChild(fbSect);

    // Declared-only — NEUTRAL, never red.
    var doSect = dom.el('section', 'rel-class rel-class-info');
    doSect.appendChild(dom.el('h3', 'rel-classh', 'Declared-only — relation declared, no static backing (legitimate, never red)'));
    doSect.appendChild(dom.el('p', 'rel-decl-intro', 'One-directional contract: a declared relation needs no code behind it. These are correct, not dead edges.'));
    if (declaredOnly.length === 0) {
      doSect.appendChild(dom.el('p', 'rel-empty', 'None on current inputs.'));
    } else {
      for (var d = 0; d < declaredOnly.length; d += 1) doSect.appendChild(declaredOnlyRow(declaredOnly[d]));
    }
    stage.appendChild(doSect);
  }

  Yg.views.relations = function (stage, route, data, ctx) {
    var nav = ctx && ctx.navigate ? ctx.navigate : function () {};

    // (a) allowed-relations matrix.
    var mtxSect = dom.el('section', 'rel-part');
    mtxSect.appendChild(dom.el('h2', 'rel-parth', 'Allowed relations'));
    Yg.matrix.render(mtxSect, data);
    stage.appendChild(mtxSect);

    // (b) fan-in / fan-out hubs.
    var hubSect = dom.el('section', 'rel-part');
    hubSect.appendChild(dom.el('h2', 'rel-parth', 'Dependency hubs'));
    var cols = dom.el('div', 'rel-hubcols');
    cols.appendChild(hubColumn('Most depended-on (fan-in)', 'If one of these breaks, a lot breaks with it.', (data.hubs && data.hubs.fanIn) || [], nav));
    cols.appendChild(hubColumn('Depends on the most (fan-out)', 'Wide reach often signals responsibilities to split.', (data.hubs && data.hubs.fanOut) || [], nav));
    hubSect.appendChild(cols);
    stage.appendChild(hubSect);

    // (c) the live boundary.
    var bSect = dom.el('section', 'rel-part');
    bSect.appendChild(dom.el('h2', 'rel-parth', 'Live boundary'));
    renderBoundary(bSect, data.boundary || { unknown: false }, nav);
    stage.appendChild(bSect);
  };
})();
