import { describe, it, expect } from 'vitest';
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
import { startMockReviewer, runAsync, type ChatReply } from './support/mock-reviewer.js';

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
// Hermetic design (no real model, no external network):
//   The `has-doc-comment` LLM aspect is enforced on the two `service` nodes.
//   We point its reviewer tier at an in-process mock reviewer (support/
//   mock-reviewer.ts) that speaks the Ollama wire protocol and always returns a
//   satisfied verdict. `yg approve` then records a real, fully-verified baseline
//   that tracks the aspect's `tier-identity` hash (verified by T0 below).
//   Mutating the tier config in the temp copy surfaces a tier-identity cascade
//   in `yg check` — and crucially, `yg check` reads no reviewer (drift detection
//   is deterministic), so the tier edit is observed without any LLM call.
//
// Why a LIVE mock and not a dead endpoint: a reviewer INFRA failure now fails
// closed (#2) — an unreachable reviewer refuses and writes NO baseline, so there
// would be nothing to cascade against. A satisfied mock gives us a genuine green
// baseline to perturb, which is what the tier-identity mechanic operates on.
//
// Settle step: the first approve writes a baseline whose `files` map lacks the
// `check-touched:` synthetic keys (those are derived from the recorded
// checkTouchedFiles set only on a SUBSEQUENT collect). A second approve folds
// them in, so a later non-tier drift does not drag spurious check-touched
// cascades into the output. Every test approves twice before mutating the tier,
// isolating the tier-identity signal.
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'e2e-lifecycle');

const distExists = existsSync(BIN_PATH);

// A dead loopback endpoint, used ONLY as an endpoint-EDIT target in T2b. Port 1
// never has a listener; pointing the config there is a genuine tier change, and
// because `yg check` performs no reviewer call, the address being dead is
// irrelevant to the deterministic drift detection the test asserts on.
const DEAD_ENDPOINT_ALT = 'http://127.0.0.2:1';

const OK: () => ChatReply = () => ({ satisfied: true, reason: 'ok' });

/** Copy the e2e-lifecycle fixture into a fresh temp dir for mutation. */
function copyFixture(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-tier-${label}-`));
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

const cfgPath = (dir: string) => path.join(dir, '.yggdrasil', 'yg-config.yaml');
const baselinePath = (dir: string, node: string) =>
  path.join(dir, '.yggdrasil', '.drift-state', ...node.split('/')) + '.json';

/** Repoint the reviewer endpoint at the live mock (rewrites the first `endpoint:`). */
function pointReviewer(dir: string, endpoint: string): void {
  const cfg = readFileSync(cfgPath(dir), 'utf-8').replace(
    /endpoint:\s*["']?[^"'\n]+["']?/,
    `endpoint: "${endpoint}"`,
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
 * Point the reviewer at the live mock, then approve the service node(s) TWICE so
 * the recorded baseline is settled (check-touched synthetic keys folded in).
 * Each approve must exit 0 — the mock returns a satisfied verdict, so the LLM
 * aspect is genuinely verified and the baseline tracks its tier identity.
 */
async function approveSettled(
  dir: string,
  endpoint: string,
  nodes: readonly string[] = SERVICE_NODES,
): Promise<void> {
  pointReviewer(dir, endpoint);
  const flags = nodes.flatMap((n) => ['--node', n]);
  for (let i = 0; i < 2; i++) {
    const r = await runAsync(['approve', ...flags], dir);
    expect(r.status).toBe(0);
  }
}

// The exact, stable cascade line the CLI emits for a tier-identity change.
const TIER_CASCADE = "the resolved reviewer tier for aspect 'has-doc-comment' changed";

// Two-tier config (default = standard) used to exercise default-flip and rename
// scenarios. BOTH tiers point at the same live mock endpoint, so the reviewer is
// reachable no matter which one resolves.
const twoTierConfig = (endpoint: string) => `version: "5.0.0"

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
        endpoint: "${endpoint}"
    deep:
      provider: ollama
      consensus: 1
      config:
        model: "qwen2.5-coder:1.5b"
        endpoint: "${endpoint}"
`;

describe.skipIf(!distExists)('CLI E2E — tier-identity cascade (LLM aspect resolved tier drifts every using node)', () => {
  // --- T0: the hermetic assumption itself ---

  it('T0: a satisfied-mock approve writes a baseline that TRACKS the LLM aspect tier-identity', async () => {
    const dir = copyFixture('t0');
    const mock = await startMockReviewer({ respond: OK });
    try {
      pointReviewer(dir, mock.endpoint);
      const approve = await runAsync(['approve', '--node', 'services/orders'], dir);
      expect(approve.status).toBe(0); // verified baseline, exit 0

      const baseline = baselinePath(dir, 'services/orders');
      expect(existsSync(baseline)).toBe(true);
      const state = JSON.parse(readFileSync(baseline, 'utf-8')) as {
        files: Record<string, string>;
      };
      // The synthetic tier-identity entry for the enforced LLM aspect is present
      // in the recorded drift hash set — this is what a tier edit will perturb.
      expect(Object.keys(state.files)).toContain('tier-identity:has-doc-comment');
    } finally {
      await mock.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- T1a / T1b: scenario 1 — consensus edit drifts, re-approve clears it ---

  it('T1a: editing the tier consensus (1→3) drifts every using node (exit 1, names both)', async () => {
    const dir = copyFixture('t1a');
    const mock = await startMockReviewer({ respond: OK });
    try {
      await approveSettled(dir, mock.endpoint);

      // Mutate the resolved tier: consensus 1 → 3.
      patchConfig(dir, 'consensus: 1', 'consensus: 3');

      const check = await runAsync(['check'], dir);
      expect(check.status).toBe(1);
      expect(check.all).toContain(TIER_CASCADE);
      // BOTH using nodes are named in the grouped affected-node list.
      expect(check.all).toContain('services/{orders, payments}');
    } finally {
      await mock.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('T1b: re-approving the aspect after the consensus edit CLEARS the tier cascade', async () => {
    const dir = copyFixture('t1b');
    const mock = await startMockReviewer({ respond: OK });
    try {
      await approveSettled(dir, mock.endpoint);
      patchConfig(dir, 'consensus: 1', 'consensus: 3');

      // Confirm the cascade is present before clearing.
      expect((await runAsync(['check'], dir)).all).toContain(TIER_CASCADE);

      // Batch re-approve from the changed aspect: both using nodes pick up the
      // new tier identity. The mock satisfies all 3 consensus calls, exit 0.
      const reapprove = await runAsync(['approve', '--aspect', 'has-doc-comment'], dir);
      expect(reapprove.status).toBe(0);
      expect(reapprove.all).toContain('services/orders');
      expect(reapprove.all).toContain('services/payments');
      expect(reapprove.all).toContain('2 approved');

      // The tier-identity cascade signal is gone after re-approve.
      const cleared = await runAsync(['check'], dir);
      expect(cleared.all).not.toContain(TIER_CASCADE);
    } finally {
      await mock.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- T2: scenario 2 — editing a tier config field (model) drifts ---

  it('T2: editing the resolved tier model drifts every using node (tier-identity cascade)', async () => {
    const dir = copyFixture('t2-model');
    const mock = await startMockReviewer({ respond: OK });
    try {
      await approveSettled(dir, mock.endpoint);

      patchConfig(dir, 'qwen2.5-coder:0.5b', 'llama3.2:1b');

      const check = await runAsync(['check'], dir);
      expect(check.status).toBe(1);
      expect(check.all).toContain(TIER_CASCADE);
      expect(check.all).toContain('services/{orders, payments}');
    } finally {
      await mock.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('T2b: editing the resolved tier endpoint drifts every using node', async () => {
    const dir = copyFixture('t2-endpoint');
    const mock = await startMockReviewer({ respond: OK });
    try {
      await approveSettled(dir, mock.endpoint);

      // Repoint at a DIFFERENT address: a genuine tier change. `yg check` makes
      // no reviewer call, so the new address need not be live for the
      // deterministic tier-identity drift to surface.
      patchConfig(dir, mock.endpoint, DEAD_ENDPOINT_ALT);

      const check = await runAsync(['check'], dir);
      expect(check.status).toBe(1);
      expect(check.all).toContain(TIER_CASCADE);
      expect(check.all).toContain('services/{orders, payments}');
    } finally {
      await mock.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- T3: scenario 3 — rename the tier and repoint the default ---

  it('T3: renaming the tier and repointing the default drifts every using node', async () => {
    const dir = copyFixture('t3');
    const mock = await startMockReviewer({ respond: OK });
    try {
      await approveSettled(dir, mock.endpoint);

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
        endpoint: "${mock.endpoint}"
`,
      );

      const check = await runAsync(['check'], dir);
      expect(check.status).toBe(1);
      expect(check.all).toContain(TIER_CASCADE);
      expect(check.all).toContain('services/{orders, payments}');
    } finally {
      await mock.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- T4: scenario 4 — editing reviewer.default cascades to default-relying aspects ---

  it('T4: editing reviewer.default cascades to aspects relying on the default tier', async () => {
    const dir = copyFixture('t4');
    const mock = await startMockReviewer({ respond: OK });
    try {
      // Start with TWO tiers (default = standard). `has-doc-comment` pins no
      // tier, so it resolves the default. Both tiers point at the live mock.
      writeConfig(dir, twoTierConfig(mock.endpoint));
      // approveSettled() also calls pointReviewer(), which only rewrites the
      // FIRST endpoint match. Both tiers already point at the mock, so the
      // reviewer stays reachable regardless.
      await approveSettled(dir, mock.endpoint);

      // Flip the default standard → deep. The aspect's resolved tier changes
      // without touching the aspect itself.
      patchConfig(dir, 'default: standard', 'default: deep');

      const check = await runAsync(['check'], dir);
      expect(check.status).toBe(1);
      expect(check.all).toContain(TIER_CASCADE);
      expect(check.all).toContain('services/{orders, payments}');
    } finally {
      await mock.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- T5: scenario 5 — api_key rotation is EXCLUDED from tier identity ---

  it('T5: rotating the tier api_key does NOT drift (api_key excluded from tier identity)', async () => {
    const dir = copyFixture('t5');
    const mock = await startMockReviewer({ respond: OK });
    try {
      // Author a config that carries an api_key, pointing at the live mock.
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
        endpoint: "${mock.endpoint}"
        api_key: "secret-old-key-aaaa"
`,
      );
      await approveSettled(dir, mock.endpoint);

      // A settled baseline carries no tier cascade.
      expect((await runAsync(['check'], dir)).all).not.toContain(TIER_CASCADE);

      // Rotate ONLY the api_key. canonicalTierJson omits api_key, so the
      // tier-identity hash is unchanged → no cascade.
      patchConfig(dir, 'secret-old-key-aaaa', 'secret-NEW-key-bbbb');

      const check = await runAsync(['check'], dir);
      // The tier-identity cause must NOT appear, and no cascade of ANY kind was
      // introduced by the api_key rotation.
      expect(check.all).not.toContain(TIER_CASCADE);
      expect(check.all).not.toContain('cascade');
    } finally {
      await mock.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
