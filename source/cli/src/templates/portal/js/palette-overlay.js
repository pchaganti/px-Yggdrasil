/*
 * Command palette overlay — the ⌘K modal DOM, driven by the pure matcher.
 *
 * Builds the search index from PortalData once, then renders a keyboard-first modal:
 * an input, a results list (arrow keys move the active row, Enter routes to it), and a
 * footer of shortcuts. Open with ⌘K / Ctrl-K or the top-bar trigger; close with Esc.
 * Selecting a result hands its route to the router — one navigation code path. The
 * ranking logic lives in palette.js (pure, tested); this file is only the overlay.
 *
 * Browser globals only — no network, no Node.
 */
(function () {
  'use strict';

  var Yg = (window.YgPortal = window.YgPortal || {});
  var dom = Yg.dom;

  /** Create a palette controller bound to a router and a PortalData index. */
  function create(data, router) {
    var index = Yg.paletteSearch.buildIndex(data);
    var overlay = null;
    var input = null;
    var listEl = null;
    var rows = [];
    var active = 0;

    function isOpen() {
      return overlay !== null;
    }

    function renderResults() {
      var query = input ? input.value : '';
      var results = Yg.paletteSearch.search(index, query, 50);
      dom.clear(listEl);
      rows = [];
      active = 0;
      if (results.length === 0) {
        listEl.appendChild(dom.el('div', 'palette-empty', 'No matches.'));
        return;
      }
      for (var i = 0; i < results.length; i += 1) {
        rows.push(appendRow(results[i], i === 0));
      }
    }

    function appendRow(item, isActive) {
      var row = dom.el('div', 'palette-row' + (isActive ? ' on' : ''));
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', isActive ? 'true' : 'false');
      var ic = dom.el('span', 'palette-ic', kindGlyph(item));
      var nm = dom.el('span', 'palette-nm', item.label);
      var sub = dom.el('span', 'palette-sub', item.sub || '');
      var kind = dom.el('span', 'palette-kind', item.kind);
      row.appendChild(ic);
      row.appendChild(nm);
      row.appendChild(sub);
      row.appendChild(kind);
      row.addEventListener('mouseenter', function () {
        setActiveRow(rows.indexOf(row));
      });
      row.addEventListener('click', function () {
        choose(item);
      });
      row._item = item;
      listEl.appendChild(row);
      return row;
    }

    function kindGlyph(item) {
      if (item.kind === 'node') return Yg.states.glyph(item.state || 'no-rule');
      if (item.kind === 'aspect') return '▤';
      if (item.kind === 'flow') return '⤳';
      return '◧';
    }

    function setActiveRow(i) {
      if (i < 0 || i >= rows.length) return;
      if (rows[active]) {
        rows[active].className = 'palette-row';
        rows[active].setAttribute('aria-selected', 'false');
      }
      active = i;
      rows[active].className = 'palette-row on';
      rows[active].setAttribute('aria-selected', 'true');
      rows[active].scrollIntoView({ block: 'nearest' });
    }

    function choose(item) {
      close();
      router.go(item.route);
    }

    function onKey(e) {
      if (e.key === 'Escape') {
        close();
        e.preventDefault();
        return;
      }
      if (e.key === 'ArrowDown') {
        setActiveRow(Math.min(active + 1, rows.length - 1));
        e.preventDefault();
        return;
      }
      if (e.key === 'ArrowUp') {
        setActiveRow(Math.max(active - 1, 0));
        e.preventDefault();
        return;
      }
      if (e.key === 'Enter') {
        if (rows[active] && rows[active]._item) choose(rows[active]._item);
        e.preventDefault();
      }
    }

    function open() {
      if (isOpen()) return;
      overlay = dom.el('div', 'palette-backdrop');
      overlay.setAttribute('role', 'dialog');
      overlay.setAttribute('aria-label', 'Command palette');
      var box = dom.el('div', 'palette-box');
      var inputWrap = dom.el('div', 'palette-input');
      inputWrap.appendChild(dom.el('span', 'palette-search-ic', '⌕'));
      input = document.createElement('input');
      input.type = 'text';
      input.className = 'palette-field';
      input.setAttribute('aria-label', 'Search nodes, aspects, flows, and views');
      input.placeholder = 'Search nodes, aspects, flows…';
      inputWrap.appendChild(input);
      listEl = dom.el('div', 'palette-results');
      listEl.setAttribute('role', 'listbox');
      var foot = dom.el('div', 'palette-foot');
      foot.appendChild(dom.el('span', null, '↑↓ navigate'));
      foot.appendChild(dom.el('span', null, '↵ open'));
      foot.appendChild(dom.el('span', null, 'esc close'));
      box.appendChild(inputWrap);
      box.appendChild(listEl);
      box.appendChild(foot);
      overlay.appendChild(box);

      overlay.addEventListener('click', function (e) {
        if (e.target === overlay) close();
      });
      input.addEventListener('input', renderResults);
      input.addEventListener('keydown', onKey);

      document.body.appendChild(overlay);
      renderResults();
      input.focus();
    }

    function close() {
      if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
      overlay = null;
      input = null;
      listEl = null;
      rows = [];
    }

    function toggle() {
      if (isOpen()) close();
      else open();
    }

    // Global ⌘K / Ctrl-K binding.
    document.addEventListener('keydown', function (e) {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        toggle();
        e.preventDefault();
      }
    });

    return { open: open, close: close, toggle: toggle, isOpen: isOpen };
  }

  Yg.palette = { create: create };
})();
