import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeNodeDriftState, readNodeDriftState } from '../../../src/io/drift-state-store.js';
import type { DriftNodeState } from '../../../src/model/drift.js';

describe('DriftNodeState.aspectVerdicts persistence', () => {
  it('writes per-aspect verdicts and reads them back', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'drift-verdicts-'));
    try {
      const driftDir = join(dir, '.yggdrasil');
      await mkdir(driftDir, { recursive: true });
      const state: DriftNodeState = {
        hash: 'abc',
        files: { 'a.ts': 'sha1' },
        aspectVerdicts: {
          'audit-log': { verdict: 'approved' },
          'diagnostic-logging': { verdict: 'refused', reason: 'no diagnostic-id', errorSource: 'codeViolation' },
        },
      };
      await writeNodeDriftState(driftDir, 'orders/handler', state);
      const read = await readNodeDriftState(driftDir, 'orders/handler');
      expect(read?.aspectVerdicts?.['audit-log'].verdict).toBe('approved');
      expect(read?.aspectVerdicts?.['diagnostic-logging'].verdict).toBe('refused');
      expect(read?.aspectVerdicts?.['diagnostic-logging'].reason).toBe('no diagnostic-id');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
