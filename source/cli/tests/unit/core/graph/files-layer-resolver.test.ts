import { describe, it, expect } from 'vitest';
import type { TrackedFile } from '../../../../src/core/graph/files.js';
import { buildLayerResolver } from '../../../../src/core/graph/files.js';

/**
 * Characterization tests for buildLayerResolver — the shared drift-layer
 * classifier used by both `yg check` (classifyDrift) and `yg approve`
 * (approveNode). Before extraction these two callers carried slightly different
 * inline copies; this suite pins the unified behavior, in particular the
 * directory-mapping expansion case where they previously diverged.
 */
describe('buildLayerResolver', () => {
  const tf = (path: string, layer: TrackedFile['layer']): TrackedFile => ({
    path,
    category: layer === 'source' || layer === 'deterministic-touched' ? 'source' : 'graph',
    layer,
  });

  it('resolves an exact file path to its tracked layer', () => {
    const resolve = buildLayerResolver([
      tf('src/foo.ts', 'source'),
      tf('.yggdrasil/aspects/a/content.md', 'aspects'),
    ]);
    expect(resolve('src/foo.ts')).toBe('source');
    expect(resolve('.yggdrasil/aspects/a/content.md')).toBe('aspects');
  });

  it('resolves a file expanded from a directory mapping via prefix match', () => {
    // collectTrackedFiles may emit a bare directory entry (layer 'source');
    // the hasher later expands it into individual files. Those expanded paths
    // have no exact entry and must resolve through the directory prefix.
    const resolve = buildLayerResolver([tf('src/svc', 'source')]);
    expect(resolve('src/svc/index.ts')).toBe('source');
    expect(resolve('src/svc/nested/deep.ts')).toBe('source');
  });

  it('prefers an exact match over a directory prefix match', () => {
    const resolve = buildLayerResolver([
      tf('src/svc', 'source'),
      tf('src/svc/index.ts', 'deterministic-touched'),
    ]);
    expect(resolve('src/svc/index.ts')).toBe('deterministic-touched');
  });

  it('returns undefined for a path that is neither tracked nor under a tracked directory', () => {
    const resolve = buildLayerResolver([tf('src/foo.ts', 'source')]);
    expect(resolve('src/bar.ts')).toBeUndefined();
    // A path that merely shares a name prefix (no '/' boundary) is NOT under the dir.
    expect(resolve('src/foo.ts.bak')).toBeUndefined();
  });

  it('normalizes trailing slashes and backslashes on both sides', () => {
    const resolve = buildLayerResolver([tf('src\\svc\\', 'source')]);
    expect(resolve('src/svc/index.ts')).toBe('source');
    expect(resolve('src\\svc\\index.ts')).toBe('source');
    expect(resolve('src/svc')).toBe('source');
  });

  it('keeps the first layer when the same path is tracked under two layers', () => {
    // addFile in collectTrackedFiles is first-writer-wins; the resolver mirrors that.
    const resolve = buildLayerResolver([
      tf('shared/ref.md', 'aspects'),
      tf('shared/ref.md', 'source'),
    ]);
    expect(resolve('shared/ref.md')).toBe('aspects');
  });
});
