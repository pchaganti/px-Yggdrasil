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

/**
 * Lenient parser: split on `## [<datetime>]` at column 0.
 * Lines before the first header are dropped (treated as unparseable preamble).
 * Does NOT validate header well-formedness — that is the format validator's job.
 * Offsets are over UTF-8 bytes of the input string.
 */
export function parseLog(content: string): LogEntry[] {
  if (content === '') return [];

  const bytes = Buffer.from(content, 'utf-8');
  const entries: LogEntry[] = [];

  type Header = { datetime: string; lineOffsetBytes: number };
  const headers: Header[] = [];

  let lineStart = 0;
  for (let i = 0; i <= bytes.length; i++) {
    if (i === bytes.length || bytes[i] === 0x0a /* \n */) {
      const lineBuf = bytes.subarray(lineStart, i);
      const line = lineBuf.toString('utf-8');
      const match = HEADER_LINE.exec(line);
      if (match) {
        headers.push({ datetime: match[1], lineOffsetBytes: lineStart });
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
