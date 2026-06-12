/**
 * Security test: hashTrackedFiles reuseByMtime=false gate
 *
 * Verifies that the yg check gate (reuseByMtime=false) always re-hashes
 * content from disk, closing the touch-mtime exploit where a content change
 * that restores the stored mtime would otherwise produce a false "no drift"
 * result. The approve-time path (reuseByMtime=true default) retains the
 * mtime optimization for performance.
 */
import { describe, it, expect } from 'vitest';
import { writeFile, mkdir, rm, stat, mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { hashTrackedFiles, hashString } from '../../../src/io/hash.js';
import type { TrackedFile } from '../../../src/core/graph/files.js';

describe('hashTrackedFiles — reuseByMtime security', () => {
  it('reuseByMtime=false detects tampered content when mtime is restored to stored value', async () => {
    // Simulates the touch-mtime exploit:
    //   1. Approve runs and stores hash H and mtime M.
    //   2. Attacker changes file content → new mtime M'.
    //   3. Attacker runs `touch -r <orig_file> <target>` to restore mtime to M.
    //   4. yg check sees stored mtime M == on-disk mtime M → reuses stored hash H.
    //   5. Canonical hash matches → no drift → GREEN over changed code.
    //
    // With reuseByMtime=false the check gate always reads disk content,
    // so the new hash H' != H → drift is detected regardless of mtime.
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), `yg-mtime-exploit-${process.pid}-`));
    await mkdir(tmpDir, { recursive: true });
    try {
      const filePath = path.join(tmpDir, 'source.ts');
      await writeFile(filePath, 'export const x = 1;', 'utf-8');

      const trackedFiles: TrackedFile[] = [
        { path: 'source.ts', category: 'source', layer: 'source' },
      ];

      // Baseline: simulate what approve records
      const baseline = await hashTrackedFiles(tmpDir, trackedFiles);
      const storedHash = baseline.fileHashes['source.ts'];

      // Tamper: change content, then forge stored mtime to match current on-disk mtime
      await writeFile(filePath, 'export const x = 999; // tampered', 'utf-8');
      const onDiskMtime = (await stat(filePath)).mtimeMs;
      const storedFileData = {
        hashes: { 'source.ts': storedHash },
        mtimes: { 'source.ts': onDiskMtime }, // forged: stored mtime == on-disk mtime
      };

      // approve path (reuseByMtime=true): reuses the stored hash — exploit succeeds
      const approveResult = await hashTrackedFiles(
        tmpDir, trackedFiles, storedFileData, [], undefined, undefined, true,
      );
      expect(approveResult.fileHashes['source.ts']).toBe(storedHash);

      // check gate (reuseByMtime=false): always re-reads disk — exploit is blocked
      const checkResult = await hashTrackedFiles(
        tmpDir, trackedFiles, storedFileData, [], undefined, undefined, false,
      );
      expect(checkResult.fileHashes['source.ts']).not.toBe(storedHash);
      expect(checkResult.fileHashes['source.ts']).toBe(
        hashString('export const x = 999; // tampered'),
      );
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('reuseByMtime=false still produces correct canonical hash for unchanged content', async () => {
    // Regression guard: disabling the mtime optimization must NOT change the
    // hash when content is genuinely unchanged (same content → same hash).
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), `yg-mtime-unchanged-${process.pid}-`));
    await mkdir(tmpDir, { recursive: true });
    try {
      const filePath = path.join(tmpDir, 'clean.ts');
      await writeFile(filePath, 'export const clean = true;', 'utf-8');

      const trackedFiles: TrackedFile[] = [
        { path: 'clean.ts', category: 'source', layer: 'source' },
      ];

      const baseline = await hashTrackedFiles(tmpDir, trackedFiles);

      // Re-hash with reuseByMtime=false and matching stored data
      const storedFileData = {
        hashes: baseline.fileHashes,
        mtimes: baseline.fileMtimes,
      };
      const recheck = await hashTrackedFiles(
        tmpDir, trackedFiles, storedFileData, [], undefined, undefined, false,
      );

      expect(recheck.canonicalHash).toBe(baseline.canonicalHash);
      expect(recheck.fileHashes['clean.ts']).toBe(baseline.fileHashes['clean.ts']);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});
