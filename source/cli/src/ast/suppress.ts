import { extname } from 'node:path';
import type { Tree } from 'web-tree-sitter';
import { findComments } from './find-comments.js';
import { getLanguageForExtension } from '../core/graph/language-registry.js';

export interface SuppressedRange {
  aspectIds: Set<string>;
  startLine: number;   // 1-based, inclusive
  endLine: number;     // 1-based, inclusive
  isWildcard: boolean;
}

export class SuppressMarkerError extends Error {
  public readonly code = 'SUPPRESS_MARKER_MISSING_REASON';
  constructor(message: string, public file: string, public line: number) {
    super(message);
    this.name = 'SuppressMarkerError';
  }
}

interface ParsedMarker {
  kind: 'single' | 'disable' | 'enable';
  aspectIds: string[];
  reason: string;
  line: number; // 1-based
}

// `m` flag: a marker may ride inside a multi-line `/* ... */` block comment whose
// body keeps its inner newlines. Without `m`, `$` anchors to end-of-string and the
// reason group `(.+)?` cannot cross a newline, so a single-line marker on the first
// line of a multi-line block matched nothing and the waiver was silently lost. With
// `m`, `$` matches end-of-line and the reason is captured on the marker's own line.
const RE_SINGLE  = /\byg-suppress\(\s*([^)]+?)\s*\)\s*(.+)?$/m;
const RE_DISABLE = /\byg-suppress-disable\(\s*([^)]+?)\s*\)\s*(.+)?$/m;
const RE_ENABLE  = /\byg-suppress-enable\(\s*([^)]+?)\s*\)/;

function commentBody(text: string): string {
  if (text.startsWith('//')) return text.slice(2).trim();
  if (text.startsWith('/*')) return text.replace(/^\/\*+/, '').replace(/\*+\/$/, '').trim();
  return text.trim();
}

function splitAspectList(raw: string): string[] {
  return raw.split(',').map(s => s.trim()).filter(Boolean);
}

function makeMarker(kind: 'single' | 'disable', match: RegExpMatchArray, line: number, file: string): ParsedMarker {
  const aspectIds = splitAspectList(match[1]);
  const reason = (match[2] ?? '').trim();
  if (reason === '') {
    throw new SuppressMarkerError(
      `yg-suppress${kind === 'disable' ? '-disable' : ''}(${match[1]}) missing reason at ${file}:${line}`,
      file,
      line,
    );
  }
  return { kind, aspectIds, reason, line };
}

function parseMarker(commentText: string, line: number, file: string): ParsedMarker | null {
  const body = commentBody(commentText);
  let m = body.match(RE_DISABLE);
  if (m) return makeMarker('disable', m, line, file);
  m = body.match(RE_ENABLE);
  if (m) {
    return { kind: 'enable', aspectIds: splitAspectList(m[1]), reason: '', line };
  }
  m = body.match(RE_SINGLE);
  if (m) return makeMarker('single', m, line, file);
  return null;
}

/**
 * Build the suppressed-line ranges for a file.
 *
 * Two collection strategies, chosen by whether the file's extension has a
 * registered tree-sitter grammar:
 *
 * - AST path (registered grammar + a parsed `tree`): markers are read from the
 *   file's comment nodes, so a `yg-suppress(...)` that merely appears inside a
 *   string literal is never mistaken for a real marker.
 * - Text path (no registered grammar, e.g. `.sql`/`.md`/`.sh`): the parse tree
 *   cannot be produced, so markers are found by scanning the raw lines of
 *   `content`. This is what lets a content-only deterministic check suppress a
 *   violation in a non-AST-language file. Requires `content` to be supplied; if
 *   it is omitted for such a file, no ranges are produced (nothing to scan).
 *
 * The range-building logic below is identical for both strategies.
 */
export function collectSuppressions(
  tree: Tree | undefined,
  file: string,
  totalLines: number,
  content?: string,
): SuppressedRange[] {
  const hasGrammar = getLanguageForExtension(extname(file)) !== null;
  const markers: ParsedMarker[] = [];
  if (hasGrammar && tree) {
    const comments = findComments({ path: file, ast: tree });
    for (const c of comments) {
      const m = parseMarker(c.text, c.startPosition.row + 1, file);
      if (m) markers.push(m);
    }
  } else if (content !== undefined) {
    // No grammar (or no tree): scan raw lines. parseMarker tolerates a leading
    // comment delimiter (`--`, `#`, `;` …) because the marker regexes anchor on
    // the distinctive `yg-suppress` token, not on comment syntax.
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const m = parseMarker(lines[i], i + 1, file);
      if (m) markers.push(m);
    }
  } else {
    // A non-AST file with no content to scan — nothing is suppressible.
    return [];
  }
  markers.sort((a, b) => a.line - b.line);

  const ranges: SuppressedRange[] = [];
  const openSpecific = new Map<string, number>();
  let openWildcard: number | null = null;

  for (const m of markers) {
    if (m.kind === 'single') {
      const isWildcard = m.aspectIds.includes('*');
      ranges.push({ aspectIds: new Set(m.aspectIds), startLine: m.line + 1, endLine: m.line + 1, isWildcard });
    } else if (m.kind === 'disable') {
      for (const id of m.aspectIds) {
        if (id === '*') { if (openWildcard === null) openWildcard = m.line + 1; }
        else { if (!openSpecific.has(id)) openSpecific.set(id, m.line + 1); }
      }
    } else { // enable
      for (const id of m.aspectIds) {
        if (id === '*') {
          if (openWildcard !== null) {
            ranges.push({ aspectIds: new Set(['*']), startLine: openWildcard, endLine: m.line - 1, isWildcard: true });
            openWildcard = null;
          }
        } else {
          const start = openSpecific.get(id);
          if (start !== undefined) {
            ranges.push({ aspectIds: new Set([id]), startLine: start, endLine: m.line - 1, isWildcard: false });
            openSpecific.delete(id);
          }
        }
      }
    }
  }

  if (openWildcard !== null) ranges.push({ aspectIds: new Set(['*']), startLine: openWildcard, endLine: totalLines, isWildcard: true });
  for (const [id, start] of openSpecific) {
    ranges.push({ aspectIds: new Set([id]), startLine: start, endLine: totalLines, isWildcard: false });
  }

  return ranges;
}

export function isLineSuppressed(ranges: SuppressedRange[], aspectId: string, line: number): boolean {
  return ranges.some(r => {
    if (line < r.startLine || line > r.endLine) return false;
    return r.isWildcard || r.aspectIds.has(aspectId);
  });
}

// ── Line scanner (no tree-sitter) ────────────────────────────

export interface SuppressionMarkerInfo {
  line: number;       // 1-based
  aspectId: string;   // single aspect id (one entry per aspect per marker)
  kind: 'single' | 'disable' | 'enable';
  wildcard: boolean;
  reason: string;
}

/**
 * Match the marker regexes against ONE line of text and append any markers it
 * carries (one entry per listed aspect id) to `out`, stamped with `lineNum`.
 * Disable beats enable beats single, exactly like the parse-side `parseMarker`.
 * Shared by the raw-line scanner and the comment-only scanner so the two paths
 * cannot diverge on which token counts as a marker.
 */
function scanLineInto(raw: string, lineNum: number, out: SuppressionMarkerInfo[]): void {
  let m: RegExpMatchArray | null;

  m = raw.match(RE_DISABLE);
  if (m) {
    const ids = splitAspectList(m[1]);
    const reason = (m[2] ?? '').trim();
    for (const id of ids) {
      out.push({ line: lineNum, aspectId: id, kind: 'disable', wildcard: id === '*', reason });
    }
    return;
  }

  m = raw.match(RE_ENABLE);
  if (m) {
    const ids = splitAspectList(m[1]);
    for (const id of ids) {
      out.push({ line: lineNum, aspectId: id, kind: 'enable', wildcard: id === '*', reason: '' });
    }
    return;
  }

  m = raw.match(RE_SINGLE);
  if (m) {
    const ids = splitAspectList(m[1]);
    const reason = (m[2] ?? '').trim();
    for (const id of ids) {
      out.push({ line: lineNum, aspectId: id, kind: 'single', wildcard: id === '*', reason });
    }
    return;
  }
}

/**
 * Language-agnostic raw-line scan for yg-suppress markers.
 * Reuses the existing regex constants — no tree-sitter required.
 * Emits one SuppressionMarkerInfo entry per (line × aspectId) combination.
 * Skips lines where no marker regex matches.
 *
 * This scans EVERY line, including ones inside string literals, so it is the
 * right tool ONLY for files with no registered grammar (`.sql`, `.sh` …) where
 * there is no parse tree to tell comment from code — mirroring the honoring
 * path's text fallback in `collectSuppressions`. For a parseable language, use
 * `scanSuppressionMarkersInComments` so a marker that merely appears inside a
 * string literal is not mistaken for a real waiver.
 */
export function scanSuppressionMarkers(text: string): SuppressionMarkerInfo[] {
  const lines = text.split('\n');
  const result: SuppressionMarkerInfo[] = [];
  for (let i = 0; i < lines.length; i++) {
    scanLineInto(lines[i], i + 1, result);
  }
  return result;
}

/**
 * Comment-only scan for yg-suppress markers, for files with a registered
 * tree-sitter grammar. Walks the parse tree's COMMENT nodes (via the same
 * `findComments` the reviewer-honoring `collectSuppressions` uses) and matches
 * the marker regexes only against comment text — never string literals or other
 * code. This is what keeps the `yg suppressions` inventory aligned with what the
 * reviewer actually honors: a `yg-suppress(...)` written inside a string literal
 * (e.g. a test fixture or a template that documents the marker syntax) is NOT a
 * real waiver and must not be inventoried.
 *
 * Line numbers are mapped back to absolute, 1-based file lines using each
 * comment node's start row, so a marker on the Nth line of a multi-line block
 * comment is reported at the correct file line.
 */
export function scanSuppressionMarkersInComments(tree: Tree, file: string): SuppressionMarkerInfo[] {
  const result: SuppressionMarkerInfo[] = [];
  const comments = findComments({ path: file, ast: tree });
  for (const c of comments) {
    const startRow = c.startPosition.row; // 0-based
    const commentLines = c.text.split('\n');
    for (let i = 0; i < commentLines.length; i++) {
      scanLineInto(commentLines[i], startRow + i + 1, result);
    }
  }
  // A file may contain several comment nodes; emit markers in file order so the
  // inventory and the per-file disable/enable pairing see them top-to-bottom.
  result.sort((a, b) => a.line - b.line);
  return result;
}
