/*
 * Portal namespace + small DOM/util helpers.
 *
 * Every portal browser module attaches to ONE global, `window.YgPortal`, so the
 * inlined static page (a sequence of plain <script> blocks, no module system) can
 * share code without `import`/`require` — neither exists in a single-file offline
 * page. This is the only place the global is created; later modules extend it.
 *
 * Browser globals only: no Node, no network, no secrets. The portal frontend runs
 * inside a browser tab from a self-contained file or a same-origin loopback page.
 */
(function () {
  'use strict';

  /** The shared namespace — created once, extended by every later module. */
  var Yg = (window.YgPortal = window.YgPortal || {});

  /** Create an element with an optional class and text/child content. */
  function el(tag, cls, content) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (content === undefined || content === null) return node;
    if (typeof content === 'string' || typeof content === 'number') {
      node.textContent = String(content);
    } else if (content.nodeType) {
      node.appendChild(content);
    } else if (Array.isArray(content)) {
      for (var i = 0; i < content.length; i += 1) {
        var c = content[i];
        if (c == null) continue;
        node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
      }
    }
    return node;
  }

  /** Set several attributes at once (skips null/undefined values). */
  function attrs(node, map) {
    for (var k in map) {
      if (!Object.prototype.hasOwnProperty.call(map, k)) continue;
      var v = map[k];
      if (v === null || v === undefined) continue;
      node.setAttribute(k, String(v));
    }
    return node;
  }

  /** Remove every child of an element (cheap, allocation-free clear). */
  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
    return node;
  }

  /** First element matching a selector within `root` (defaults to document). */
  function find(selector, root) {
    return (root || document).querySelector(selector);
  }

  Yg.dom = { el: el, attrs: attrs, clear: clear, find: find };
})();
