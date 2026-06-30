/*
 * V7 Flows — the business-language lens.
 *
 * The only business-language artifact (§3.7, §3a V7): the bridge for a lead or director who
 * never reads code. A gallery of flows by name + description; selecting one shows its detail —
 * participants (declared PLUS auto-expanded descendants, each marked), the flow-level aspects,
 * and each participant's honest verdict state.
 *
 * CRITICAL HONESTY — a flow state has THREE values, never two, and is NEVER green merely
 * because nothing was checked:
 *   - verified        — every participant carrying a rule is verified.
 *   - attention       — any participant pair is refused or unverified (the weakest link).
 *   - nothing-checked — no participant carries a rule at all; a flow can never vanity-green on
 *                       the absence of any rule. Rendered in the distinct no-rule treatment.
 * Every state treatment is read from the one shared honest-state model.
 *
 * Transitions (§3a V7): a flow card → select it (in-view, round-trips via the hash); a
 * participant → its attestation panel (SHELL-panel); a flow aspect → V5 (the rulebook).
 *
 * Browser globals only — reads the already-resolved PortalData; no network, no Node.
 */
(function () {
  'use strict';

  var Yg = (window.YgPortal = window.YgPortal || {});
  var dom = Yg.dom;
  Yg.views = Yg.views || {};

  // The flow state → the honest render state it maps to. 'attention' is signal (warning),
  // 'nothing-checked' is the distinct no-rule treatment — NEVER verified unless truly all-green.
  var FLOW_RENDER_STATE = {
    verified: 'verified',
    attention: 'warning',
    'nothing-checked': 'no-rule',
  };

  // The plain label shown on a flow state pill (the engine's word, said for a human).
  var FLOW_LABEL = {
    verified: 'verified',
    attention: 'weakest-link',
    'nothing-checked': 'nothing-checked',
  };

  function flowRenderState(flow) {
    return FLOW_RENDER_STATE[flow.state] || 'no-rule';
  }

  /** A flow state pill — its color/border comes from the shared honest-state model. */
  function statePill(flow) {
    var rs = flowRenderState(flow);
    var pill = dom.el('span', 'fl-state ' + Yg.states.cssClass(rs));
    pill.appendChild(dom.el('span', null, FLOW_LABEL[flow.state] || flow.state));
    return pill;
  }

  function gallery(flows, selectedName, nav) {
    var col = dom.el('div', 'fl-gallery');
    for (var i = 0; i < flows.length; i += 1) {
      col.appendChild(flowCard(flows[i], flows[i].name === selectedName, nav));
    }
    return col;
  }

  function flowCard(flow, selected, nav) {
    var card = dom.el('button', 'fl-card' + (selected ? ' fl-card-sel' : ''));
    card.type = 'button';
    var top = dom.el('div', 'fl-card-top');
    top.appendChild(dom.el('b', null, flow.name));
    top.appendChild(statePill(flow));
    card.appendChild(top);
    if (flow.description) card.appendChild(dom.el('div', 'fl-card-d', flow.description));
    card.addEventListener('click', function () {
      nav({ view: 'flows', flow: flow.name });
    });
    return card;
  }

  /** Map a node's own state honestly — node.state is already no-rule for an unchecked
   * node (no real verdict-bearing pair), never green, so we read it directly. */
  function nodeState(data, path) {
    var node = (data.nodes || []).filter(function (n) {
      return n.path === path;
    })[0];
    if (!node) return 'no-rule';
    return node.state;
  }

  /** Was a participant declared on the flow, or auto-included as a descendant? */
  function isDeclared(flow, path, data) {
    // A participant is "declared" if it equals a declared node; descendants are auto-included.
    // The contract carries the expanded set only, so we infer: a participant whose parent is
    // also a participant is a descendant; a participant with no participant-parent is declared.
    var node = (data.nodes || []).filter(function (n) {
      return n.path === path;
    })[0];
    if (!node || !node.parent) return true;
    return flow.participants.indexOf(node.parent) === -1;
  }

  function participantRow(flow, path, data, nav) {
    var declared = isDeclared(flow, path, data);
    var state = nodeState(data, path);
    var row = dom.el('button', 'fl-part');
    if (!declared) row.classList.add('fl-part-desc');
    row.type = 'button';
    row.appendChild(Yg.states.badge(state));
    row.appendChild(dom.el('span', 'mono fl-part-path', path));
    row.appendChild(dom.el('span', 'fl-part-tag', declared ? 'declared' : 'descendant'));
    row.addEventListener('click', function () {
      nav({ view: 'tree', node: path });
    });
    return row;
  }

  function detail(flow, data, nav) {
    var box = dom.el('div', 'fl-detail');

    var head = dom.el('div', 'fl-detail-head');
    head.appendChild(dom.el('h2', null, flow.name));
    head.appendChild(statePill(flow));
    box.appendChild(head);
    if (flow.description) box.appendChild(dom.el('p', 'fl-detail-d', flow.description));

    var declaredCount = 0;
    var descCount = 0;
    for (var i = 0; i < flow.participants.length; i += 1) {
      if (isDeclared(flow, flow.participants[i], data)) declaredCount += 1;
      else descCount += 1;
    }
    box.appendChild(
      dom.el(
        'h5',
        'fl-h5',
        'Participants — ' + flow.participants.length + ' (' + declaredCount + ' declared · ' + descCount + ' auto-included descendants)',
      ),
    );
    var parts = dom.el('div', 'fl-parts');
    for (var j = 0; j < flow.participants.length; j += 1) {
      parts.appendChild(participantRow(flow, flow.participants[j], data, nav));
    }
    box.appendChild(parts);

    box.appendChild(dom.el('h5', 'fl-h5', 'Flow aspects (channel 5)'));
    if (flow.aspects && flow.aspects.length) {
      var asp = dom.el('div', 'fl-asps');
      for (var k = 0; k < flow.aspects.length; k += 1) {
        var chip = dom.el('button', 'fl-asp mono');
        chip.type = 'button';
        chip.textContent = flow.aspects[k];
        chip.addEventListener(
          'click',
          (function (id) {
            return function () {
              nav({ view: 'rulebook', aspect: id });
            };
          })(flow.aspects[k]),
        );
        asp.appendChild(chip);
      }
      box.appendChild(asp);
    } else {
      box.appendChild(dom.el('p', 'fl-rel-none', 'No flow-level aspects — flow membership alone attaches no rule.'));
    }

    box.appendChild(
      dom.el(
        'p',
        'fl-foot',
        'A flow with no aspects, or one whose participants are all unguarded, shows nothing-checked — never green. Flow membership attaches rules; it is not evidence of correctness.',
      ),
    );
    return box;
  }

  Yg.views.flows = function (stage, route, data, ctx) {
    var nav = ctx && ctx.navigate ? ctx.navigate : function () {};
    var flows = (data.flows || []).slice();
    var selectedName = route && route.flow ? route.flow : flows.length ? flows[0].name : null;

    stage.appendChild(dom.el('p', 'view-lead', 'Business processes that span components — the only business-language lens. A flow is never just green or red: a flow whose participants are all unguarded shows nothing-checked, and any refused or unverified participant makes the whole flow need attention. Absence of red is not a pass.'));
    stage.appendChild(dom.el('div', 'rb-sub', flows.length + ' flows · flow state is never just green/red'));

    if (!flows.length) {
      stage.appendChild(dom.el('p', 'rb-empty', 'No flows are defined yet — no business processes to lens.'));
      return;
    }

    var layout = dom.el('div', 'fl-layout');
    layout.appendChild(gallery(flows, selectedName, nav));
    var selected = flows.filter(function (f) {
      return f.name === selectedName;
    })[0];
    if (route && route.flow && !selected) {
      // A deep-link to a flow that no longer exists — say so honestly instead of silently
      // presenting a DIFFERENT flow as if the link had resolved.
      var nf = dom.el('div', 'fl-detail');
      nf.appendChild(dom.el('p', 'rb-empty', 'No flow named "' + route.flow + '" — it may have been removed.'));
      layout.appendChild(nf);
    } else {
      layout.appendChild(detail(selected || flows[0], data, nav));
    }
    stage.appendChild(layout);
  };
})();
