/*
 * V6 Type Model — the architecture vocabulary as CAPABILITY DISCOVERY.
 *
 * "What Yggdrasil can enforce here, and how", seen live on your repo (§3.5/§3a V6). Every node
 * TYPE the architecture defines, as a card: its description, whether it classifies files or is
 * organizational, its strict / log flags, its live node-count, what it may nest under (parents),
 * what it may depend on (the allowed-relations matrix row), and the rules it carries by default.
 *
 * This surface renders no verdict state — it is the architecture's grammar, not a pass/fail of
 * any code — so it deliberately paints no green: the relation hues are relation TYPES, never a
 * verdict, and a node-count is a fact, not an approval. The honest-state model still owns every
 * verdict color elsewhere; this view simply never claims one.
 *
 * Transitions (§3a V6): a default-rule chip → V5 (that rule in the rulebook); "nodes of this
 * type" → V3 (the structure tree). Browser globals only; reads the resolved PortalData; no Node.
 */
(function () {
  'use strict';

  var Yg = (window.YgPortal = window.YgPortal || {});
  var dom = Yg.dom;
  Yg.views = Yg.views || {};

  // Relation type → a stable, colorblind-safe hue (a relation TYPE marker, never a verdict state).
  var REL_COLOR = {
    calls: '#0d74ce',
    uses: '#208368',
    extends: '#9a6700',
    implements: '#8e4ec6',
    emits: '#d6409f',
    listens: '#d6409f',
  };

  /** The "may depend on" line: each allowed relation type with its permitted target types. */
  function dependsOn(allowed) {
    var wrap = dom.el('div', 'ty-rels');
    var any = false;
    for (var rel in allowed) {
      if (!Object.prototype.hasOwnProperty.call(allowed, rel)) continue;
      var targets = (allowed[rel] || []).filter(function (t) {
        return t !== 'deny' && t !== 'default';
      });
      if (!targets.length) continue;
      any = true;
      var group = dom.el('span', 'ty-relgroup');
      var label = dom.el('b', 'ty-reltype');
      label.style.color = REL_COLOR[rel] || 'var(--text-secondary)';
      label.textContent = rel;
      group.appendChild(label);
      group.appendChild(dom.el('span', 'ty-reltargets', ' ' + targets.join(' · ')));
      wrap.appendChild(group);
    }
    if (!any) wrap.appendChild(dom.el('span', 'ty-rel-none', '— structural parent only (no code dependency permitted)'));
    return wrap;
  }

  /** The default-rules line: each rule a clickable chip routing to its detail in V5. */
  function defaultRules(aspects, nav) {
    if (!aspects || !aspects.length) return dom.el('span', 'ty-rel-none', '—');
    var wrap = dom.el('span', 'ty-asps');
    for (var i = 0; i < aspects.length; i += 1) {
      var chip = dom.el('button', 'ty-asp mono');
      chip.type = 'button';
      chip.textContent = aspects[i];
      chip.addEventListener(
        'click',
        (function (id) {
          return function () {
            nav({ view: 'rulebook', aspect: id });
          };
        })(aspects[i]),
      );
      wrap.appendChild(chip);
    }
    return wrap;
  }

  function typeCard(type, nav) {
    var card = dom.el('div', 'ty-card');

    var head = dom.el('div', 'ty-head');
    head.appendChild(dom.el('b', 'mono ty-name', type.id));
    var classifying = (type.parents && type.parents.length >= 0) && hasRelationsOrAspects(type);
    head.appendChild(dom.el('span', 'ty-badge ' + (type.nodeCount >= 0 && classifying ? 'ty-badge-cls' : 'ty-badge-org'), classifying ? 'classifying' : 'organizational'));
    if (type.strict) head.appendChild(dom.el('span', 'ty-badge ty-badge-strict', 'strict'));
    if (type.logRequired) head.appendChild(dom.el('span', 'ty-badge ty-badge-log', 'log'));

    var count = dom.el('button', 'ty-count');
    count.type = 'button';
    count.textContent = type.nodeCount + (type.nodeCount === 1 ? ' node' : ' nodes');
    count.addEventListener('click', function () {
      nav({ view: 'tree', type: type.id });
    });
    head.appendChild(count);
    card.appendChild(head);

    if (type.description) card.appendChild(dom.el('div', 'ty-desc', type.description));

    var kv = dom.el('dl', 'ty-kv');
    kv.appendChild(dom.el('dt', null, 'nests under'));
    var parents = dom.el('dd', 'mono', (type.parents && type.parents.length) ? type.parents.join(' · ') : '— (top level)');
    kv.appendChild(parents);

    kv.appendChild(dom.el('dt', null, 'may depend on'));
    var dd = dom.el('dd');
    dd.appendChild(dependsOn(type.allowedRelations || {}));
    kv.appendChild(dd);

    kv.appendChild(dom.el('dt', null, 'default rules'));
    var ddR = dom.el('dd');
    ddR.appendChild(defaultRules(type.defaultAspects, nav));
    kv.appendChild(ddR);
    card.appendChild(kv);

    return card;
  }

  /** A type that defines relations or default aspects classifies files; otherwise organizational. */
  function hasRelationsOrAspects(type) {
    var rels = type.allowedRelations || {};
    for (var rel in rels) {
      if (!Object.prototype.hasOwnProperty.call(rels, rel)) continue;
      var targets = (rels[rel] || []).filter(function (t) {
        return t !== 'deny' && t !== 'default';
      });
      if (targets.length) return true;
    }
    return (type.defaultAspects && type.defaultAspects.length > 0) || type.strict === true;
  }

  function summary(types) {
    var strict = 0;
    var logged = 0;
    for (var i = 0; i < types.length; i += 1) {
      if (types[i].strict) strict += 1;
      if (types[i].logRequired) logged += 1;
    }
    return types.length + ' types · ' + strict + ' strict (every matching file must be captured) · ' + logged + ' log-gated (changes must record a reason)';
  }

  Yg.views.types = function (stage, route, data, ctx) {
    var nav = ctx && ctx.navigate ? ctx.navigate : function () {};
    var types = (data.types || []).slice();

    stage.appendChild(dom.el('p', 'view-lead', 'Every kind of component the architecture defines — what it may depend on, and the rules it carries by default. This is what is possible and how, seen live on your repo. It is the grammar, not a verdict: nothing here is green or red.'));
    stage.appendChild(dom.el('div', 'rb-sub', summary(types)));

    var grid = dom.el('div', 'ty-grid');
    for (var i = 0; i < types.length; i += 1) {
      grid.appendChild(typeCard(types[i], nav));
    }
    stage.appendChild(grid);
  };
})();
