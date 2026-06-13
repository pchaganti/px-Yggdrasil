/**
 * source/cli/src/core/log/log-gate.ts — shared, read-only log-gate primitives
 * (spec §9).
 *
 * The fill stage (core/fill.ts) USES these to enforce the mandatory-entry gate
 * and record the append-only baseline at positive closure; `yg context` USES the
 * same primitives to DISPLAY the gate state without writing anything. Extracting
 * them here keeps one implementation of the freshness rule and avoids pulling the
 * full fill module (with its LLM-provider dependencies) into the context path.
 */

import { createHash } from 'node:crypto';
import path from 'node:path';

import { parseLog } from '../parsing/log-parser.js';
import { readTextFile } from '../../io/graph-fs.js';
import { debugWrite } from '../../utils/debug-log.js';

/** Read a node's log.md content; empty string when absent. */
export async function readLogContent(projectRoot: string, nodePath: string): Promise<string> {
  const logAbs = path.join(projectRoot, '.yggdrasil', 'model', nodePath, 'log.md');
  try {
    return await readTextFile(logAbs);
  } catch (e: unknown) {
    debugWrite(`[log-gate] readLogContent: could not read ${logAbs}: ${e instanceof Error ? e.message : String(e)}`);
    return '';
  }
}

/**
 * True when the log contains an entry NEWER than the last baselined one. With no
 * prior log baseline, any entry counts as fresh. (Ported from approve.ts; spec §9.)
 */
export function hasFreshLogEntry(
  logContent: string,
  storedLog: { last_entry_datetime: string } | undefined,
): boolean {
  const newest = parseLog(logContent).at(-1);
  if (!newest) return false;
  if (!storedLog) return true;
  return newest.datetime !== storedLog.last_entry_datetime;
}

/**
 * Compute the append-only log baseline (boundary datetime + prefix hash over
 * bytes [0..newest.offsetEnd)). Returns undefined when the log has no entries.
 * (Ported from approve.ts computeLogBaseline; spec §9.)
 */
export async function computeLogBaselineForNode(
  projectRoot: string,
  nodePath: string,
): Promise<{ last_entry_datetime: string; prefix_hash: string } | undefined> {
  const content = await readLogContent(projectRoot, nodePath);
  return computeLogBaselineFromContent(content);
}

/**
 * Compute the append-only log baseline from already-loaded content (boundary
 * datetime + prefix hash over bytes [0..newest.offsetEnd)). Returns undefined
 * when the log has no entries. This is the byte-range the validateAppendOnly
 * contract verifies — NOT the whole file (spec §9).
 */
export function computeLogBaselineFromContent(
  content: string,
): { last_entry_datetime: string; prefix_hash: string } | undefined {
  const entries = parseLog(content);
  if (entries.length === 0) return undefined;
  const newest = entries[entries.length - 1];
  const bytes = Buffer.from(content, 'utf-8');
  const prefix = bytes.subarray(0, newest.offsetEnd);
  return {
    last_entry_datetime: newest.datetime,
    prefix_hash: createHash('sha256').update(prefix).digest('hex'),
  };
}
