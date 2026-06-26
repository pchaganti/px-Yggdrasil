// =============================================================================
// SCOPE / FAIL-CLOSED (TOO-LARGE TWIN) — a content-filter aspect whose sole mapped
// subject exceeds the 5MB content-scan limit is NEVER silently dropped into a
// vacuous green; it surfaces as a BLOCKING file-unreadable error end-to-end.
//
// This is the size twin of cli-scope-unreadable.test.ts. There, a mapped file is
// unreadable by permission (chmod 0o000 → EACCES). Here, the file is perfectly
// readable but too large to scan: a `scope.files {content}` filter MUST read each
// mapped file to evaluate the filter, and a file over the 5MB limit cannot be
// scanned, so the filter is UNEVALUABLE. The spawned `yg check` must exit 1 with a
// file-unreadable error naming the file and the aspect — never drop the file and
// pass vacuously over source no reviewer saw.
//
// NO privileged-runtime guard is needed (this is file size, not permissions): the
// 5MB limit is enforced identically for root and non-root, so the assertion holds
// in every environment (CI / container included).
//
// HERMETIC: fresh mkdtemp copy of e2e-lifecycle per test, tree removed in finally.
// No fixed ports, no clock/random asserts.
// =============================================================================

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, cpSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '..', '..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'e2e-lifecycle');
const distExists = existsSync(BIN_PATH);

const SIZE_LIMIT_BYTES = 5 * 1024 * 1024;

const archPath = (d: string) => path.join(d, '.yggdrasil', 'yg-architecture.yaml');
const flowPath = (d: string) => path.join(d, '.yggdrasil', 'flows', 'order-processing', 'yg-flow.yaml');
const nodeYaml = (d: string, n: string) => path.join(d, '.yggdrasil', 'model', ...n.split('/'), 'yg-node.yaml');
const lockPath = (d: string) => path.join(d, '.yggdrasil', 'yg-lock.json');

function run(args: string[], cwd: string): { all: string; status: number | null } {
  const r = spawnSync('node', [BIN_PATH, ...args], { cwd, encoding: 'utf-8' });
  return { all: (r.stdout ?? '') + (r.stderr ?? ''), status: r.status };
}

function copyFixture(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-toolarge-${label}-`));
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

/**
 * Reduce the service type to a single deterministic content-filter aspect
 * (marker-rule) so the only effective rule on the orders node is the one whose
 * scope.files {content} filter MUST read every mapped file. Broaden the service
 * `when` to src/** so a directory-mapped node classifies.
 *
 * Mirrors installMarkerRule in cli-scope-unreadable.test.ts.
 */
function installMarkerRule(dir: string): void {
  let arch = readFileSync(archPath(dir), 'utf-8');
  arch = arch.replace(
    '    aspects:\n      - no-todo-comments\n      - requires-named-export\n      - has-doc-comment\n',
    '    aspects:\n      - marker-rule\n',
  );
  arch = arch.replace('path: "src/services/**"', 'path: "src/**"');
  writeFileSync(archPath(dir), arch, 'utf-8');
  writeFileSync(flowPath(dir), readFileSync(flowPath(dir), 'utf-8').replace('aspects:\n  - no-todo-comments\n', 'aspects: []\n'), 'utf-8');
  rmSync(path.join(dir, '.yggdrasil', 'aspects', 'no-todo-comments'), { recursive: true, force: true });
  rmSync(path.join(dir, '.yggdrasil', 'aspects', 'requires-named-export'), { recursive: true, force: true });
  rmSync(path.join(dir, '.yggdrasil', 'aspects', 'has-doc-comment'), { recursive: true, force: true });

  const mr = path.join(dir, '.yggdrasil', 'aspects', 'marker-rule');
  mkdirSync(mr, { recursive: true });
  writeFileSync(
    path.join(mr, 'yg-aspect.yaml'),
    ['name: MarkerRule', 'description: Files carrying the @reviewed marker are reviewed.', 'reviewer:', '  type: deterministic', 'status: enforced',
      'scope:', '  per: node', '  files:', '    content: "@reviewed"', ''].join('\n'),
    'utf-8',
  );
  writeFileSync(
    path.join(mr, 'check.mjs'),
    ['export function check(ctx) {', '  void ctx;', '  return [];', '}', ''].join('\n'),
    'utf-8',
  );

  // Drop the unused payments node so only orders is in play — including its flow
  // participation entry (else a flow-node-broken error blocks for an unrelated reason).
  rmSync(path.join(dir, '.yggdrasil', 'model', 'services', 'payments'), { recursive: true, force: true });
  rmSync(path.join(dir, 'src', 'services', 'payments.ts'), { force: true });
  writeFileSync(flowPath(dir), readFileSync(flowPath(dir), 'utf-8').replace('  - services/payments\n', ''), 'utf-8');
}

describe.skipIf(!distExists)('CLI E2E — scope fail-closed: a >5MB content-filtered subject blocks (file-unreadable)', () => {
  // ===========================================================================
  // THE SOLE MATCHING FILE IS TOO LARGE TO SCAN
  //   Single mapped file over the 5MB content-scan limit → the content filter
  //   cannot be evaluated. Plain `yg check` must exit 1 with a file-unreadable
  //   error (no vacuous pass) AND the lock must record NO approved verdict for
  //   the aspect (no false green over a dropped subject). `yg check --approve`
  //   must block cleanly too (no raw crash, no "Unexpected error").
  // ===========================================================================

  it('the sole mapped file is >5MB → check AND --approve: file-unreadable, exit 1, NO approved verdict', () => {
    const dir = copyFixture('sole');
    try {
      installMarkerRule(dir);

      const base = path.join(dir, 'src', 'services', 'orders');
      mkdirSync(base, { recursive: true });
      rmSync(path.join(dir, 'src', 'services', 'orders.ts'), { force: true });
      // Just over the 5MB scan limit — readable, but the content filter cannot scan it.
      writeFileSync(path.join(base, 'big.ts'), 'a'.repeat(SIZE_LIMIT_BYTES + 10));
      writeFileSync(
        nodeYaml(dir, 'services/orders'),
        ['name: OrdersService', 'description: Orders.', 'type: service', 'mapping:', '  - src/services/orders', ''].join('\n'),
        'utf-8',
      );

      // Plain check: blocking file-unreadable error, exit 1 — never a vacuous pass.
      const check = run(['check'], dir);
      expect(check.status).toBe(1);
      expect(check.all).toContain('file-unreadable');
      // The per-issue `what` ("could not evaluate the content filter") is no longer
      // rendered in the grouped view; the over-the-scan-limit rationale survives in
      // the shared why, and the over-limit file path survives in the Fix text below.
      expect(check.all).toContain('exceeds the scan limit, so the filter could not be applied');
      expect(check.all).toContain('A silently dropped file can turn an enforced rule into a vacuous pass.');
      expect(check.all).toContain('src/services/orders/big.ts');
      // The error names the marker-rule aspect (the content filter that had to scan it).
      expect(check.all).toContain('marker-rule');

      // --approve blocks cleanly too (no raw crash) and writes no verdict.
      const approve = run(['check', '--approve'], dir);
      expect(approve.status).toBe(1);
      expect(approve.all).toContain('file-unreadable');
      expect(approve.all).not.toContain('Unexpected error');
      expect(approve.all).not.toContain('This is a bug');

      // No false green: no approved marker-rule verdict was written for this node.
      if (existsSync(lockPath(dir))) {
        const lock = JSON.parse(readFileSync(lockPath(dir), 'utf-8'));
        const entry = lock.verdicts?.['marker-rule']?.['node:services/orders'];
        if (entry) {
          expect(entry.verdict).not.toBe('approved');
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
