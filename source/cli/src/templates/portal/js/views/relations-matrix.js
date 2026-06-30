/*
 * V4 part (a) — the allowed-relations matrix (Canvas grid + DOM mirror).
 *
 * The architecture's allowed-relations rules as a node-type × node-type grid: a filled cell
 * means the architecture permits that relation type from the row type to the column type; an
 * empty cell means it permits none (a forbidden pair). This is *allowed*, not *actual* —
 * conformance is the separate live boundary check. The dense grid is drawn on Canvas 2D (the
 * one place §3a sanctions Canvas), with a DOM-list MIRROR beside it so the matrix is not
 * opaque to a screen reader (Canvas alone is). Colors come from CSS custom properties read off
 * the page; this module paints relation presence only — it never paints a verdict state, so it
 * does not (and must not) invent a green.
 *
 * Browser globals only — reads the already-resolved PortalData; no network, no Node.
 */
(function () {
  'use strict';

  var Yg = (window.YgPortal = window.YgPortal || {});
  var dom = Yg.dom;
  Yg.views = Yg.views || {};
  Yg.matrix = {};

  var CELL = 26;
  var HEADER = 92;
  var ROWLBL = 150;

  // Relation type → a stable, colorblind-safe hue (presence marker only, not a state).
  var REL_COLOR = {
    calls: '#0d74ce',
    uses: '#208368',
    extends: '#9a6700',
    implements: '#8e4ec6',
    emits: '#d6409f',
    listens: '#d6409f',
  };

  /** The sorted union of every type that appears as a relation source or target. */
  Yg.matrix.axisTypes = function (types) {
    var ids = (types || []).map(function (t) {
      return t.id;
    });
    return ids.slice().sort();
  };

  /** The relation types allowed from `rowType` to `colType`, by the architecture matrix. */
  Yg.matrix.allowedBetween = function (typesById, rowType, colType) {
    var row = typesById[rowType];
    if (!row || !row.allowedRelations) return [];
    var out = [];
    for (var rel in row.allowedRelations) {
      if (!Object.prototype.hasOwnProperty.call(row.allowedRelations, rel)) continue;
      var targets = row.allowedRelations[rel] || [];
      if (targets.indexOf(colType) !== -1) out.push(rel);
    }
    return out;
  };

  function cssVar(name, fallback) {
    try {
      var v = getComputedStyle(document.documentElement).getPropertyValue(name);
      return (v && v.trim()) || fallback;
    } catch (_e) {
      return fallback;
    }
  }

  function drawCanvas(canvas, axis, typesById) {
    var ctx = canvas.getContext && canvas.getContext('2d');
    if (!ctx) return; // jsdom/test sandbox without canvas — the DOM mirror carries the data
    var n = axis.length;
    var muted = cssVar('--text-secondary', '#60646c');
    var border = cssVar('--border-subtle', '#d9d9e0');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
    ctx.textBaseline = 'middle';

    // Column headers (rotated) + row labels.
    for (var c = 0; c < n; c += 1) {
      ctx.save();
      ctx.translate(ROWLBL + c * CELL + CELL / 2, HEADER - 6);
      ctx.rotate(-Math.PI / 3);
      ctx.fillStyle = muted;
      ctx.textAlign = 'left';
      ctx.fillText(axis[c], 0, 0);
      ctx.restore();
    }
    for (var r = 0; r < n; r += 1) {
      ctx.fillStyle = muted;
      ctx.textAlign = 'right';
      ctx.fillText(axis[r], ROWLBL - 8, HEADER + r * CELL + CELL / 2);
    }

    // Cells.
    ctx.textAlign = 'center';
    for (var ri = 0; ri < n; ri += 1) {
      for (var ci = 0; ci < n; ci += 1) {
        var x = ROWLBL + ci * CELL;
        var y = HEADER + ri * CELL;
        ctx.strokeStyle = border;
        ctx.strokeRect(x, y, CELL, CELL);
        if (ri === ci) {
          ctx.fillStyle = cssVar('--surface-2', '#f0f0f3');
          ctx.fillRect(x + 1, y + 1, CELL - 2, CELL - 2);
          continue;
        }
        var rels = Yg.matrix.allowedBetween(typesById, axis[ri], axis[ci]);
        if (rels.length) {
          ctx.fillStyle = REL_COLOR[rels[0]] || muted;
          ctx.beginPath();
          ctx.arc(x + CELL / 2, y + CELL / 2, 4, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
  }

  /** A DOM-list mirror of the matrix: every allowed (row → rel → col) edge, screen-reader-legible. */
  function buildMirror(axis, typesById) {
    var mirror = dom.el('div', 'mtx-mirror');
    mirror.setAttribute('aria-label', 'Allowed relations, as a list');
    var any = false;
    for (var ri = 0; ri < axis.length; ri += 1) {
      for (var ci = 0; ci < axis.length; ci += 1) {
        if (ri === ci) continue;
        var rels = Yg.matrix.allowedBetween(typesById, axis[ri], axis[ci]);
        if (!rels.length) continue;
        any = true;
        var line = dom.el('div', 'mtx-mirror-row');
        line.appendChild(dom.el('span', 'mono', axis[ri]));
        line.appendChild(dom.el('span', 'mtx-arrow', ' → '));
        line.appendChild(dom.el('span', 'mtx-rels', rels.join(' / ')));
        line.appendChild(dom.el('span', 'mtx-arrow', ' → '));
        line.appendChild(dom.el('span', 'mono', axis[ci]));
        mirror.appendChild(line);
      }
    }
    if (!any) mirror.appendChild(dom.el('p', 'mtx-empty', 'The architecture declares no allowed relations between these types — every pair is a forbidden cell.'));
    return mirror;
  }

  function legend() {
    var box = dom.el('div', 'mtx-legend');
    for (var rel in REL_COLOR) {
      if (!Object.prototype.hasOwnProperty.call(REL_COLOR, rel)) continue;
      if (rel === 'listens') continue; // emits/listens share one swatch
      var k = dom.el('span', 'mtx-legend-k');
      var sw = dom.el('span', 'mtx-swatch');
      sw.style.background = REL_COLOR[rel];
      k.appendChild(sw);
      k.appendChild(dom.el('span', null, rel === 'emits' ? 'emits/listens' : rel));
      box.appendChild(k);
    }
    var empty = dom.el('span', 'mtx-legend-k mtx-legend-empty', 'empty = forbidden by architecture');
    box.appendChild(empty);
    return box;
  }

  /** Render the allowed-relations matrix (Canvas + DOM mirror) into `mount`. */
  Yg.matrix.render = function (mount, data) {
    var typesById = {};
    (data.types || []).forEach(function (t) {
      typesById[t.id] = t;
    });
    var axis = Yg.matrix.axisTypes(data.types);

    mount.appendChild(dom.el('p', 'view-lead', "What's allowed to depend on what — the architecture's node-type × node-type rules. An empty cell means no relation is permitted there. This is allowed, not actual: conformance is the live boundary check below."));

    // The dense grid keeps its intrinsic pixel size and scrolls WITHIN its own container
    // (overflow-x on .mtx-scroll), so a wide matrix never pushes the page into a horizontal
    // scrollbar — it stays legible and contained instead of being scaled down.
    var scroll = dom.el('div', 'mtx-scroll');
    var canvas = document.createElement('canvas');
    canvas.className = 'mtx-canvas';
    canvas.width = ROWLBL + axis.length * CELL + 4;
    canvas.height = HEADER + axis.length * CELL + 4;
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', 'Allowed-relations matrix; a list mirror follows');
    scroll.appendChild(canvas);
    mount.appendChild(scroll);
    drawCanvas(canvas, axis, typesById);

    mount.appendChild(legend());
    mount.appendChild(buildMirror(axis, typesById));
  };
})();
