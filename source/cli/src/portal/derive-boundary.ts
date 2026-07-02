import type { PortalBoundary, BoundaryInput } from './contract.js';

/**
 * derive-boundary — the single responsibility of building the portal's LIVE boundary from the
 * relation pass's classified edges. Split out of derive-rest so each derivation file stays a
 * focused child under the export cap.
 *
 * `input === null` ⇒ the relation parse could not run ⇒ `unknown: true` and empty classes
 * (NEVER fabricate a clean boundary). Otherwise the three classes are surfaced verbatim,
 * deduped and stably sorted, and `unknown` is false.
 */
export function buildBoundary(input: BoundaryInput | null): PortalBoundary {
  if (input === null) {
    return { phantom: [], declaredOnly: [], forbiddenType: [], unknown: true };
  }
  return {
    phantom: dedupeEdges(input.phantom),
    declaredOnly: dedupeEdges(input.declaredOnly),
    forbiddenType: dedupeEdges(input.forbiddenType),
    unknown: false,
  };
}

function dedupeEdges(edges: Array<{ source: string; target: string }>): Array<{ source: string; target: string }> {
  const seen = new Set<string>();
  const out: Array<{ source: string; target: string }> = [];
  for (const e of edges) {
    const key = `${e.source}\0${e.target}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out.sort((a, b) => a.source.localeCompare(b.source, 'en') || a.target.localeCompare(b.target, 'en'));
}
