import { codePointCanonicalJson } from '../core/pair-hash.js';
import { hashString } from '../io/hash.js';

export type Outcome =
  | { ownerNode: string; resolvedFile: string; resolvedFileHash: string; basis: string }
  | { external: true }
  | { missing: true };

export interface DepOutcome { fromFile: string; line: number; hintKey: string; outcome: Outcome }

export interface FingerprintInput {
  sources: Array<[string, string]>;          // [path, contentHash], will be sorted
  relations: string;                          // hash of this node's declared relations
  outcomes: DepOutcome[];                      // every DETECTED dep (resolved or not)
  grammarVersions: Array<[string, string]>;   // [language, extractorVersionTag], sorted
  indexIdentity: string;                       // hash over the symbol-language source-set identity
}

export function computeFingerprint(input: FingerprintInput): string {
  const canonical = {
    sources: [...input.sources].sort(cmpPair),
    relations: input.relations,
    outcomes: [...input.outcomes].sort(cmpOutcome),
    grammarVersions: [...input.grammarVersions].sort(cmpPair),
    indexIdentity: input.indexIdentity,
  };
  const json = codePointCanonicalJson(canonical);
  return hashString(json);
}

function cmpPair(a: [string, string], b: [string, string]): number { return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0); }
function cmpOutcome(a: DepOutcome, b: DepOutcome): number {
  const ka = `${a.fromFile}\0${a.line}\0${a.hintKey}`, kb = `${b.fromFile}\0${b.line}\0${b.hintKey}`;
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}
