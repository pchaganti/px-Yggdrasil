/*
 * Node tree — a DOM-virtualized, honest-state hierarchy.
 *
 * Builds the nested parent/child tree from the flat PortalNode[] (parent links), lays it
 * out with the vendored d3-hierarchy tidy-tree so depth/order are real (not hand-rolled),
 * and renders it as a DOM list — accessible, find-in-page, keyboard-reachable. To stay
 * responsive on a large real graph (300–1000+ nodes) the list is VIRTUALIZED: only the
 * rows in (and a small overscan around) the scroll viewport are in the DOM; a spacer holds
 * the full scroll height so the scrollbar is honest.
 *
 * buildForest / flattenLayout are PURE over plain data (no DOM) so the tree shape is
 * unit-testable; the virtualization is the thin DOM layer. Browser globals only — the
 * vendored d3 layout is the only dependency, already on the page. No network, no Node.
 */
(function () {
  'use strict';

  var Yg = (window.YgPortal = window.YgPortal || {});
  var dom = Yg.dom;
  var ROW_H = 28; // px per row (matches the token grid)
  var OVERSCAN = 8;

  /**
   * Build a nested {node, children} forest from the flat PortalNode[] via parent links,
   * under one synthetic root so a multi-root graph lays out as a single tree. Children are
   * kept in input order (the pipeline emits a stable order). Pure — returns plain objects.
   */
  function buildForest(nodes) {
    var byPath = {};
    var list = nodes || [];
    for (var i = 0; i < list.length; i += 1) {
      byPath[list[i].path] = { node: list[i], children: [] };
    }
    var roots = [];
    for (var j = 0; j < list.length; j += 1) {
      var n = list[j];
      var entry = byPath[n.path];
      var parent = n.parent ? byPath[n.parent] : null;
      if (parent) parent.children.push(entry);
      else roots.push(entry);
    }
    return { node: { path: '', name: 'graph', type: 'root', state: 'no-rule' }, children: roots };
  }

  /**
   * Flatten the forest into an ordered, depth-tagged row list using the vendored
   * d3-hierarchy layout when present (real tidy-tree order), falling back to a plain
   * depth-first walk otherwise. Each row is { node, depth }. Pure over the forest + the
   * (optional) injected d3 — testable by passing a d3 stub or none.
   */
  function flattenLayout(forest, d3) {
    var rows = [];
    if (d3 && d3.hierarchy && d3.tree) {
      var h = d3.hierarchy(forest);
      d3.tree().nodeSize([1, 1])(h);
      h.eachBefore(function (d) {
        if (!d.data.node.path) return; // skip synthetic root
        rows.push({ node: d.data.node, depth: d.depth - 1 });
      });
      return rows;
    }
    walk(forest, -1, rows);
    return rows;
  }

  function walk(entry, depth, out) {
    if (entry.node.path) out.push({ node: entry.node, depth: depth });
    for (var i = 0; i < entry.children.length; i += 1) walk(entry.children[i], depth + 1, out);
  }

  /**
   * Render a virtualized tree into `mount` from `data`, calling `onSelect(path)` when a row
   * is activated (click / Enter). Returns a controller exposing `destroy()`. Only the visible
   * window of rows is materialized; scrolling re-materializes the window — so a 1000-node
   * graph paints a couple dozen rows, not a thousand.
   */
  function render(mount, data, onSelect) {
    var d3 = window.d3;
    var rows = flattenLayout(buildForest(data.nodes || []), d3);

    var scroller = dom.el('div', 'tree-scroller');
    scroller.setAttribute('role', 'tree');
    var spacer = dom.el('div', 'tree-spacer');
    spacer.style.height = rows.length * ROW_H + 'px';
    var win = dom.el('div', 'tree-window');
    spacer.appendChild(win);
    scroller.appendChild(spacer);
    mount.appendChild(scroller);

    function paint() {
      var top = scroller.scrollTop;
      var height = scroller.clientHeight || ROW_H * 24;
      var first = Math.max(0, Math.floor(top / ROW_H) - OVERSCAN);
      var last = Math.min(rows.length, Math.ceil((top + height) / ROW_H) + OVERSCAN);
      dom.clear(win);
      win.style.transform = 'translateY(' + first * ROW_H + 'px)';
      for (var i = first; i < last; i += 1) win.appendChild(buildRow(rows[i], onSelect));
    }

    scroller.addEventListener('scroll', paint);
    paint();

    return {
      rowCount: rows.length,
      destroy: function () {
        scroller.removeEventListener('scroll', paint);
        if (scroller.parentNode) scroller.parentNode.removeChild(scroller);
      },
    };
  }

  function buildRow(row, onSelect) {
    var n = row.node;
    var li = dom.el('div', 'tree-row ' + Yg.states.cssClass(n.state));
    li.setAttribute('role', 'treeitem');
    li.setAttribute('tabindex', '0');
    li.setAttribute('data-path', n.path);
    li.style.paddingLeft = 12 + row.depth * 16 + 'px';
    li.appendChild(Yg.states.badge(n.state));
    li.appendChild(dom.el('span', 'tree-name', n.name || n.path));
    li.appendChild(dom.el('span', 'tree-type', n.type || ''));
    function activate() {
      if (onSelect) onSelect(n.path);
    }
    li.addEventListener('click', activate);
    li.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') {
        activate();
        e.preventDefault();
      }
    });
    return li;
  }

  Yg.tree = { buildForest: buildForest, flattenLayout: flattenLayout, render: render, ROW_H: ROW_H };
})();
