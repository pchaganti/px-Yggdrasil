/**
 * Log entry parsed from log.md.
 * Byte offsets are over UTF-8 bytes of the input string.
 */
export interface LogEntry {
  /** ISO 8601 UTC with millisecond precision */
  datetime: string;
  /** Body content between this header line (exclusive) and next header (exclusive) */
  body: string;
  /** Byte offset of the `## [` header line start */
  offsetStart: number;
  /** Byte offset of the NEXT entry's `## [` line start, or byte length of content if last */
  offsetEnd: number;
}

const HEADER_LINE = /^## \[([^\]]+)\]\s*$/;
const FENCE_LINE = /^(`{3,})(.*)$/;

/**
 * Lenient parser: split on `## [<datetime>]` at column 0.
 * Lines before the first header are dropped (treated as unparseable preamble).
 * Does NOT validate header well-formedness — that is the format validator's job.
 * CommonMark backtick-fence aware (same rules as validateFormat): a `## [...]`
 * line inside an open ```` ``` ```` fence is body text, not an entry header — so
 * parseLog and validateFormat agree on entry boundaries.
 * Offsets are over UTF-8 bytes of the input string.
 */
export function parseLog(content: string): LogEntry[] {
  if (content === '') return [];

  const bytes = Buffer.from(content, 'utf-8');
  const entries: LogEntry[] = [];

  type Header = { datetime: string; lineOffsetBytes: number };
  const headers: Header[] = [];

  let lineStart = 0;
  let fenceOpen = false;
  let fenceOpenLen = 0;
  for (let i = 0; i <= bytes.length; i++) {
    if (i === bytes.length || bytes[i] === 0x0a /* \n */) {
      const lineBuf = bytes.subarray(lineStart, i);
      const line = lineBuf.toString('utf-8');
      const fenceMatch = FENCE_LINE.exec(line);
      if (fenceOpen) {
        // A closing fence is a bare run of >= the opening length, with no info string.
        if (fenceMatch && fenceMatch[2].trim() === '' && fenceMatch[1].length >= fenceOpenLen) {
          fenceOpen = false;
        }
        // Inside an open fence: never a header.
      } else if (fenceMatch) {
        fenceOpen = true;
        fenceOpenLen = fenceMatch[1].length;
      } else {
        const match = HEADER_LINE.exec(line);
        if (match) {
          headers.push({ datetime: match[1], lineOffsetBytes: lineStart });
        }
      }
      lineStart = i + 1;
    }
  }

  for (let i = 0; i < headers.length; i++) {
    const h = headers[i];
    const offsetStart = h.lineOffsetBytes;
    const offsetEnd = i + 1 < headers.length ? headers[i + 1].lineOffsetBytes : bytes.length;
    const headerLineEnd = bytes.indexOf(0x0a, offsetStart);
    const bodyStart = headerLineEnd >= 0 && headerLineEnd < offsetEnd ? headerLineEnd + 1 : offsetEnd;
    const body = bytes.subarray(bodyStart, offsetEnd).toString('utf-8');
    entries.push({ datetime: h.datetime, body, offsetStart, offsetEnd });
  }

  return entries;
}
