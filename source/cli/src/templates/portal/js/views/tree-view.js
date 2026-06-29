/*
 * V3 Structure — the node tree view.
 *
 * The where-does-X-live spine (§3a V3). It reuses the shared DOM-virtualized node tree
 * (Yg.tree) so the hierarchy stays responsive at 300–1000+ nodes, colors each row by its
 * own honest state (read from the one shared honest-state model — never an invented green),
 * and routes a row click to that node's attestation panel via the §3a "tree row → SHELL-panel"
 * transition. A short honest preface states what the coloring means so the absence of red is
 * never mistaken for a pass.
 *
 * Browser globals only — reads the already-resolved PortalData; no network, no Node.
 */
(function () {
  'use strict';

  var Yg = (window.YgPortal = window.YgPortal || {});
  var dom = Yg.dom;
  Yg.views = Yg.views || {};

  /**
   * Render the structure tree into `stage`. `ctx.onSelect(path)` routes a row to the node's
   * attestation panel (§3a: tree row → SHELL-panel). The shared count header + honest legend
   * are rendered by the dispatcher around this body.
   */
  Yg.views.tree = function (stage, route, data, ctx) {
    var intro = dom.el('p', 'view-lead');
    intro.appendChild(
      document.createTextNode('The component hierarchy. Each row carries its '),
    );
    var ownState = Yg.glossary ? Yg.glossary.term('verified', 'own state') : dom.el('span', null, 'own state');
    intro.appendChild(ownState);
    intro.appendChild(
      document.createTextNode(
        ' — kept separate from a roll-up over its children, so one refused leaf never falsely reddens an ancestor. Click a row to open it.',
      ),
    );
    stage.appendChild(intro);

    var mount = dom.el('section', 'tree-mount');
    stage.appendChild(mount);
    Yg.tree.render(mount, data, function (path) {
      if (ctx && ctx.onSelect) ctx.onSelect(path);
    });
  };
})();
