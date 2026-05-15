// yg-suppress(deterministic) log entry datetime is functional output of logAdd (returned to caller and written to log.md); Date.now() use is a conscious design decision accepted here
import path from 'node:path';
import type { Graph } from '../../model/graph.js';
import type { IssueMessage } from '../../model/validation.js';
import { validateNodePath } from '../../utils/node-path-validator.js';
import { parseLog } from '../parsing/log-parser.js';
import { readLogSafe, statLogFile, writeLogFile } from '../../io/log-store.js';

export interface LogAddInput {
  graph: Graph;
  nodePath: string;
  reasonText: string;
}

export type LogAddResult =
  | { ok: true; datetime: string; nodePath: string }
  | { ok: false; error: IssueMessage };

export async function logAdd(input: LogAddInput): Promise<LogAddResult> {
  const { graph, reasonText } = input;

  const nv = validateNodePath(input.nodePath.trim().replace(/\\/g, '/').replace(/\/$/, ''));
  if (!nv.ok) {
    return {
      ok: false,
      error: {
        what: `Invalid --node value: ${nv.reason}`,
        why: 'Node path must be POSIX-relative to .yggdrasil/model/ without .. or absolute prefixes.',
        next: 'Use a path like billing/cancel (no leading slash, no model/ prefix).',
      },
    };
  }
  const nodePath = nv.normalized;

  if (!graph.nodes.has(nodePath)) {
    return {
      ok: false,
      error: {
        what: `Node not found: ${nodePath}`,
        why: 'Node must exist in the graph before log entries can be added.',
        next: 'Create yg-node.yaml first, or fix the --node argument.',
      },
    };
  }

  const trimmed = reasonText.trim();
  if (trimmed === '') {
    return {
      ok: false,
      error: {
        what: 'Reason cannot be empty after trim',
        why: 'A log entry must carry justification text.',
        next: 'Provide --reason "<non-empty text>" or a non-empty --reason-file.',
      },
    };
  }

  if (reasonHasLevel2HeaderOutsideFence(reasonText)) {
    return {
      ok: false,
      error: {
        what: 'Reason contains `## ` (level-2 header) outside a code fence',
        why: 'Level-2 headers are reserved for entry headers and would corrupt log structure.',
        next: 'Use ### or deeper for sub-headings, or wrap in ``` fences.',
      },
    };
  }

  const logPath = path.join(graph.rootPath, 'model', nodePath, 'log.md');

  const stats = await statLogFile(logPath);
  if (stats !== null) {
    if (stats.isSymbolicLink) {
      return {
        ok: false,
        error: {
          what: 'log.md is a symbolic link',
          why: 'Symlinks bypass append-only guarantees and break integrity hashing.',
          next: 'Remove the symlink and let yg log add create a regular file.',
        },
      };
    }
    if (stats.hardLinkCount > 1) {
      return {
        ok: false,
        error: {
          what: 'log.md has multiple hard links (st_nlink > 1)',
          why: 'Hardlinks would orphan integrity baselines on atomic rename.',
          next: 'Copy to a unique file and replace the hardlink.',
        },
      };
    }
  }

  const existing = await readLogSafe(logPath);
  const datetime = monotonicNow(lastEntryDatetime(existing));

  const body = reasonText.endsWith('\n') ? reasonText : reasonText + '\n';
  const entry = `## [${datetime}]\n${body}`;
  const newContent =
    existing === ''
      ? entry
      : `${existing.endsWith('\n') ? existing : existing + '\n'}${entry}`;

  await writeLogFile(logPath, newContent);

  return { ok: true, datetime, nodePath };
}

function lastEntryDatetime(content: string): string | null {
  const entries = parseLog(content);
  if (entries.length === 0) return null;
  return entries[entries.length - 1].datetime;
}

function monotonicNow(lastEntry: string | null): string {
  let now = Date.now();
  if (lastEntry !== null) {
    const lastMs = Date.parse(lastEntry);
    if (!Number.isNaN(lastMs) && now <= lastMs) {
      now = lastMs + 1;
    }
  }
  return new Date(now).toISOString();
}

function reasonHasLevel2HeaderOutsideFence(reason: string): boolean {
  const lines = reason.split('\n');
  let fenceOpen = false;
  let fenceLen = 0;
  for (const line of lines) {
    const m = /^(`{3,})(.*)$/.exec(line);
    if (fenceOpen) {
      if (m && m[2].trim() === '' && m[1].length >= fenceLen) fenceOpen = false;
      continue;
    }
    if (m) {
      fenceOpen = true;
      fenceLen = m[1].length;
      continue;
    }
    if (line.startsWith('## ')) return true;
  }
  return false;
}
