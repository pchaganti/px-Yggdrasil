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

const RE_SINGLE  = /\byg-suppress\(\s*([^)]+?)\s*\)\s*(.+)?$/;
const RE_DISABLE = /\byg-suppress-disable\(\s*([^)]+?)\s*\)\s*(.+)?$/;
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

export function collectSuppressions(tree: Tree, file: string, totalLines: number): SuppressedRange[] {
  // Guard: if the file extension has no known language, we cannot resolve
  // comment node types — return empty rather than throwing.
  if (getLanguageForExtension(extname(file)) === null) {
    return [];
  }
  const comments = findComments({ path: file, ast: tree });
  const markers: ParsedMarker[] = [];
  for (const c of comments) {
    const m = parseMarker(c.text, c.startPosition.row + 1, file);
    if (m) markers.push(m);
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
