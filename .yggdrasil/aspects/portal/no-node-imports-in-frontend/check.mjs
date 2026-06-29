import { walk, report } from '@chrisdudek/yg/ast';

// Frontend (browser) JavaScript must never reach for a Node.js capability. The portal
// frontend runs inside a browser tab from a self-contained file or a loopback page —
// there is no module system, no `process`, no `require`, no Node built-ins. A frontend
// file that reaches for one of those is either dead code or an attempt to do I/O the
// browser cannot do, and it would throw at runtime.
//
// BANNED, AST-only (modelled on e2e-public-surface):
//   - `require(...)`                         — CommonJS, absent in the browser.
//   - dynamic `import(...)` of a `node:` specifier — a Node built-in pulled in dynamically.
//   - a static `import … from 'node:…'`      — a Node built-in imported statically.
//   - a reference to the `process` global    — `process.env`, `process.cwd()`, etc.
//
// A no-substitution template literal specifier (`import(`node:fs`)`) is static and is
// caught like a quoted string. We never scan raw text, so a STRING that merely contains
// the word `process` or `require` (a message, a comment) is not a false positive.
//
// This check runs over `.js` files (which DO parse — javascript grammar). HTML / CSS
// have no grammar, so `file.ast` is undefined for them and they are skipped here; their
// network/CDN surface is covered by no-cdn-no-network, which is content-based.

/** Literal value of a `string` / no-substitution `template_string` node, else undefined. */
function stringValue(node) {
  if (!node) return undefined;
  if (node.type !== 'string' && node.type !== 'template_string') return undefined;
  if (
    node.type === 'template_string' &&
    node.namedChildren.some((c) => c.type === 'template_substitution')
  ) {
    return undefined;
  }
  const frag = node.namedChildren.find((c) => c.type === 'string_fragment');
  if (frag) return frag.text;
  const t = node.text;
  return t.length >= 2 ? t.slice(1, -1) : '';
}

/** True iff a module specifier names a Node.js built-in (the `node:` scheme or a bare core module). */
function isNodeSpecifier(spec) {
  if (typeof spec !== 'string') return false;
  if (spec.startsWith('node:')) return true;
  // The unprefixed core modules a browser bundle would never legitimately reach for.
  const BARE_CORE = new Set([
    'fs',
    'path',
    'os',
    'child_process',
    'crypto',
    'http',
    'https',
    'net',
    'stream',
    'util',
    'url',
    'process',
    'module',
    'worker_threads',
    'vm',
    'zlib',
    'events',
  ]);
  return BARE_CORE.has(spec);
}

export function check(ctx) {
  const violations = [];

  for (const file of ctx.files) {
    if (!file.ast) continue; // HTML / CSS have no grammar — skipped here (see no-cdn-no-network)

    walk(file.ast.rootNode, (node) => {
      // 1. static `import … from 'node:…'` / `export … from 'node:…'`
      if (node.type === 'import_statement' || node.type === 'export_statement') {
        const spec = stringValue(node.childForFieldName('source'));
        if (isNodeSpecifier(spec)) {
          violations.push(
            report(
              file,
              node,
              `Frontend file imports the Node.js built-in '${spec}'. Browser code has no Node ` +
                `runtime — there is no module system, no filesystem, no process. Remove the import; ` +
                `the frontend consumes only the inlined PortalData and the vendored layout lib.`,
            ),
          );
        }
        return true;
      }

      // 2. a bare reference to the `process` global (process.env, process.cwd, …).
      // Catch the identifier `process` when it is the OBJECT of a member access; a bare
      // `process` standing alone is vanishingly rare and the member form is the real smell.
      if (node.type === 'member_expression') {
        const obj = node.childForFieldName('object');
        if (obj && obj.type === 'identifier' && obj.text === 'process') {
          const prop = node.childForFieldName('property');
          violations.push(
            report(
              file,
              node,
              `Frontend file references the Node 'process' global ('process.${prop ? prop.text : ''}'). ` +
                `Browser code has no 'process'. Read configuration from the inlined PortalData instead.`,
            ),
          );
        }
        return true;
      }

      // 3. require(...) and 4. dynamic import('node:…')
      if (node.type === 'call_expression') {
        const fn = node.childForFieldName('function');
        if (!fn) return true;
        const isRequire = fn.type === 'identifier' && fn.text === 'require';
        const isDynamicImport = fn.type === 'import';
        if (!isRequire && !isDynamicImport) return true;

        const spec = stringValue(node.childForFieldName('arguments')?.namedChildren[0]);
        if (isRequire) {
          violations.push(
            report(
              file,
              node,
              `Frontend file uses require(${spec !== undefined ? `'${spec}'` : ''}). CommonJS does not ` +
                `exist in the browser. Remove it; the frontend is plain ES modules / inline script.`,
            ),
          );
          return true;
        }
        // dynamic import — only a Node specifier is a violation; importing a vendored
        // browser module dynamically is legitimate.
        if (isNodeSpecifier(spec)) {
          violations.push(
            report(
              file,
              node,
              `Frontend file dynamically imports the Node.js built-in '${spec}'. Browser code has no ` +
                `Node runtime. Remove the import.`,
            ),
          );
        }
        return true;
      }

      return true;
    });
  }

  return violations;
}
