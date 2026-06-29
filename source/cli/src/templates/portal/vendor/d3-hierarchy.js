/*
 * d3-hierarchy (vendored subset) — ISC License, Copyright 2010-2021 Mike Bostock.
 * https://github.com/d3/d3-hierarchy
 *
 * Vendored into the Yggdrasil portal as a committed, offline static asset: no runtime
 * npm dependency, no CDN, no network. This is the layout MATH only — hierarchy() builds
 * a node tree from data, and tree() runs the Reingold-Tilford / Buchheim tidy-tree
 * algorithm to assign (x, y) coordinates. All drawing is the portal's own code; this lib
 * supplies coordinates and nothing else. It performs no I/O of any kind.
 *
 * Exposed as the global `d3` (a minimal namespace with `hierarchy` and `tree`), the same
 * surface the portal bootstrap consumes, so swapping in the full upstream package later is
 * a drop-in. Pared to the functions the portal uses; semantics match upstream d3-hierarchy.
 */
(function (global) {
  'use strict';

  // ── hierarchy ────────────────────────────────────────────────────────────────
  function Node(data) {
    this.data = data;
    this.depth = 0;
    this.height = 0;
    this.parent = null;
  }

  Node.prototype = {
    constructor: Node,
    each: function (callback) {
      let index = -1;
      for (const node of this) callback(node, ++index, this);
      return this;
    },
    eachBefore: function (callback) {
      const nodes = [this];
      let node;
      let index = -1;
      while ((node = nodes.pop())) {
        callback(node, ++index, this);
        const children = node.children;
        if (children) for (let i = children.length - 1; i >= 0; --i) nodes.push(children[i]);
      }
      return this;
    },
    descendants: function () {
      const out = [];
      this.each((n) => out.push(n));
      return out;
    },
    links: function () {
      const root = this;
      const links = [];
      root.each((node) => {
        if (node !== root) links.push({ source: node.parent, target: node });
      });
      return links;
    },
  };

  Node.prototype[Symbol.iterator] = function* () {
    let node = this;
    let current = [node];
    let next = [];
    do {
      next = [];
      for (node of current) {
        yield node;
        const children = node.children;
        if (children) for (const child of children) next.push(child);
      }
      current = next;
    } while (next.length);
  };

  function computeHeight(node) {
    let height = 0;
    do {
      node.height = height;
      node = node.parent;
    } while (node && node.height < ++height);
  }

  function hierarchy(data, children) {
    if (data instanceof Map) {
      data = [undefined, data];
      if (children === undefined) children = mapChildren;
    } else if (children === undefined) {
      children = objectChildren;
    }

    const root = new Node(data);
    const nodes = [root];
    let node;
    let child;
    let childs;
    let i;
    let n;

    while ((node = nodes.pop())) {
      if ((childs = children(node.data)) && (n = (childs = Array.from(childs)).length)) {
        node.children = childs;
        for (i = n - 1; i >= 0; --i) {
          nodes.push((child = childs[i] = new Node(childs[i])));
          child.parent = node;
          child.depth = node.depth + 1;
        }
      }
    }

    return root.eachBefore(computeHeight);
  }

  function objectChildren(d) {
    return d.children;
  }
  function mapChildren(d) {
    return Array.isArray(d) ? d[1] : null;
  }

  // ── tree (tidy tree — Buchheim/Walker) ─────────────────────────────────────────
  function defaultSeparation(a, b) {
    return a.parent === b.parent ? 1 : 2;
  }

  function nextLeft(v) {
    const children = v.children;
    return children ? children[0] : v.t;
  }
  function nextRight(v) {
    const children = v.children;
    return children ? children[children.length - 1] : v.t;
  }
  function moveSubtree(wm, wp, shift) {
    const change = shift / (wp.i - wm.i);
    wp.c -= change;
    wp.s += shift;
    wm.c += change;
    wp.z += shift;
    wp.m += shift;
  }
  function executeShifts(v) {
    let shift = 0;
    let change = 0;
    const children = v.children;
    let i = children.length;
    let w;
    while (--i >= 0) {
      w = children[i];
      w.z += shift;
      w.m += shift;
      shift += w.s + (change += w.c);
    }
  }
  function nextAncestor(vim, v, ancestor) {
    return vim.a.parent === v.parent ? vim.a : ancestor;
  }

  function TreeNode(node, i) {
    this._ = node;
    this.parent = null;
    this.children = null;
    this.A = null; // default ancestor
    this.a = this; // ancestor
    this.z = 0; // prelim
    this.m = 0; // mod
    this.c = 0; // change
    this.s = 0; // shift
    this.t = null; // thread
    this.i = i; // number
  }
  TreeNode.prototype = Object.create(Node.prototype);

  function treeRoot(root) {
    const tree = new TreeNode(root, 0);
    let node;
    const nodes = [tree];
    let child;
    let children;
    let i;
    let n;

    while ((node = nodes.pop())) {
      if ((children = node._.children)) {
        node.children = new Array((n = children.length));
        for (i = n - 1; i >= 0; --i) {
          nodes.push((child = node.children[i] = new TreeNode(children[i], i)));
          child.parent = node;
        }
      }
    }

    (tree.parent = new TreeNode(null, 0)).children = [tree];
    return tree;
  }

  function tree() {
    let separation = defaultSeparation;
    let dx = 1;
    let dy = 1;
    let nodeSize = null;

    function layout(root) {
      const t = treeRoot(root);

      t.eachAfter(firstWalk);
      t.parent.m = -t.z;
      t.eachBefore(secondWalk);

      if (nodeSize) root.eachBefore(sizeNode);
      else {
        let left = root;
        let right = root;
        let bottom = root;
        root.eachBefore((node) => {
          if (node.x < left.x) left = node;
          if (node.x > right.x) right = node;
          if (node.depth > bottom.depth) bottom = node;
        });
        const s = left === right ? 1 : separation(left, right) / 2;
        const tx = s - left.x;
        const kx = dx / (right.x + s + tx);
        const ky = dy / (bottom.depth || 1);
        root.eachBefore((node) => {
          node.x = (node.x + tx) * kx;
          node.y = node.depth * ky;
        });
      }

      return root;
    }

    function firstWalk(v) {
      const children = v.children;
      const siblings = v.parent.children;
      const w = v.i ? siblings[v.i - 1] : null;
      if (children) {
        executeShifts(v);
        const midpoint = (children[0].z + children[children.length - 1].z) / 2;
        if (w) {
          v.z = w.z + separation(v._, w._);
          v.m = v.z - midpoint;
        } else {
          v.z = midpoint;
        }
      } else if (w) {
        v.z = w.z + separation(v._, w._);
      }
      v.parent.A = apportion(v, w, v.parent.A || siblings[0]);
    }

    function secondWalk(v) {
      v._.x = v.z + v.parent.m;
      v.m += v.parent.m;
    }

    function apportion(v, w, ancestor) {
      if (w) {
        let vip = v;
        let vop = v;
        let vim = w;
        let vom = vip.parent.children[0];
        let sip = vip.m;
        let sop = vop.m;
        let sim = vim.m;
        let som = vom.m;
        let shift;
        while (((vim = nextRight(vim)), (vip = nextLeft(vip)), vim && vip)) {
          vom = nextLeft(vom);
          vop = nextRight(vop);
          vop.a = v;
          shift = vim.z + sim - vip.z - sip + separation(vim._, vip._);
          if (shift > 0) {
            moveSubtree(nextAncestor(vim, v, ancestor), v, shift);
            sip += shift;
            sop += shift;
          }
          sim += vim.m;
          sip += vip.m;
          som += vom.m;
          sop += vop.m;
        }
        if (vim && !nextRight(vop)) {
          vop.t = vim;
          vop.m += sim - sop;
        }
        if (vip && !nextLeft(vom)) {
          vom.t = vip;
          vom.m += sip - som;
          ancestor = v;
        }
      }
      return ancestor;
    }

    function sizeNode(node) {
      node.x *= dx;
      node.y = node.depth * dy;
    }

    layout.separation = function (x) {
      if (arguments.length) {
        separation = x;
        return layout;
      }
      return separation;
    };
    layout.size = function (x) {
      if (arguments.length) {
        nodeSize = false;
        dx = +x[0];
        dy = +x[1];
        return layout;
      }
      return nodeSize ? null : [dx, dy];
    };
    layout.nodeSize = function (x) {
      if (arguments.length) {
        nodeSize = true;
        dx = +x[0];
        dy = +x[1];
        return layout;
      }
      return nodeSize ? [dx, dy] : null;
    };

    return layout;
  }

  // eachAfter is needed by the tree layout; add it to the prototype.
  Node.prototype.eachAfter = function (callback) {
    const nodes = [this];
    const next = [];
    let node;
    let index = -1;
    while ((node = nodes.pop())) {
      next.push(node);
      const children = node.children;
      if (children) for (let i = 0, n = children.length; i < n; ++i) nodes.push(children[i]);
    }
    while ((node = next.pop())) callback(node, ++index, this);
    return this;
  };

  const d3 = { hierarchy: hierarchy, tree: tree };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = d3;
  } else {
    global.d3 = Object.assign(global.d3 || {}, d3);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
