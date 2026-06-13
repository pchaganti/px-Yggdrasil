/**
 * source/cli/src/utils/binary-extensions.ts
 *
 * Canonical set of file extensions whose content is binary and therefore:
 *   - excluded from LLM review subjects (never entered into a reviewer prompt)
 *   - excluded from prompt character measurement (LLM subject sizing ignores them)
 *   - skipped by the deterministic structure runner (content is not meaningful text;
 *     deterministic subjects keep binary files out of their parsed input)
 *
 * Single source of truth — previously duplicated between:
 *   - core/checks/mapping.ts  (oversized-node budget)
 *   - structure/runner.ts     (deterministic check file expansion)
 * Both sites now import from here. pairs.ts (LLM binary exclusion) also imports it.
 *
 * The two prior copies were byte-for-byte identical; no content divergence.
 */
export const BINARY_EXTENSIONS = new Set([
  '.gif', '.png', '.jpg', '.jpeg', '.webp', '.bmp', '.ico', '.svgz',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.zip', '.gz', '.tgz', '.tar', '.bz2', '.7z',
  '.pdf', '.mp4', '.mov', '.webm', '.mp3', '.wav', '.wasm', '.bin',
]);
