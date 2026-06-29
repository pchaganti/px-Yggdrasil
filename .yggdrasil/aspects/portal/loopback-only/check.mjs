import { walk, report } from '@chrisdudek/yg/ast';

// Invariant: the portal server binds the LOOPBACK interface only. A loopback bind
// keeps the read-only portal a strictly local window — it is never reachable off the
// machine. Every `.listen(...)` call must pin a loopback host; an external host or an
// OMITTED host (a bare `.listen(port)` binds 0.0.0.0 by default) is a violation.
//
// DETECTION IS AST-ONLY (modelled on the hardened portal aspects):
//   - find member-call expressions whose property is `listen` (e.g. server.listen(...)).
//   - the host is EITHER the second positional argument (server.listen(port, host[, cb]))
//     OR the `host` field of a first-argument options object (server.listen({ port, host })).
//   - the host literal must be one of the loopback addresses. Anything else — a
//     non-loopback string, a non-string expression we cannot prove is loopback, or a
//     missing host — fails. We NEVER scan raw text, so an address inside a comment or an
//     unrelated string is not a false positive.

// The only host literals that bind the loopback interface.
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

/**
 * Resolve a host argument to its loopback string value, following ONE level of same-file
 * const indirection. A literal `'127.0.0.1'` resolves to itself; an identifier bound by a
 * top-level `const HOST = '127.0.0.1'` resolves to that literal (idiomatic, non-gameable —
 * the binding is a static string literal we read from the AST, not runtime state). Anything
 * else (a non-loopback literal, a computed value, an unresolved identifier) returns undefined.
 */
function resolveHost(node, constLiterals) {
  const direct = stringValue(node);
  if (direct !== undefined) return direct;
  if (node && node.type === 'identifier') {
    const bound = constLiterals.get(node.text);
    if (bound !== undefined) return bound;
  }
  return undefined;
}

/** Map every top-level `const NAME = '<string literal>'` to its literal value, for host resolution. */
function collectConstStringLiterals(rootNode) {
  const map = new Map();
  walk(rootNode, (node) => {
    if (node.type !== 'variable_declarator') return true;
    const nameNode = node.childForFieldName('name');
    const valueNode = node.childForFieldName('value');
    if (!nameNode || nameNode.type !== 'identifier' || !valueNode) return true;
    const v = stringValue(valueNode);
    if (v !== undefined) map.set(nameNode.text, v);
    return true;
  });
  return map;
}

/** Literal value of a `string` / no-substitution `template_string` node, else undefined. */
function stringValue(node) {
  if (!node) return undefined;
  if (node.type !== 'string' && node.type !== 'template_string') return undefined;
  if (node.type === 'template_string' && node.namedChildren.some((c) => c.type === 'template_substitution')) {
    return undefined;
  }
  const frag = node.namedChildren.find((c) => c.type === 'string_fragment');
  if (frag) return frag.text;
  const t = node.text;
  return t.length >= 2 ? t.slice(1, -1) : '';
}

/**
 * Resolve the host argument of a `.listen(...)` call to one of:
 *   { kind: 'loopback' }            — a proven loopback host literal
 *   { kind: 'bad', detail: string } — an external bind (wrong literal, none, or unprovable)
 * The host is the second positional argument, or the `host` property of a first-argument
 * object literal. A `.listen()` with no host (bare port) binds all interfaces → 'bad'.
 */
function classifyListenHost(argsNode, constLiterals) {
  const args = argsNode?.namedChildren ?? [];
  if (args.length === 0) {
    return { kind: 'bad', detail: 'no arguments — a bare listen() binds every interface (0.0.0.0)' };
  }

  // Options-object form: server.listen({ port, host }).
  const first = args[0];
  if (first.type === 'object') {
    const hostProp = findObjectProperty(first, 'host');
    if (!hostProp) {
      return { kind: 'bad', detail: 'listen({ ... }) options object has no `host` — binds every interface' };
    }
    const hv = resolveHost(hostProp, constLiterals);
    if (hv === undefined) {
      return { kind: 'bad', detail: '`host` is not a static loopback literal (must be 127.0.0.1 / localhost / ::1)' };
    }
    if (LOOPBACK_HOSTS.has(hv)) return { kind: 'loopback' };
    return { kind: 'bad', detail: `host '${hv}' is not a loopback address` };
  }

  // Positional form: server.listen(port, host[, callback]). The host is arg index 1.
  if (args.length < 2) {
    return { kind: 'bad', detail: 'no host argument — listen(port) binds every interface (0.0.0.0)' };
  }
  const hostArg = args[1];
  const hv = resolveHost(hostArg, constLiterals);
  if (hv === undefined) {
    return { kind: 'bad', detail: 'host argument is not a static loopback literal (must be 127.0.0.1 / localhost / ::1)' };
  }
  if (LOOPBACK_HOSTS.has(hv)) return { kind: 'loopback' };
  return { kind: 'bad', detail: `host '${hv}' is not a loopback address` };
}

/** Return the value node of a `host: <value>` property in an object literal, else undefined. */
function findObjectProperty(objectNode, key) {
  for (const child of objectNode.namedChildren) {
    if (child.type !== 'pair') continue;
    const keyNode = child.childForFieldName('key');
    const valueNode = child.childForFieldName('value');
    if (!keyNode || !valueNode) continue;
    // The key is a property_identifier, a string, or a computed name; match the plain text.
    const keyText = keyNode.type === 'string' ? stringValue(keyNode) : keyNode.text;
    if (keyText === key) return valueNode;
  }
  return undefined;
}

export function check(ctx) {
  const violations = [];

  for (const file of ctx.files) {
    if (!file.ast) continue;

    // Same-file `const NAME = '<loopback>'` bindings, so listen(port, HOST) resolves HOST.
    const constLiterals = collectConstStringLiterals(file.ast.rootNode);

    walk(file.ast.rootNode, (node) => {
      if (node.type !== 'call_expression') return true;
      const fn = node.childForFieldName('function');
      if (!fn || fn.type !== 'member_expression') return true;
      const prop = fn.childForFieldName('property');
      if (!prop || prop.text !== 'listen') return true;

      const result = classifyListenHost(node.childForFieldName('arguments'), constLiterals);
      if (result.kind === 'bad') {
        violations.push(
          report(
            file,
            node,
            `Portal server binds a non-loopback interface (${result.detail}). The portal is a local, ` +
              `read-only window: pass a loopback host to listen() — server.listen(port, '127.0.0.1') ` +
              `(or 'localhost' / '::1'), never 0.0.0.0, '::', an empty host, or an omitted host.`,
          ),
        );
      }
      return true;
    });
  }

  return violations;
}
