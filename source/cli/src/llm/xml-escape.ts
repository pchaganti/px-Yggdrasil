export function escapeXmlText(s: string, opts: { attribute: boolean }): string {
  let result = '';
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    if (ch === '&') { result += '&amp;'; continue; }
    if (ch === '<') { result += '&lt;'; continue; }
    if (ch === '>') { result += '&gt;'; continue; }
    if (opts.attribute && ch === '"') { result += '&quot;'; continue; }
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) {
      result += `&#x${code.toString(16).padStart(2, '0')};`;
      continue;
    }
    result += ch;
  }
  return result;
}
