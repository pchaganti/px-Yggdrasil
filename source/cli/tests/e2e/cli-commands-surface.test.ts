import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Harness reused verbatim from cli-deterministic-lifecycle.test.ts:
// run(args, cwd) spawnSync wrapper, BIN_PATH resolution, describe.skipIf,
// copyFixture. Fully hermetic — each test builds its own temp dir and removes
// it in a finally; no committed fixtures are mutated, no network, no clock.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'e2e-lifecycle');

const distExists = existsSync(BIN_PATH);

function run(
  args: string[],
  cwd: string,
): {
  stdout: string;
  stderr: string;
  status: number | null;
  all: string;
} {
  const result = spawnSync('node', [BIN_PATH, ...args], {
    cwd,
    encoding: 'utf-8',
  });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  return { stdout, stderr, status: result.status, all: stdout + stderr };
}

/** Copy the e2e-lifecycle fixture into a fresh temp dir for mutation. */
function copyFixture(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-surface-${label}-`));
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

/** An empty temp dir with NO .yggdrasil/ — for the no-graph error path. */
function emptyDir(label: string): string {
  return mkdtempSync(path.join(tmpdir(), `yg-surface-empty-${label}-`));
}

// ---------------------------------------------------------------------------
// CLI command surface: flag mutual-exclusion rejections, resource-not-found
// paths, required-subcommand / required-argument errors, numeric-option
// validation, empty-query rejection, and the no-.yggdrasil error path — for
// every command/flag combination not already pinned by another e2e suite.
// All deterministic: zero LLM calls (these are guard/parse paths that abort
// before any reviewer dispatch).
// ---------------------------------------------------------------------------

describe.skipIf(!distExists)('CLI E2E — command surface: mutex, not-found, required-subcommand, option validation', () => {
  // === A. Flag mutual-exclusion rejections not pinned elsewhere ===

  it('A1: context with BOTH --node and --file is rejected (exit 1, "Conflicting options")', () => {
    // cli-query only pins the NEITHER case ("--node ... or --file ... is
    // required"); the BOTH case (mutually exclusive) is pinned only here.
    const dir = copyFixture('a1');
    try {
      const { status, stderr } = run(
        ['context', '--node', 'services/orders', '--file', 'src/services/orders.ts'],
        dir,
      );
      expect(status).toBe(1);
      expect(stderr).toContain('Conflicting options.');
      expect(stderr).toContain("'--node' and '--file' are mutually exclusive.");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('A2: approve --dry-run WITH --flow is rejected (exit 1) — dry-run only with --node', () => {
    // cli-deterministic-lifecycle E11 pins --dry-run + --aspect; the --flow
    // partner is pinned only here. order-processing is a real flow in the fixture.
    const dir = copyFixture('a2');
    try {
      const { status, all } = run(['approve', '--flow', 'order-processing', '--dry-run'], dir);
      expect(status).toBe(1);
      expect(all).toContain('--dry-run is only supported with --node, not with --aspect or --flow.');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('A3: approve with NO target prints the exact "No target specified" message (exit 1)', () => {
    // cli-lifecycle runs `yg approve` but only loosely asserts /required
    // option|--node/. The actual structured message is pinned only here.
    const dir = copyFixture('a3');
    try {
      const { status, all } = run(['approve'], dir);
      expect(status).toBe(1);
      expect(all).toContain('No target specified.');
      expect(all).toContain('yg approve needs exactly one of --node, --aspect, or --flow.');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // === B. Resource-not-found paths ===

  it('B1: approve --aspect <unknown> reports aspect-does-not-exist (exit 1)', () => {
    const dir = copyFixture('b1');
    try {
      const { status, all } = run(['approve', '--aspect', 'no-such-aspect'], dir);
      expect(status).toBe(1);
      expect(all).toContain("Aspect 'no-such-aspect' does not exist.");
      expect(all).toContain('Run: yg aspects');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('B2: approve --flow <unknown> reports flow-does-not-exist (exit 1)', () => {
    const dir = copyFixture('b2');
    try {
      const { status, all } = run(['approve', '--flow', 'no-such-flow'], dir);
      expect(status).toBe(1);
      expect(all).toContain("Flow 'no-such-flow' does not exist.");
      expect(all).toContain('Run: yg flows');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('B3: approve --aspect <draft-default> is a no-op batch (exit 0, Scenario A message)', () => {
    // wip-rule has default status `draft`; no node can raise it via cascade, so
    // the whole batch is a friendly no-op that exits 0 without touching baselines.
    const dir = copyFixture('b3');
    try {
      const { status, stdout } = run(['approve', '--aspect', 'wip-rule'], dir);
      expect(status).toBe(0);
      expect(stdout).toContain("Aspect 'wip-rule' has default status 'draft'");
      expect(stdout).toContain('reviewer skipped on every node');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('B4: deterministic-test --node <unknown> reports node-not-found (exit 1)', () => {
    // aspect-not-found, both-flags, neither-flags, and llm-aspect-type are pinned
    // by other suites; the unknown-node branch of --node mode is pinned only here.
    const dir = copyFixture('b4');
    try {
      const { status, all } = run(
        ['deterministic-test', '--aspect', 'no-todo-comments', '--node', 'services/ghost'],
        dir,
      );
      expect(status).toBe(1);
      expect(all).toContain("Node 'services/ghost' not found.");
      expect(all).toContain('--node requires an existing node path in the graph.');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // === C. Required-subcommand / required-argument / unknown-subcommand ===

  it('C1: log with an UNKNOWN subcommand is rejected (exit 1, "unknown command")', () => {
    // cli-lifecycle pins the NO-subcommand usage path; an unknown subcommand is
    // a different commander branch, pinned only here.
    const dir = copyFixture('c1');
    try {
      const { status, all } = run(['log', 'frobnicate'], dir);
      expect(status).toBe(1);
      expect(all).toContain("unknown command 'frobnicate'");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('C2: knowledge with an UNKNOWN subcommand is rejected (exit 1, "unknown command")', () => {
    // cli-query pins the NO-subcommand usage path; unknown subcommand only here.
    const dir = copyFixture('c2');
    try {
      const { status, all } = run(['knowledge', 'frobnicate'], dir);
      expect(status).toBe(1);
      expect(all).toContain("unknown command 'frobnicate'");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('C3: knowledge read with NO topic name is rejected (exit 1, missing required argument)', () => {
    const dir = copyFixture('c3');
    try {
      const { status, all } = run(['knowledge', 'read'], dir);
      expect(status).toBe(1);
      expect(all).toContain("missing required argument 'name'");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // === D. Numeric / query option validation ===

  it('D1: tree --depth with a NEGATIVE value is rejected (exit 1, non-negative integer)', () => {
    // cli-deterministic-lifecycle E13 pins the non-numeric case; the negative
    // (parses to a number, but < 0) branch is pinned only here.
    const dir = copyFixture('d1');
    try {
      const { status, all } = run(['tree', '--depth', '-1'], dir);
      expect(status).toBe(1);
      expect(all).toContain('--depth must be a non-negative integer.');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('D2: find with a WHITESPACE-only query is rejected (exit 1, "Query is required")', () => {
    // cli-query pins the no-arg case; a present-but-blank query trims to empty
    // and hits the same guard — pinned only here.
    const dir = copyFixture('d2');
    try {
      const { status, all } = run(['find', '   '], dir);
      expect(status).toBe(1);
      expect(all).toContain('Query is required');
      expect(all).toContain('yg find needs at least one keyword to search.');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('D3: find with an EMPTY-STRING query is rejected (exit 1, "Query is required")', () => {
    // Distinct from whitespace: an explicit '' argument is supplied (not absent),
    // so the empty-after-trim guard — not commander's missing-argument — fires.
    const dir = copyFixture('d3');
    try {
      const { status, all } = run(['find', ''], dir);
      expect(status).toBe(1);
      expect(all).toContain('Query is required');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // === E. No-.yggdrasil error path for commands that lack one elsewhere ===

  it('E1: approve in a directory with no .yggdrasil/ aborts with the init hint (exit 1)', () => {
    const dir = emptyDir('e1');
    try {
      const { status, stderr } = run(['approve', '--node', 'x'], dir);
      expect(status).toBe(1);
      expect(stderr).toContain('No .yggdrasil/ directory found');
      expect(stderr).toContain('yg init');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('E2: impact in a directory with no .yggdrasil/ aborts with the init hint (exit 1)', () => {
    const dir = emptyDir('e2');
    try {
      const { status, stderr } = run(['impact', '--node', 'x'], dir);
      expect(status).toBe(1);
      expect(stderr).toContain('No .yggdrasil/ directory found');
      expect(stderr).toContain('yg init');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('E3: deterministic-test in a directory with no .yggdrasil/ aborts with the init hint (exit 1)', () => {
    const dir = emptyDir('e3');
    try {
      const { status, stderr } = run(['deterministic-test', '--aspect', 'x', '--node', 'y'], dir);
      expect(status).toBe(1);
      expect(stderr).toContain('No .yggdrasil/ directory found');
      expect(stderr).toContain('yg init');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('E4: log add in a directory with no .yggdrasil/ aborts with the init hint (exit 1)', () => {
    const dir = emptyDir('e4');
    try {
      const { status, stderr } = run(['log', 'add', '--node', 'x', '--reason', 'y'], dir);
      expect(status).toBe(1);
      expect(stderr).toContain('No .yggdrasil/ directory found');
      expect(stderr).toContain('yg init');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('E5: knowledge read needs NO graph — it prints the topic even with no .yggdrasil/ (exit 0)', () => {
    // The embedded knowledge base is graph-independent: `yg knowledge read`
    // resolves entirely from compiled-in content and never loads a graph, so it
    // succeeds in a bare directory. This pins that intentional contract.
    const dir = emptyDir('e5');
    try {
      const { status, stdout } = run(['knowledge', 'read', 'flows'], dir);
      expect(status).toBe(0);
      expect(stdout).toContain('Flow');
      expect(stdout.length).toBeGreaterThan(200);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
