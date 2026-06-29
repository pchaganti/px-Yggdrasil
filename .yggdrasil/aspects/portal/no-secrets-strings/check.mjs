import { walk } from '@chrisdudek/yg/ast';

// The portal frontend never touches secrets — the CLI owns keys, and the page reads only
// the committed-config-derived PortalData (which never carries a secret). A frontend file
// that even MENTIONS the secrets file or an api_key field is a red flag: either it is
// trying to surface a secret, or it is dead code that suggests the secrets boundary was
// misunderstood. So a frontend STRING LITERAL containing 'yg-secrets' or 'api_key' is a
// violation.
//
// AST-based for JS (we inspect string / template-literal nodes, so the word 'api_key' in
// a comment or an identifier is NOT a violation — only a real string literal is). HTML and
// CSS have no grammar, so for them we fall back to a content scan that fires only on a
// quoted occurrence of the fragment, mirroring the literal-only intent.

const SECRET_FRAGMENTS = ['yg-secrets', 'api_key'];

/** Static text of a string / template_string node (joining static spans of a template), else undefined. */
function literalText(node) {
  if (!node) return undefined;
  if (node.type === 'string') {
    const frag = node.namedChildren.find((c) => c.type === 'string_fragment');
    if (frag) return frag.text;
    const t = node.text;
    return t.length >= 2 ? t.slice(1, -1) : '';
  }
  if (node.type === 'template_string') {
    return node.namedChildren
      .filter((c) => c.type === 'string_fragment')
      .map((c) => c.text)
      .join('');
  }
  return undefined;
}

function matchFragment(text) {
  if (typeof text !== 'string') return undefined;
  const lower = text.toLowerCase();
  return SECRET_FRAGMENTS.find((f) => lower.includes(f));
}

export function check(ctx) {
  const violations = [];

  for (const file of ctx.files) {
    if (file.ast) {
      walk(file.ast.rootNode, (node) => {
        if (node.type === 'string' || node.type === 'template_string') {
          const hit = matchFragment(literalText(node));
          if (hit) {
            violations.push({
              file: file.path,
              line: node.startPosition.row + 1,
              column: node.startPosition.column,
              message:
                `Frontend file has a string literal containing '${hit}'. The frontend never touches ` +
                `secrets — the CLI owns keys and the page reads only the committed-config PortalData. ` +
                `Remove the reference.`,
            });
          }
          return true;
        }
        return true;
      });
      continue;
    }

    // Non-parseable (HTML / CSS): content scan, only on a QUOTED occurrence of the fragment.
    const lines = file.content.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      for (const frag of SECRET_FRAGMENTS) {
        const re = new RegExp(`["'\`][^"'\`]*${frag.replace(/[-_]/g, '\\$&')}`, 'i');
        const m = re.exec(line);
        if (m) {
          violations.push({
            file: file.path,
            line: i + 1,
            column: m.index,
            message:
              `Frontend file has a quoted string containing '${frag}'. The frontend never touches ` +
              `secrets — remove the reference.`,
          });
          break;
        }
      }
    }
  }

  return violations;
}
