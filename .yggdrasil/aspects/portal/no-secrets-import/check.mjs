import { walk, report } from '@chrisdudek/yg/ast';

// Ban the portal backend from reaching the secrets-overlay layer. The committed
// config read (loadGraph noSecrets / parseConfig skipSecretsOverlay) is the ONLY
// way the portal sees config — yg-secrets.yaml must be structurally unreachable.
//
// DETECTION IS AST-ONLY (modelled on e2e-public-surface):
//   - import/export declarations whose module specifier resolves to the secrets
//     module are banned wholesale (every symbol from that module is a secrets symbol).
//   - import specifiers / namespace aliases bound to a secrets-reading symbol by
//     IMPORTED name (alias-proof — the imported name is read, not the local alias).
//   - member calls on a namespace alias bound to the secrets module (ns.loadConfigOverlay()).
//   - DYNAMIC import('...secrets-parser...') / import('...config-overlay...') call
//     expressions — the only other static way to reach the module. A `const ns = await
//     import(<secretsModule>)` namespace binding is recorded so later ns.member() calls
//     are caught like a static namespace alias.
//   - a direct filesystem READ whose path argument is a string / no-substitution
//     template literal containing 'yg-secrets' — reading the secrets file off disk
//     bypasses the module ban entirely, so the fs read itself is the violation.
// We NEVER scan raw file text, so a string literal that merely contains a
// secret-shaped word (e.g. a comment or a message) is not a false positive.

// The secrets-overlay module. Match its specifier tail with or without a .js suffix.
// io/config-parser is NOT banned — it is the legitimate committed-config entry point
// that the portal reaches THROUGH the noSecrets flag (enforced by a separate aspect).
// Both the parser module and the overlay-payload module are secrets surface.
const SECRETS_MODULE_RE = /(^|\/)(secrets-parser|config-overlay)(\.js)?$/;

// Symbols that READ or MERGE the secrets overlay, by their exported (imported) name.
const SECRETS_SYMBOLS = new Set(['loadConfigOverlay', 'deepMerge']);

// Filesystem READ APIs (node:fs + fs/promises). A call to one of these whose path
// argument names the secrets file reads it off disk and bypasses the module ban.
const FS_READ_APIS = new Set([
  'readFileSync',
  'readFile',
  'createReadStream',
  'openSync',
  'open',
]);

// The secrets file basename fragment any direct-read path argument must not contain.
const SECRETS_FILE_FRAGMENT = 'yg-secrets';

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
 * Text of a `string` / template_string node EVEN WHEN it interpolates: a path built
 * as `${root}/.yggdrasil/yg-secrets.yaml` still literally contains the secrets file
 * basename, which is all we need to recognise a direct read. We pull the
 * `string_fragment` children's raw text and join them; for a plain string this is the
 * full literal, for an interpolated template it is the static spans around the holes.
 */
function templateStaticText(node) {
  if (!node) return undefined;
  if (node.type === 'string') return stringValue(node);
  if (node.type !== 'template_string') return undefined;
  const frags = node.namedChildren.filter((c) => c.type === 'string_fragment').map((c) => c.text);
  return frags.join('');
}

export function check(ctx) {
  const violations = [];

  for (const file of ctx.files) {
    if (!file.ast) continue;

    // Namespace aliases bound to the secrets module, from a static `import * as s`
    // OR a dynamic `const s = await import('...secrets-parser')`. Member calls on
    // either are caught below.
    const secretsNamespaceAliases = new Set();
    // Local names bound to a secrets fs-read function: `const readFileSync = fs.readFileSync`
    // is uncommon, but `import { readFileSync } from 'node:fs'` and `import * as fs`
    // are. We resolve the fs namespace alias so `fs.readFileSync(...)` is recognised.
    let fsNamespaceAlias = null;

    walk(file.ast.rootNode, (node) => {
      if (node.type === 'import_statement' || node.type === 'export_statement') {
        const source = node.childForFieldName('source');
        const spec = stringValue(source);
        const isSecretsModule = typeof spec === 'string' && SECRETS_MODULE_RE.test(spec);

        if (isSecretsModule) {
          violations.push(
            report(
              file,
              node,
              `Portal backend may not import the secrets-overlay module ('${spec}'). ` +
                `Read config committed-only via loadGraph({ noSecrets: true }) / ` +
                `parseConfig(path, { skipSecretsOverlay: true }); the CLI owns secrets.`,
            ),
          );
          // Record any namespace alias so member calls below are also caught (defense in depth).
          walk(node, (n) => {
            if (n.type === 'namespace_import') {
              const alias = n.namedChildren.find((c) => c.type === 'identifier');
              if (alias) secretsNamespaceAliases.add(alias.text);
            }
          });
          return true;
        }

        // Record a `node:fs` / `fs` namespace alias so `fs.readFileSync(<secrets>)` resolves.
        if (spec === 'fs' || spec === 'node:fs') {
          walk(node, (n) => {
            if (n.type === 'namespace_import') {
              const alias = n.namedChildren.find((c) => c.type === 'identifier');
              if (alias) fsNamespaceAlias = alias.text;
            }
          });
        }

        // Non-secrets module: still ban a secrets symbol imported by name from ANYWHERE
        // (e.g. a future re-export). The IMPORTED name is the first identifier of an
        // import_specifier (the alias, if any, follows `as`).
        walk(node, (n) => {
          if (n.type === 'import_specifier') {
            const importedName = n.namedChildren[0]?.text;
            if (importedName && SECRETS_SYMBOLS.has(importedName)) {
              violations.push(
                report(file, node, `Portal backend may not import secrets symbol '${importedName}'.`),
              );
            }
          }
        });
        return true;
      }

      return true;
    });

    // Second pass over call expressions: dynamic-import of the secrets module,
    // member calls on a secrets namespace alias, and direct fs reads of the secrets file.
    walk(file.ast.rootNode, (node) => {
      if (node.type !== 'call_expression') return true;
      const fn = node.childForFieldName('function');
      if (!fn) return true;
      const args = node.childForFieldName('arguments');

      // Dynamic import('...secrets-parser...'): the callee is the `import` keyword node.
      if (fn.type === 'import') {
        const spec = stringValue(args?.namedChildren[0]);
        if (typeof spec === 'string' && SECRETS_MODULE_RE.test(spec)) {
          violations.push(
            report(
              file,
              node,
              `Portal backend may not dynamically import the secrets-overlay module ('${spec}'). ` +
                `Read config committed-only via loadGraph({ noSecrets: true }); the CLI owns secrets.`,
            ),
          );
        }
        return true;
      }

      // Member call on a secrets-module namespace alias: `s.loadConfigOverlay(...)`.
      if (fn.type === 'member_expression') {
        const obj = fn.childForFieldName('object');
        const prop = fn.childForFieldName('property');
        if (obj && prop && secretsNamespaceAliases.has(obj.text) && SECRETS_SYMBOLS.has(prop.text)) {
          violations.push(
            report(file, node, `Portal backend may not call secrets symbol '${obj.text}.${prop.text}'.`),
          );
          return true;
        }
        // fs read via namespace alias: `fs.readFileSync(<secrets>)`.
        if (obj && prop && fsNamespaceAlias && obj.text === fsNamespaceAlias && FS_READ_APIS.has(prop.text)) {
          if (firstArgNamesSecrets(args)) {
            violations.push(report(file, node, secretsReadMessage(prop.text)));
          }
        }
        return true;
      }

      // Bare fs read: `readFileSync(<secrets>)` (named import or local binding).
      if (fn.type === 'identifier' && FS_READ_APIS.has(fn.text)) {
        if (firstArgNamesSecrets(args)) {
          violations.push(report(file, node, secretsReadMessage(fn.text)));
        }
      }
      return true;
    });

    // Record dynamic-import namespace bindings: `const ns = await import('...secrets-parser')`.
    // Done in a dedicated pass so `ns.loadConfigOverlay()` calls (handled above) are caught
    // even though the binding is discovered structurally rather than via an import statement.
    walk(file.ast.rootNode, (node) => {
      if (node.type !== 'variable_declarator') return true;
      const nameNode = node.childForFieldName('name');
      const valueNode = node.childForFieldName('value');
      if (!nameNode || nameNode.type !== 'identifier' || !valueNode) return true;
      const importCall = unwrapAwaitImport(valueNode);
      if (!importCall) return true;
      const spec = stringValue(importCall.childForFieldName('arguments')?.namedChildren[0]);
      if (typeof spec === 'string' && SECRETS_MODULE_RE.test(spec)) {
        secretsNamespaceAliases.add(nameNode.text);
      }
      return true;
    });

    // Re-scan member calls now that dynamic-import namespace bindings are known, so a
    // `const ns = await import('...secrets-parser'); ns.loadConfigOverlay()` pair both fires.
    if (secretsNamespaceAliases.size > 0) {
      walk(file.ast.rootNode, (node) => {
        if (node.type !== 'call_expression') return true;
        const fn = node.childForFieldName('function');
        if (!fn || fn.type !== 'member_expression') return true;
        const obj = fn.childForFieldName('object');
        const prop = fn.childForFieldName('property');
        if (obj && prop && secretsNamespaceAliases.has(obj.text) && SECRETS_SYMBOLS.has(prop.text)) {
          violations.push(
            report(file, node, `Portal backend may not call secrets symbol '${obj.text}.${prop.text}'.`),
          );
        }
        return true;
      });
    }
  }

  // De-duplicate: a member call can be reported by both the second pass and the
  // re-scan when the alias is static. Keep one violation per (line, column, message).
  const seen = new Set();
  return violations.filter((v) => {
    const key = `${v.line}:${v.column}:${v.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** True iff the call's first argument is a string/template whose static text names the secrets file. */
function firstArgNamesSecrets(argsNode) {
  const first = argsNode?.namedChildren?.[0];
  const text = templateStaticText(first);
  return typeof text === 'string' && text.includes(SECRETS_FILE_FRAGMENT);
}

function secretsReadMessage(api) {
  return (
    `Portal backend may not read the secrets file off disk ('${api}' of a path containing ` +
    `'${SECRETS_FILE_FRAGMENT}'). Read config committed-only via loadGraph({ noSecrets: true }); ` +
    `the CLI owns secrets.`
  );
}

/** If `node` is `await import('...')` or a bare `import('...')`, return the import call_expression. */
function unwrapAwaitImport(node) {
  let expr = node;
  if (expr.type === 'await_expression') {
    expr = expr.namedChildren.find((c) => c.type === 'call_expression') ?? expr.namedChildren[0];
  }
  if (!expr || expr.type !== 'call_expression') return undefined;
  const fn = expr.childForFieldName('function');
  return fn && fn.type === 'import' ? expr : undefined;
}
