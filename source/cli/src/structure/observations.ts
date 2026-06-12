/** Collects result-bearing observations during one check.mjs run (spec §3.1).
 *  Keys/hashes come from core/pair-hash.ts — the frozen contract. */

import {
  observationKey,
  hashReadObservation,
  hashListObservation,
  hashExistsObservation,
} from '../core/pair-hash.js';

export class ObservationRecorder {
  private readonly _entries = new Map<string, string>(); // key → hash (first-wins)
  private _tainted = false;

  /** Record a file-read observation. `bytes` is the raw content read. */
  recordRead(repoRelPosixPath: string, bytes: Buffer): void {
    this._record(observationKey('read', repoRelPosixPath), hashReadObservation(bytes));
  }

  /** Record a directory-listing observation. */
  recordList(repoRelPosixDir: string, entries: Array<{ name: string; kind: 'file' | 'dir' }>): void {
    this._record(observationKey('list', repoRelPosixDir), hashListObservation(entries));
  }

  /** Record an existence-probe observation (including negative probes where result === false). */
  recordExists(repoRelPosixPath: string, result: 'file' | 'dir' | false): void {
    this._record(observationKey('exists', repoRelPosixPath), hashExistsObservation(result));
  }

  /** Record a graph-node observation by hashing its yg-node.yaml bytes. */
  recordGraphNode(nodePath: string, ygNodeYamlBytes: Buffer): void {
    this._record(observationKey('graph', nodePath), hashReadObservation(ygNodeYamlBytes));
  }

  /**
   * Returns a sorted, deduplicated array of [observationKey, observationHash] pairs.
   * Re-observing the same key with a different hash sets `tainted = true` and keeps
   * the first hash (first-observation-wins).
   */
  snapshot(): Array<[string, string]> {
    const result = [...this._entries.entries()];
    result.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return result;
  }

  /** True if the same path was observed with different content during this run. */
  get tainted(): boolean {
    return this._tainted;
  }

  private _record(key: string, hash: string): void {
    const existing = this._entries.get(key);
    if (existing === undefined) {
      this._entries.set(key, hash);
    } else if (existing !== hash) {
      // Same key, different hash: file changed mid-run — taint the run.
      this._tainted = true;
      // Keep first observation (do not overwrite).
    }
    // Same key, same hash: idempotent — no-op.
  }
}
