import { walk, report } from '@chrisdudek/yg/ast';

// POSITIVE: the portal backend reads config committed-only. Every graph/config
// loader call must pass the literal-true safe flag in its options object:
//   loadGraph(root, { noSecrets: true })
//   loadGraphOrAbort(root, { ..., noSecrets: true })
//   parseConfig(path, { skipSecretsOverlay: true })
// The default read merges yg-secrets.yaml, so an absent / non-literal-true flag
// (e.g. a variable, a computed value, or `false`) is the violation — it would
// silently fall back to the secrets-merging default.
//
// ALIAS-PROOF: the requirement is keyed on the RESOLVED loader SYMBOL, not the
// call-site text. A local alias of a loader — `import { loadGraph as load }` or
// `const lg = loadGraph` — is resolved back to its canonical name before matching,
// so `load(root, {})` and `lg(root, {})` are checked exactly like `loadGraph(...)`.

const REQUIRED_FLAG = {
  loadGraph: 'noSecrets',
  loadGraphOrAbort: 'noSecrets',
  parseConfig: 'skipSecretsOverlay',
};

const LOADER_SYMBOLS = new Set(Object.keys(REQUIRED_FLAG));

/** Trailing name of a callee: bare identifier `f` or member `ns.f` → `f`. */
function calleeName(callNode) {
  const fn = callNode.childForFieldName('function');
  if (!fn) return '';
  if (fn.type === 'identifier') return fn.text;
  if (fn.type === 'member_expression') {
    const prop = fn.childForFieldName('property');
    return prop ? prop.text : '';
  }
  return fn.text.split('.').pop() ?? '';
}

/**
 * True iff one of the call's argument objects has a property `propName` whose
 * value is the literal `true`. We look only at top-level `pair` entries of an
 * `object` argument (not nested), so an unrelated nested true cannot satisfy it.
 */
function passesLiteralTrueFlag(argsNode, propName) {
  if (!argsNode) return false;
  for (const arg of argsNode.namedChildren) {
    if (arg.type !== 'object') continue;
    for (const member of arg.namedChildren) {
      if (member.type !== 'pair') continue;
      const key = member.childForFieldName('key');
      if (!key) continue;
      const keyText = key.text.replace(/['"]/g, '');
      if (keyText !== propName) continue;
      const value = member.childForFieldName('value');
      if (value && value.type === 'true') return true;
    }
  }
  return false;
}

/**
 * Build a map localName → canonical loader symbol for every alias of a loader in
 * this file. Two binding forms are resolved:
 *   - import { loadGraph as load } from '...'  → load → loadGraph
 *   - const lg = loadGraph                     → lg   → loadGraph (only when the RHS
 *     is a bare loader identifier, so we never alias an unrelated value)
 */
function buildLoaderAliases(rootNode) {
  const aliases = new Map();

  walk(rootNode, (node) => {
    // import { loadGraph as load } / import { loadGraph }
    if (node.type === 'import_specifier') {
      const importedName = node.namedChildren[0]?.text;
      if (importedName && LOADER_SYMBOLS.has(importedName)) {
        // The alias (after `as`) is the second named child; absent → same name.
        const aliasName = node.namedChildren[1]?.text ?? importedName;
        aliases.set(aliasName, importedName);
      }
      return true;
    }

    // const lg = loadGraph  (or = load, chaining through a prior alias)
    if (node.type === 'variable_declarator') {
      const nameNode = node.childForFieldName('name');
      const valueNode = node.childForFieldName('value');
      if (nameNode && nameNode.type === 'identifier' && valueNode && valueNode.type === 'identifier') {
        const rhs = valueNode.text;
        const canonical = LOADER_SYMBOLS.has(rhs) ? rhs : aliases.get(rhs);
        if (canonical) aliases.set(nameNode.text, canonical);
      }
      return true;
    }

    return true;
  });

  return aliases;
}

export function check(ctx) {
  const violations = [];

  for (const file of ctx.files) {
    if (!file.ast) continue;

    const aliases = buildLoaderAliases(file.ast.rootNode);

    walk(file.ast.rootNode, (node) => {
      if (node.type !== 'call_expression') return true;
      const calledName = calleeName(node);
      // Resolve the call-site name to a canonical loader symbol via the alias map,
      // falling back to the call-site name itself (a direct, unaliased call).
      const canonical = LOADER_SYMBOLS.has(calledName) ? calledName : aliases.get(calledName);
      const flag = canonical ? REQUIRED_FLAG[canonical] : undefined;
      if (!flag) return true;
      const args = node.childForFieldName('arguments');
      if (!passesLiteralTrueFlag(args, flag)) {
        const via = canonical === calledName ? '' : ` (via alias '${calledName}')`;
        violations.push(
          report(
            file,
            node,
            `${canonical}(...)${via} in the portal backend must pass { ${flag}: true } — the default ` +
              `read merges yg-secrets.yaml. The portal reads config committed-only.`,
          ),
        );
      }
      return true;
    });
  }

  return violations;
}
