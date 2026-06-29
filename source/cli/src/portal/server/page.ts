import { extractPortalData } from '../extract.js';
import { renderPortalPage, readPortalAsset, type PortalAsset } from '../serializer.js';
import type { PortalData } from '../contract.js';

/**
 * server/page — the data + page assembly for the loopback server.
 *
 * Every responsibility here reaches the engine ONLY through the portal's own modules:
 * `extractPortalData` (the pipeline) for a fresh PortalData, and `renderPortalPage` /
 * `readPortalAsset` (the serializer) for the page HTML and the committed assets. The server
 * declares no relation to any engine subsystem — this is the single seam in action.
 *
 * Refresh is read-only: each call to `freshPortalData` re-runs the extraction from scratch
 * and persists NOTHING — no lock write, no deterministic-cache write, no reviewer call. So
 * the committed lock and the gitignored deterministic cache are byte-unchanged across any
 * number of refreshes.
 */

/**
 * Re-extract a fresh PortalData for `projectRoot`. Fully read-only: `extractPortalData`
 * loads the graph committed-only, reuses the CLI's read-only functions, and writes nothing.
 * `writeEnabled` flows into `meta.writeEnabled` so the page knows whether Approve is offered.
 */
export async function freshPortalData(projectRoot: string, writeEnabled: boolean): Promise<PortalData> {
  return extractPortalData(projectRoot, { writeEnabled });
}

/** Render the live portal page (HTML string) for an already-extracted PortalData. */
export async function renderLivePage(data: PortalData): Promise<string> {
  return renderPortalPage(data);
}

/** Read a committed frontend asset for `/static/*`, or `null` when missing / unsafe. */
export async function readStaticAsset(relPath: string): Promise<PortalAsset | null> {
  return readPortalAsset(relPath);
}
