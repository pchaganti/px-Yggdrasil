import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  rmSync,
  cpSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// TIER-IDENTITY cascade E2E.
//
// Each LLM aspect contributes a synthetic `tier-identity:<aspectId>` entry to
// every using node's per-node drift hash. Anything that changes the RESOLVED
// reviewer tier for that aspect (its consensus, model, endpoint, the tier's
// name, or the default it falls back to) must drift every node the aspect is
// effective on. `api_key` is excluded — secret rotation must NOT drift.
//
// This suite proves that mechanic end-to-end against the real built binary.
//
// Hermetic design (no LLM, no network):
//   The `has-doc-comment` LLM aspect is enforced on the two `service` nodes.
//   We point its reviewer tier at a dead loopback endpoint (killReviewer), so
//   `yg approve` records a structural-only baseline that STILL tracks the
//   aspect's `tier-identity` hash (verified by T0 below). Mutating the tier
//   config in the temp copy then surfaces a tier-identity cascade in
//   `yg check` — entirely deterministic, no real host/port dependency.
//
// Settle step: the first dead-reviewer approve writes a baseline whose `files`
// map lacks the `check-touched:` synthetic keys (those are derived from the
// recorded checkTouchedFiles set only on a SUBSEQUENT collect). A second
// approve folds them in, so a later non-tier drift does not drag spurious
// check-touched cascades into the output. Every test approves twice before
// mutating the tier, isolating the tier-identity signal.
//
// Residual `aspect-newly-active`: because the reviewer is unreachable, the LLM
// aspect never receives a verdict, so `yg check` always carries an
// `aspect-newly-active` error for `has-doc-comment`. That means overall check
// cannot reach exit 0 in this hermetic setup. The load-bearing assertion is
// therefore on the tier-identity cascade MESSAGE appearing / disappearing, not
// on the global exit code reaching 0. See T1b.
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'e2e-lifecycle');

const distExists = existsSync(BIN_PATH);

// A dead loopback endpoint. Port 1 never has a listener, so the LLM reviewer is
// unreachable on ANY machine — no dependency on a real host being present or
// absent. A second equally-dead address is used to prove an endpoint EDIT
// drifts the tier without re-enabling the reviewer.
const DEAD_ENDPOINT = 'http://127.0.0.1:1';
const DEAD_ENDPOINT_ALT = 'http://127.0.0.2:1';

function run(
  args: string[],
  cwd: string,
): { stdout: string; stderr: string; status: number | null; all: string } {
  const result = spawnSync('node', [BIN_PATH, ...args], { cwd, encoding: 'utf-8' });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  return { stdout, stderr, status: result.status, all: stdout + stderr };
}

/** Copy the e2e-lifecycle fixture into a fresh temp dir for mutation. */
function copyFixture(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-tier-${label}-`));
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

const cfgPath = (dir: string) => path.join(dir, '.yggdrasil', 'yg-config.yaml');
const baselinePath = (dir: string, node: string) =>
  path.join(dir, '.yggdrasil', '.drift-state', ...node.split('/')) + '.json';

/**
 * Repoint the reviewer endpoint at the dead loopback address. Rewrites whatever
 * `endpoint:` the fixture config carries to the guaranteed-dead port-1 address,
 * so the reviewer is ALWAYS unreachable regardless of the machine.
 */
function killReviewer(dir: string): void {
  const cfg = readFileSync(cfgPath(dir), 'utf-8').replace(
    /endpoint:\s*["']?[^"'\n]+["']?/,
    `endpoint: "${DEAD_ENDPOINT}"`,
  );
  writeFileSync(cfgPath(dir), cfg, 'utf-8');
}

/** Overwrite the whole config with a hand-authored variant. */
function writeConfig(dir: string, yaml: string): void {
  writeFileSync(cfgPath(dir), yaml, 'utf-8');
}

/** Read the temp config so a single field can be string-replaced in place. */
function patchConfig(dir: string, from: string | RegExp, to: string): void {
  const cfg = readFileSync(cfgPath(dir), 'utf-8').replace(from, to);
  writeFileSync(cfgPath(dir), cfg, 'utf-8');
}

const SERVICE_NODES = ['services/orders', 'services/payments'] as const;

/**
 * Kill the reviewer, then approve the service node(s) TWICE so the recorded
 * baseline is settled (check-touched synthetic keys folded in). Returns nothing
 * — asserts each approve exits 0 (structural-only, reviewer unreachable).
 */
function approveSettled(dir: string, nodes: readonly string[] = SERVICE_NODES): void {
  killReviewer(dir);
  const flags = nodes.flatMap((n) => ['--node', n]);
  for (let i = 0; i < 2; i++) {
    const r = run(['approve', ...flags], dir);
    expect(r.status).toBe(0);
    // The reviewer-unreachable path must have run (proves we never made a real
    // LLM call — the result is structural-only and fully reproducible).
    expect(r.all).toContain('not reachable');
  }
}

// The exact, stable cascade line the CLI emits for a tier-identity change.
const TIER_CASCADE = "the resolved reviewer tier for aspect 'has-doc-comment' changed";

// Two-tier config (default = standard) used to exercise default-flip and
// rename scenarios. BOTH tiers point at dead endpoints so the reviewer stays
// unreachable no matter which one resolves.
const TWO_TIER_CONFIG = `version: "5.0.0"

quality:
  max_direct_relations: 10

reviewer:
  default: standard
  tiers:
    standard:
      provider: ollama
      consensus: 1
      config:
        model: "qwen2.5-coder:0.5b"
        endpoint: "${DEAD_ENDPOINT}"
    deep:
      provider: ollama
      consensus: 1
      config:
        model: "qwen2.5-coder:1.5b"
        endpoint: "${DEAD_ENDPOINT}"
`;

describe.skipIf(!distExists)('CLI E2E — tier-identity cascade (LLM aspect resolved tier drifts every using node)', () => {
  // --- T0: the hermetic assumption itself ---

  it('T0: dead-reviewer approve writes a baseline that TRACKS the LLM aspect tier-identity', () => {
    const dir = copyFixture('t0');
    try {
      killReviewer(dir);
      const approve = run(['approve', '--node', 'services/orders'], dir);
      expect(approve.status).toBe(0); // structural-only baseline, exit 0
      expect(approve.all).toContain('not reachable');

      const baseline = baselinePath(dir, 'services/orders');
      expect(existsSync(baseline)).toBe(true);
      const state = JSON.parse(readFileSync(baseline, 'utf-8')) as {
        files: Record<string, string>;
      };
      // The synthetic tier-identity entry for the enforced LLM aspect is present
      // in the recorded drift hash set — this is what a tier edit will perturb.
      expect(Object.keys(state.files)).toContain('tier-identity:has-doc-comment');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- T1a / T1b: scenario 1 — consensus edit drifts, re-approve clears it ---

  it('T1a: editing the tier consensus (1→3) drifts every using node (exit 1, names both)', () => {
    const dir = copyFixture('t1a');
    try {
      approveSettled(dir);

      // Mutate the resolved tier: consensus 1 → 3.
      patchConfig(dir, 'consensus: 1', 'consensus: 3');

      const check = run(['check'], dir);
      expect(check.status).toBe(1);
      expect(check.all).toContain(TIER_CASCADE);
      // BOTH using nodes are named in the grouped affected-node list.
      expect(check.all).toContain('services/{orders, payments}');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('T1b: re-approving the aspect after the consensus edit CLEARS the tier cascade', () => {
    const dir = copyFixture('t1b');
    try {
      approveSettled(dir);
      patchConfig(dir, 'consensus: 1', 'consensus: 3');

      // Confirm the cascade is present before clearing.
      expect(run(['check'], dir).all).toContain(TIER_CASCADE);

      // Batch re-approve from the changed aspect: both using nodes pick up the
      // new tier identity. Still structural-only (reviewer unreachable), exit 0.
      const reapprove = run(['approve', '--aspect', 'has-doc-comment'], dir);
      expect(reapprove.status).toBe(0);
      expect(reapprove.all).toContain('services/orders');
      expect(reapprove.all).toContain('services/payments');
      expect(reapprove.all).toContain('2 approved');

      // The tier-identity cascade signal is gone after re-approve.
      // NOTE: global `yg check` does NOT reach exit 0 here — the unreachable
      // reviewer leaves `has-doc-comment` without an LLM verdict, so a residual
      // `aspect-newly-active` error remains. The load-bearing proof is that the
      // tier-identity cause specifically disappears.
      const cleared = run(['check'], dir);
      expect(cleared.all).not.toContain(TIER_CASCADE);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- T2: scenario 2 — editing a tier config field (model) drifts ---

  it('T2: editing the resolved tier model drifts every using node (tier-identity cascade)', () => {
    const dir = copyFixture('t2-model');
    try {
      approveSettled(dir);

      patchConfig(dir, 'qwen2.5-coder:0.5b', 'llama3.2:1b');

      const check = run(['check'], dir);
      expect(check.status).toBe(1);
      expect(check.all).toContain(TIER_CASCADE);
      expect(check.all).toContain('services/{orders, payments}');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('T2b: editing the resolved tier endpoint (to another DEAD address) drifts every using node', () => {
    const dir = copyFixture('t2-endpoint');
    try {
      approveSettled(dir);

      // Repoint at a DIFFERENT still-dead address: a genuine tier change that
      // keeps the reviewer unreachable (hermetic).
      patchConfig(dir, DEAD_ENDPOINT, DEAD_ENDPOINT_ALT);

      const check = run(['check'], dir);
      expect(check.status).toBe(1);
      expect(check.all).toContain(TIER_CASCADE);
      expect(check.all).toContain('services/{orders, payments}');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- T3: scenario 3 — rename the tier and repoint the default ---

  it('T3: renaming the tier and repointing the default drifts every using node', () => {
    const dir = copyFixture('t3');
    try {
      approveSettled(dir);

      // Rename `standard` → `primary` and repoint reviewer.default. The tier
      // name is part of the identity, so this drifts even though the config
      // body is byte-equivalent.
      writeConfig(
        dir,
        `version: "5.0.0"

quality:
  max_direct_relations: 10

reviewer:
  default: primary
  tiers:
    primary:
      provider: ollama
      consensus: 1
      config:
        model: "qwen2.5-coder:0.5b"
        endpoint: "${DEAD_ENDPOINT}"
`,
      );

      const check = run(['check'], dir);
      expect(check.status).toBe(1);
      expect(check.all).toContain(TIER_CASCADE);
      expect(check.all).toContain('services/{orders, payments}');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- T4: scenario 4 — editing reviewer.default cascades to default-relying aspects ---

  it('T4: editing reviewer.default cascades to aspects relying on the default tier', () => {
    const dir = copyFixture('t4');
    try {
      // Start with TWO tiers (default = standard). `has-doc-comment` pins no
      // tier, so it resolves the default.
      writeConfig(dir, TWO_TIER_CONFIG);
      // approveSettled() also calls killReviewer(), which only rewrites the
      // FIRST endpoint match. Both tiers already point at DEAD_ENDPOINT, so the
      // reviewer stays unreachable regardless.
      approveSettled(dir);

      // Flip the default standard → deep. The aspect's resolved tier changes
      // without touching the aspect itself.
      patchConfig(dir, 'default: standard', 'default: deep');

      const check = run(['check'], dir);
      expect(check.status).toBe(1);
      expect(check.all).toContain(TIER_CASCADE);
      expect(check.all).toContain('services/{orders, payments}');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- T5: scenario 5 — api_key rotation is EXCLUDED from tier identity ---

  it('T5: rotating the tier api_key does NOT drift (api_key excluded from tier identity)', () => {
    const dir = copyFixture('t5');
    try {
      // Author a config that carries an api_key, with a dead endpoint.
      writeConfig(
        dir,
        `version: "5.0.0"

quality:
  max_direct_relations: 10

reviewer:
  default: standard
  tiers:
    standard:
      provider: ollama
      consensus: 1
      config:
        model: "qwen2.5-coder:0.5b"
        endpoint: "${DEAD_ENDPOINT}"
        api_key: "secret-old-key-aaaa"
`,
      );
      approveSettled(dir);

      // A settled baseline carries no tier cascade.
      expect(run(['check'], dir).all).not.toContain(TIER_CASCADE);

      // Rotate ONLY the api_key. canonicalTierJson omits api_key, so the
      // tier-identity hash is unchanged → no cascade.
      patchConfig(dir, 'secret-old-key-aaaa', 'secret-NEW-key-bbbb');

      const check = run(['check'], dir);
      // The tier-identity cause must NOT appear. (Global check still exits 1 on
      // the residual aspect-newly-active, unrelated to tier identity — so we
      // assert on the absence of the tier cascade signal specifically.)
      expect(check.all).not.toContain(TIER_CASCADE);
      // And no cascade of ANY kind was introduced by the api_key rotation.
      expect(check.all).not.toContain('cascade');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
