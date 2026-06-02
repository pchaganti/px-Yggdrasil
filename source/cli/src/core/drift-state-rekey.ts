/**
 * Pure, lossless re-key of a pre-typed (flat-synthetic-key) drift-state
 * baseline into the typed DriftNodeState format. No I/O.
 *
 * Placed in core/ (not migrations/) so it can be a plain pure helper: the
 * `migration` node type carries `enforce: strict` + migration-only aspects
 * (migration-idempotent, migration-bumps-version, …) that a pure transform
 * cannot satisfy. This mirrors the core/format-detect.ts precedent — a
 * migration-supporting pure predicate that lives in core/ and is imported by
 * the migration. The to-5.0.0 migration wires this in (a later task).
 *
 * The OLD on-disk shape stuffed synthetic string keys into `files{}`:
 *   own-subset:<nodePath>      → identity.ownSubset
 *   aspect-meta:<aspectId>     → identity.aspects[id].meta
 *   tier-identity:<aspectId>   → identity.aspects[id].tier
 *   check-touched:<aspectId>   → (the per-aspect read-set summary hash; the
 *                                 typed format stores the actual map instead, so
 *                                 this summary key is dropped — the map is
 *                                 reconstructed from the old `checkTouchedFiles`)
 *   port-aspects:<targetPath>  → identity.ports[targetPath]
 * plus the old top-level fields:
 *   checkTouchedFiles          → identity.aspects[id].checkTouched
 *   aspectVerdicts (optional)  → aspectVerdicts (synthesize {} when absent —
 *                                 the relocated isLegacyBaseline choice)
 *
 * The canonical `hash` is recomputed with the NEW scheme over the SAME logical
 * inputs (files + typed identity), so a fresh `yg check` over unchanged source
 * sees no drift.
 */
import type { DriftNodeState, DriftIdentity, AspectIdentity, AspectVerdict } from '../model/drift.js';
import { DRIFT_STATE_SCHEMA_VERSION } from '../model/drift.js';
import { computeCanonicalHash } from '../io/hash.js';

/** A pre-typed flat baseline as read off disk before re-keying. */
export interface FlatDriftBaseline {
  hash?: string;
  files?: Record<string, string>;
  mtimes?: Record<string, number>;
  aspectVerdicts?: Record<string, AspectVerdict>;
  checkTouchedFiles?: Record<string, Record<string, string>>;
  log?: { last_entry_datetime: string; prefix_hash: string };
  [key: string]: unknown;
}

const OWN_SUBSET_PREFIX = 'own-subset:';
const ASPECT_META_PREFIX = 'aspect-meta:';
const TIER_IDENTITY_PREFIX = 'tier-identity:';
const CHECK_TOUCHED_PREFIX = 'check-touched:';
const PORT_ASPECTS_PREFIX = 'port-aspects:';

/** Get (or create) the AspectIdentity for an id within an in-progress map. */
function aspectSlot(aspects: Record<string, AspectIdentity>, id: string): AspectIdentity {
  const existing = aspects[id];
  if (existing) return existing;
  const fresh: AspectIdentity = { meta: '' };
  aspects[id] = fresh;
  return fresh;
}

/**
 * Re-key a single flat baseline into the typed DriftNodeState. Pure; throws on
 * a structurally-unusable input (e.g. a non-object), which the caller treats as
 * a corrupt baseline to drop.
 */
export function rekeyDriftBaseline(oldFlat: FlatDriftBaseline): DriftNodeState {
  if (oldFlat === null || typeof oldFlat !== 'object') {
    throw new Error('drift-state-rekey: baseline is not an object');
  }

  const realFiles: Record<string, string> = {};
  const aspects: Record<string, AspectIdentity> = {};
  const ports: Record<string, string> = {};
  let ownSubset: string | undefined;

  for (const [key, value] of Object.entries(oldFlat.files ?? {})) {
    if (typeof value !== 'string') continue;
    if (key.startsWith(OWN_SUBSET_PREFIX)) {
      ownSubset = value;
    } else if (key.startsWith(ASPECT_META_PREFIX)) {
      aspectSlot(aspects, key.slice(ASPECT_META_PREFIX.length)).meta = value;
    } else if (key.startsWith(TIER_IDENTITY_PREFIX)) {
      aspectSlot(aspects, key.slice(TIER_IDENTITY_PREFIX.length)).tier = value;
    } else if (key.startsWith(CHECK_TOUCHED_PREFIX)) {
      // The old per-aspect read-set SUMMARY hash. The typed format stores the
      // actual checkTouched MAP (from checkTouchedFiles) instead, so this
      // summary key is intentionally dropped — its information is fully
      // reconstructed below from checkTouchedFiles.
      aspectSlot(aspects, key.slice(CHECK_TOUCHED_PREFIX.length));
    } else if (key.startsWith(PORT_ASPECTS_PREFIX)) {
      ports[key.slice(PORT_ASPECTS_PREFIX.length)] = value;
    } else {
      // A real source/graph file path.
      realFiles[key] = value;
    }
  }

  // Move the old per-aspect touched-file maps into the typed identity.
  for (const [aspectId, pathMap] of Object.entries(oldFlat.checkTouchedFiles ?? {})) {
    if (!pathMap || typeof pathMap !== 'object') continue;
    aspectSlot(aspects, aspectId).checkTouched = { ...pathMap };
  }

  const identity: DriftIdentity = {
    // ownSubset must always be a hash; the empty-string digest is the stable
    // fallback for a baseline that never recorded one (e.g. a log-only node).
    ownSubset: ownSubset ?? '',
    ports,
    aspects,
  };

  // Pre-verdict baseline → synthesize {} (the relocated isLegacyBaseline choice:
  // treat every effective aspect as implicitly approved rather than flooding
  // aspect-newly-active on first post-upgrade check).
  const aspectVerdicts: Record<string, AspectVerdict> = oldFlat.aspectVerdicts ?? {};

  const state: DriftNodeState = {
    schemaVersion: DRIFT_STATE_SCHEMA_VERSION,
    // Recompute with the NEW canonical scheme over the SAME logical inputs:
    // files + typed identity + the (possibly synthesized-empty) verdict set that
    // is also stored below. The verdict fold must use the SAME aspectVerdicts the
    // baseline persists, so a fresh `yg check` over unchanged source sees no drift.
    hash: computeCanonicalHash(realFiles, identity, aspectVerdicts),
    files: realFiles,
    identity,
    aspectVerdicts,
  };
  if (oldFlat.mtimes !== undefined) state.mtimes = oldFlat.mtimes;
  if (oldFlat.log !== undefined) state.log = oldFlat.log;
  return state;
}
