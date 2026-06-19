// =============================================================================
// Regression test: yg check output must survive pipe truncation.
//
// Pre-fix behaviour: `formatOutput` wrote a large string via process.stdout.write()
// then called process.exit(1) immediately. When stdout was a PIPE (exactly what
// spawnSync produces), the kernel-side buffer drained asynchronously; process.exit()
// terminated the process before the buffer was fully consumed, silently truncating
// the rendered error list. The symptom: `Errors (N)` header reported e.g. 595 but
// only 168 rendered blocks reached the pipe consumer.
//
// Fix: exitAfterFlush() in src/cli/check.ts waits for process.stdout.writableLength
// to drain before calling process.exit(). This guarantees the full report survives.
//
// This test creates a graph with many LLM-aspect nodes so that `yg check` (cold,
// no lock) produces well over 200 unverified error blocks in a single run, then
// asserts that the count of rendered blocks in PIPED stdout equals the N from the
// "Errors (N)" header AND N > 200. A regression of the truncation bug would cause
// the rendered count to be less than N, breaking the assertion.
// =============================================================================

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');

const distExists = existsSync(BIN_PATH);

// A loopback reviewer endpoint that is never dialed by `yg check`.
const LOOPBACK_ENDPOINT = 'http://127.0.0.1:11434';

// Number of nodes to create. Each node gets 3 LLM aspects (from architecture
// type defaults) = 3 × NODE_COUNT unverified aspect pairs. These nodes have no
// cross-node dependency, so the live relation pass adds no error blocks.
// 75 nodes × 3 aspects = 225 unverified aspect errors (well above the 200 threshold).
const NODE_COUNT = 75;

/**
 * Build a hermetic tmp project containing NODE_COUNT nodes each with 3 LLM
 * aspects (attached via architecture type default aspects).  With no lock file
 * present, every (node, aspect) pair is unverified → `yg check` exits 1 and
 * emits 225 unverified error blocks through the pipe.
 */
function buildFlushFixture(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'yg-check-output-flush-'));
  const ygRoot = path.join(dir, '.yggdrasil');

  mkdirSync(path.join(ygRoot, 'model'), { recursive: true });
  mkdirSync(path.join(ygRoot, 'aspects'), { recursive: true });
  mkdirSync(path.join(ygRoot, 'flows'), { recursive: true });

  // Three LLM aspects. Content is minimal but valid — the reviewer is never
  // invoked by `yg check` (only by fill), so the content text is irrelevant to
  // the assertion. What matters is that these are LLM aspects (content.md
  // present, no check.mjs) so they produce `unverified` errors on a cold lock.
  for (const id of ['must-have-header', 'must-have-exports', 'must-have-types']) {
    const aDir = path.join(ygRoot, 'aspects', id);
    mkdirSync(aDir, { recursive: true });
    writeFileSync(
      path.join(aDir, 'yg-aspect.yaml'),
      [
        `name: ${id}`,
        'description: Regression flush test aspect',
        'status: enforced',
        '',
      ].join('\n'),
      'utf-8',
    );
    writeFileSync(
      path.join(aDir, 'content.md'),
      `# ${id}\n\nEvery file must satisfy ${id}.\n`,
      'utf-8',
    );
  }

  // Architecture: one node type with the three LLM aspects as defaults, so
  // every node of this type automatically carries all three aspects without
  // needing to list them individually in each yg-node.yaml.
  writeFileSync(
    path.join(ygRoot, 'yg-architecture.yaml'),
    [
      'node_types:',
      '  svc:',
      "    description: 'Service node for flush regression test'",
      '    log_required: false',
      '    when:',
      '      path: "src/**"',
      '    aspects:',
      '      - must-have-header',
      '      - must-have-exports',
      '      - must-have-types',
      '',
    ].join('\n'),
    'utf-8',
  );

  // Config: one tier (never dialed — check is read-only).
  writeFileSync(
    path.join(ygRoot, 'yg-config.yaml'),
    [
      'quality:',
      '  max_direct_relations: 10',
      'reviewer:',
      '  tiers:',
      '    standard:',
      '      provider: ollama',
      '      consensus: 1',
      '      config:',
      '        model: test',
      `        endpoint: ${LOOPBACK_ENDPOINT}`,
      '',
    ].join('\n'),
    'utf-8',
  );

  // NODE_COUNT nodes, each mapped to a small source file.
  const srcDir = path.join(dir, 'src');
  mkdirSync(srcDir, { recursive: true });
  for (let i = 0; i < NODE_COUNT; i++) {
    const nodeName = `svc${String(i).padStart(3, '0')}`;
    const nodeDir = path.join(ygRoot, 'model', nodeName);
    mkdirSync(nodeDir, { recursive: true });
    writeFileSync(
      path.join(nodeDir, 'yg-node.yaml'),
      [
        `name: Service ${nodeName}`,
        'type: svc',
        'description: Flush regression test node',
        'aspects: []',
        'relations: []',
        'mapping:',
        `  - src/${nodeName}.ts`,
        '',
      ].join('\n'),
      'utf-8',
    );
    writeFileSync(
      path.join(srcDir, `${nodeName}.ts`),
      `export const ${nodeName} = '${nodeName}';\n`,
      'utf-8',
    );
  }

  return dir;
}

describe.skipIf(!distExists)('CLI E2E — yg check output survives pipe (flush regression)', () => {
  it('header count equals rendered unverified block count and N > 200 through a pipe', () => {
    // spawnSync captures stdout via a pipe internally — this is exactly the
    // scenario that triggered the truncation bug. If exitAfterFlush regresses,
    // the rendered count will be less than the header count.
    const dir = buildFlushFixture();
    try {
      const r = spawnSync('node', [BIN_PATH, 'check'], {
        cwd: dir,
        encoding: 'utf-8',
        // Default maxBuffer (200KB) is plenty for our output, but set it large
        // enough that spawnSync itself never truncates before we get to assert.
        maxBuffer: 32 * 1024 * 1024,
      });

      const stdout = r.stdout ?? '';

      // 1. Parse the declared N from the "Errors (N):" header line.
      const headerMatch = stdout.match(/Errors \((\d+)\):/);
      expect(headerMatch, 'Expected "Errors (N):" header in output').not.toBeNull();
      const headerCount = parseInt(headerMatch![1], 10);

      // 2. N must be well above 200 — proves we are exercising a large list that
      //    would have been truncated under the pre-fix process.exit() behaviour.
      expect(headerCount).toBeGreaterThan(200);

      // 3. Count rendered error issue blocks. Each block's first line is
      //    "  <code>  <nodePath>  <what>" (two leading spaces, the error code, two
      //    more spaces). Cold (no lock), the LLM aspect pairs render as `unverified`.
      //    Relations are computed LIVE: these self-contained nodes have no cross-node
      //    dependency, so NO relation-undeclared-dependency block appears. The
      //    flush-truncation invariant is that EVERY error the header declares is
      //    rendered, so count both block kinds (relation count is 0 here). We strip
      //    ANSI escape sequences first so chalk colour codes don't interfere.
      // eslint-disable-next-line no-control-regex
      const stripped = stdout.replace(/\x1b\[[0-9;]*m/g, '');
      const unverifiedCount = (stripped.match(/^ {2}unverified {2}/gm) ?? []).length;
      const relationCount = (stripped.match(/^ {2}relation-undeclared-dependency {2}/gm) ?? []).length;
      const renderedCount = unverifiedCount + relationCount;

      // The aspect-unverified blocks alone exceed 200 (75 nodes × 3 LLM aspects = 225).
      // No node has a cross-node dependency, so the live relation pass adds nothing.
      expect(unverifiedCount).toBe(225); // 75 mapped nodes × 3 LLM aspects, each unverified cold
      expect(relationCount).toBe(0); // relations are live; these nodes have no cross-node dependency

      // 4. The core assertion: every error the header declares must be rendered.
      //    Under the truncation bug, renderedCount < headerCount for large outputs.
      expect(renderedCount).toBe(headerCount);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
