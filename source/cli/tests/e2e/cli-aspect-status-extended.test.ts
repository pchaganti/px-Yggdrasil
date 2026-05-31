import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  cpSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Harness — duplicated verbatim from cli-deterministic-lifecycle.test.ts so each
// e2e file is self-contained. Every test runs the REAL dist/bin.js against a
// fresh mkdtemp copy of the e2e-lifecycle fixture, mutates only that copy, and
// rmSync's it in a finally block. Fully hermetic: no committed fixtures of its
// own, no network, no wall-clock or random sources in any assertion. Every
// aspect exercised is a deterministic reviewer (zero LLM cost); the reviewer
// endpoint is additionally repointed at a dead loopback so no test can reach
// the network even if a future fixture edit reintroduces an LLM aspect.
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'e2e-lifecycle');

const distExists = existsSync(BIN_PATH);

// A dead loopback endpoint. Pointing the reviewer at this makes the LLM aspect
// path unreachable, so `yg approve` never produces an environment-dependent LLM
// verdict — port 1 never has a listener, on ANY machine, with no reliance on a
// real endpoint being present or absent. Used by killReviewer().
const DEAD_ENDPOINT = 'http://127.0.0.1:1';

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
  const dir = mkdtempSync(path.join(tmpdir(), `yg-aststatus-${label}-`));
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

/**
 * Copy the fixture and strip the LLM aspect (`has-doc-comment`) so the node's
 * effective aspects are purely deterministic. This makes the approve/check
 * lifecycle hermetic: no network, no LLM verdict, fully reproducible — the
 * `no-todo-comments` (enforced), `requires-named-export` (advisory) and
 * `wip-rule` (draft) deterministic aspects drive every outcome.
 */
function deterministicFixture(label: string): string {
  const dir = copyFixture(label);
  // Drop the LLM aspect from the `service` node type's default aspects.
  const archPath = path.join(dir, '.yggdrasil', 'yg-architecture.yaml');
  const arch = readFileSync(archPath, 'utf-8')
    .split('\n')
    .filter((line) => line.trim() !== '- has-doc-comment')
    .join('\n');
  writeFileSync(archPath, arch, 'utf-8');
  // Remove the now-orphaned aspect definition so `yg check` is clean.
  rmSync(path.join(dir, '.yggdrasil', 'aspects', 'has-doc-comment'), {
    recursive: true,
    force: true,
  });
  return dir;
}

/**
 * Repoint the reviewer endpoint at the dead loopback address. Rewrites whatever
 * `endpoint:` the fixture config carries to the guaranteed-dead port-1 address,
 * so the LLM reviewer is ALWAYS unreachable regardless of the machine. The
 * deterministicFixture already removes the only LLM aspect, but killing the
 * endpoint as well guarantees no test in this suite can reach out over the
 * network even if a future fixture edit reintroduces an LLM aspect.
 */
function killReviewer(dir: string): void {
  const cfgPath = path.join(dir, '.yggdrasil', 'yg-config.yaml');
  const cfg = readFileSync(cfgPath, 'utf-8').replace(
    /endpoint:\s*["']?[^"'\n]+["']?/,
    `endpoint: "${DEAD_ENDPOINT}"`,
  );
  writeFileSync(cfgPath, cfg, 'utf-8');
}

/** Build a hermetic, LLM-free copy of the fixture (strip LLM aspect + kill endpoint). */
function hermeticFixture(label: string): string {
  const dir = deterministicFixture(label);
  killReviewer(dir);
  return dir;
}

const ordersFile = (dir: string) => path.join(dir, 'src', 'services', 'orders.ts');
const paymentsFile = (dir: string) => path.join(dir, 'src', 'services', 'payments.ts');

const aspectYaml = (dir: string, aspect: string) =>
  path.join(dir, '.yggdrasil', 'aspects', aspect, 'yg-aspect.yaml');
const ordersNodeYaml = (dir: string) =>
  path.join(dir, '.yggdrasil', 'model', 'services', 'orders', 'yg-node.yaml');
const servicesNodeYaml = (dir: string) =>
  path.join(dir, '.yggdrasil', 'model', 'services', 'yg-node.yaml');

const baselineFile = (dir: string, node: string) =>
  path.join(dir, '.yggdrasil', '.drift-state', ...node.split('/')) + '.json';

/**
 * Author a self-contained deterministic aspect that flags any line containing
 * `literal`. Raw-content check (mirrors the fixture's `no-todo-comments`) — no
 * AST imports, fully hermetic, zero LLM cost. `status` is written verbatim, or
 * omitted entirely when `status === null` so the aspect-level default
 * (documented as `enforced`) can be exercised. The aspect is NOT attached
 * anywhere by default — each test attaches it on exactly the channel under test.
 */
function authorLiteralAspect(
  dir: string,
  id: string,
  literal: string,
  status: 'draft' | 'advisory' | 'enforced' | null,
): void {
  const aspectDir = path.join(dir, '.yggdrasil', 'aspects', id);
  mkdirSync(aspectDir, { recursive: true });
  const yaml = [
    `name: ${id.replace(/-/g, '')}`,
    `description: Source files must not contain the literal token ${literal}.`,
    'reviewer:',
    '  type: deterministic',
    ...(status === null ? [] : [`status: ${status}`]),
    '',
  ];
  writeFileSync(path.join(aspectDir, 'yg-aspect.yaml'), yaml.join('\n'), 'utf-8');
  writeFileSync(
    path.join(aspectDir, 'check.mjs'),
    [
      'export function check(ctx) {',
      '  const violations = [];',
      '  for (const file of ctx.files) {',
      '    const lines = file.content.split("\\n");',
      '    for (let i = 0; i < lines.length; i++) {',
      `      if (lines[i].includes(${JSON.stringify(literal)})) {`,
      `        violations.push({ file: file.path, line: i + 1, column: 0, message: ${JSON.stringify(
        `${literal} found.`,
      )} });`,
      '      }',
      '    }',
      '  }',
      '  return violations;',
      '}',
      '',
    ].join('\n'),
    'utf-8',
  );
}

/** Read the persisted per-node canonical drift hash from its baseline. */
function baselineHash(dir: string, node: string): string {
  return JSON.parse(readFileSync(baselineFile(dir, node), 'utf-8')).hash as string;
}

/** Read the persisted per-aspect verdict object from a node baseline. */
function aspectVerdict(
  dir: string,
  node: string,
  aspectId: string,
): { verdict: string; reason?: string; errorSource?: string } | undefined {
  const base = JSON.parse(readFileSync(baselineFile(dir, node), 'utf-8'));
  return base.aspectVerdicts?.[aspectId];
}

// ---------------------------------------------------------------------------
// ASPECT-STATUS combinatorics — driven entirely through the real built binary.
// Covers the under-tested corners: effective-status max() involving DRAFT,
// default-to-enforced, multi-node status-flip cascade, hash (in)stability across
// the advisory<->enforced flip, the persisted refused-enforced baseline, the
// status_inherit chain, the draft-implier propagation path, and the all-draft
// skip. Each case asserts BOTH the `yg context` status tag AND the resulting
// block/warn/skip behavior at approve/check.
// ---------------------------------------------------------------------------

describe.skipIf(!distExists)('CLI E2E — aspect-status combinatorics (draft max(), flip cascade, defaults, persisted verdicts)', () => {
  // === Group A: effective-status max() across cascading channels with DRAFT ===

  // A1: max(draft, advisory) = advisory.
  // no-banned-word default DRAFT, attached on the parent NODE (channel 2) with
  // an explicit status:advisory. max(draft, advisory) -> advisory: context tags
  // it [advisory] and a violation is a NON-blocking warning (approve exits 0,
  // recorded but not blocking).
  it('A1: max(draft default, advisory attach) = advisory — context tags [advisory] and a violation does NOT block approve', () => {
    const dir = hermeticFixture('max-draft-advisory');
    try {
      authorLiteralAspect(dir, 'no-banned-word', 'BANNED', 'draft');
      writeFileSync(
        servicesNodeYaml(dir),
        [
          'name: Services',
          "description: Organizational parent grouping the application's service units.",
          'type: module',
          'aspects:',
          '  - id: no-banned-word',
          '    status: advisory',
          '',
        ].join('\n'),
        'utf-8',
      );

      // Effective status is advisory (max of draft default + advisory attach):
      // it is NO LONGER skipped (it carries a live `read:` line, not the draft
      // "reviewer skipped" note).
      const ctx = run(['context', '--node', 'services/orders'], dir);
      expect(ctx.status).toBe(0);
      expect(ctx.stdout).toContain('no-banned-word [advisory]');

      // Approve the other node clean so the final state has no unrelated drift.
      expect(run(['approve', '--node', 'services/payments'], dir).status).toBe(0);

      appendFileSync(ordersFile(dir), '\n// BANNED token here\n');
      const approve = run(['approve', '--node', 'services/orders'], dir);
      expect(approve.status).toBe(0); // advisory does NOT block approve
      expect(approve.stdout).toContain('no-banned-word');
      expect(approve.stdout).toContain('advisory');
      expect(approve.stdout).toContain('Approved: services/orders');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // A2: max(draft, enforced) = enforced.
  // Same aspect default DRAFT, but the parent-node attach raises it to enforced.
  // max(draft, enforced) -> enforced: context tags [enforced] and a violation
  // BLOCKS approve (exit 1, NOT SATISFIED).
  it('A2: max(draft default, enforced attach) = enforced — context tags [enforced] and a violation BLOCKS approve (exit 1)', () => {
    const dir = hermeticFixture('max-draft-enforced');
    try {
      authorLiteralAspect(dir, 'no-banned-word', 'BANNED', 'draft');
      writeFileSync(
        servicesNodeYaml(dir),
        [
          'name: Services',
          "description: Organizational parent grouping the application's service units.",
          'type: module',
          'aspects:',
          '  - id: no-banned-word',
          '    status: enforced',
          '',
        ].join('\n'),
        'utf-8',
      );

      const ctx = run(['context', '--node', 'services/orders'], dir);
      expect(ctx.status).toBe(0);
      expect(ctx.stdout).toContain('no-banned-word [enforced]');

      // A clean approve passes (the now-enforced aspect is satisfied).
      expect(run(['approve', '--node', 'services/orders'], dir).status).toBe(0);

      appendFileSync(ordersFile(dir), '\n// BANNED token here\n');
      const refused = run(['approve', '--node', 'services/orders'], dir);
      expect(refused.status).toBe(1); // enforced blocks
      expect(refused.stdout).toContain('no-banned-word');
      expect(refused.stdout).toContain('NOT SATISFIED');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // === Group B: default-to-enforced when status is omitted ===

  // B3: an aspect with NO `status:` line in yg-aspect.yaml, attached with NO
  // status at the attach site, resolves to ENFORCED. Every other status test
  // assumes this default — here it is asserted explicitly: context tags
  // [enforced] and a violation BLOCKS.
  it('B3: status omitted on BOTH the aspect default and the attach site resolves to enforced and blocks', () => {
    const dir = hermeticFixture('default-enforced');
    try {
      // authorLiteralAspect with status:null writes NO `status:` line.
      authorLiteralAspect(dir, 'no-marker', 'MARKER', null);
      // Attach bare (no `status:` at the attach site either) on the orders node.
      writeFileSync(
        ordersNodeYaml(dir),
        [
          'name: OrdersService',
          'description: Creates and retrieves customer orders.',
          'type: service',
          'aspects:',
          '  - wip-rule',
          '  - no-marker',
          'mapping:',
          '  - src/services/orders.ts',
          '',
        ].join('\n'),
        'utf-8',
      );

      // Sanity: the authored yaml truly has no status line, so this proves the
      // DEFAULT (not a written value) is what yields enforced.
      expect(readFileSync(aspectYaml(dir, 'no-marker'), 'utf-8')).not.toContain('status:');

      const ctx = run(['context', '--node', 'services/orders'], dir);
      expect(ctx.status).toBe(0);
      expect(ctx.stdout).toContain('no-marker [enforced]');

      expect(run(['approve', '--node', 'services/orders'], dir).status).toBe(0);
      appendFileSync(ordersFile(dir), '\n// MARKER here\n');
      const refused = run(['approve', '--node', 'services/orders'], dir);
      expect(refused.status).toBe(1);
      expect(refused.stdout).toContain('no-marker');
      expect(refused.stdout).toContain('NOT SATISFIED');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // === Group C: a node whose EVERY effective aspect resolves to draft ===

  // C4: when every effective aspect on a node is draft, the reviewer is skipped
  // entirely. approve prints the all-draft notice, writes NO baseline, tracks NO
  // drift, and `yg check` PASSES (counting the node's aspects as draft).
  it('C4: an all-draft node is skipped entirely — no baseline, no drift, approve exits 0 with the all-draft notice', () => {
    const dir = hermeticFixture('all-draft');
    try {
      // Flip the two type-default aspects to draft. services/orders then has only
      // draft effective aspects: wip-rule (own, draft), no-todo-comments (type +
      // flow, now draft), requires-named-export (type, now draft).
      writeFileSync(
        aspectYaml(dir, 'no-todo-comments'),
        readFileSync(aspectYaml(dir, 'no-todo-comments'), 'utf-8').replace(
          /^status: enforced$/m,
          'status: draft',
        ),
        'utf-8',
      );
      writeFileSync(
        aspectYaml(dir, 'requires-named-export'),
        readFileSync(aspectYaml(dir, 'requires-named-export'), 'utf-8').replace(
          /^status: advisory$/m,
          'status: draft',
        ),
        'utf-8',
      );

      // context shows all three aspects as draft (each "reviewer skipped").
      const ctx = run(['context', '--node', 'services/orders'], dir);
      expect(ctx.status).toBe(0);
      expect(ctx.stdout).toContain('wip-rule [draft]');
      expect(ctx.stdout).toContain('no-todo-comments [draft]');
      expect(ctx.stdout).toContain('requires-named-export [draft]');

      const approve = run(['approve', '--node', 'services/orders'], dir);
      expect(approve.status).toBe(0);
      // Distinctive all-draft notice, and the explicit "no baseline / no drift".
      expect(approve.stdout).toContain(
        "Every effective aspect on node 'services/orders' has status 'draft'. Reviewer skipped.",
      );
      expect(approve.stdout).toContain('no baseline written, no drift tracked');
      // No baseline file is created for the all-draft node.
      expect(existsSync(baselineFile(dir, 'services/orders'))).toBe(false);

      // payments still has draft no-todo + draft requires-export -> it too is
      // all-draft; approve it and confirm the whole graph check is clean (the
      // draft node contributes no error, no warning, no newly-active drift).
      expect(run(['approve', '--node', 'services/payments'], dir).status).toBe(0);
      const check = run(['check'], dir);
      expect(check.status).toBe(0);
      expect(check.stdout).toContain('PASS');
      // No draft node ever reports drift or a newly-active aspect.
      expect(check.stdout).not.toContain('aspect-newly-active');
      expect(check.stdout).not.toContain('drift');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // === Group D: multi-node cascade on a status FLIP of a SHARED aspect ===

  // D5: no-todo-comments is a type-default on `service`, so it is effective on
  // BOTH services/orders and services/payments. Flipping it draft -> enforced
  // fires aspect-newly-active on EVERY node that has it effective (not just one);
  // the `--aspect` batch re-approve records the missing verdict on both and
  // clears the drift.
  it('D5: flipping a SHARED aspect draft->enforced fires aspect-newly-active on EVERY effective node; per-node approve clears both', () => {
    const dir = hermeticFixture('flip-newly-active-multi');
    try {
      // Start with no-todo-comments DRAFT (dormant on both nodes). The advisory
      // requires-named-export keeps each node's effective set non-all-draft, so a
      // real baseline is written for both.
      writeFileSync(
        aspectYaml(dir, 'no-todo-comments'),
        readFileSync(aspectYaml(dir, 'no-todo-comments'), 'utf-8').replace(
          /^status: enforced$/m,
          'status: draft',
        ),
        'utf-8',
      );

      const initial = run(['approve', '--node', 'services/orders', '--node', 'services/payments'], dir);
      expect(initial.status).toBe(0);
      expect(initial.stdout).toContain('2 approved');
      expect(run(['check'], dir).status).toBe(0);

      // Flip draft -> enforced. no-todo-comments now has no baseline verdict on
      // either node.
      writeFileSync(
        aspectYaml(dir, 'no-todo-comments'),
        readFileSync(aspectYaml(dir, 'no-todo-comments'), 'utf-8').replace(
          /^status: draft$/m,
          'status: enforced',
        ),
        'utf-8',
      );

      const drifted = run(['check'], dir);
      expect(drifted.status).toBe(1);
      // aspect-newly-active fires on BOTH nodes — the flip is graph-wide, not
      // local to a single node.
      expect(drifted.stdout).toContain('aspect-newly-active');
      const newlyActiveLines = drifted.stdout
        .split('\n')
        .filter((l) => l.includes('aspect-newly-active'));
      const namesOrders = newlyActiveLines.some((l) => l.includes('services/orders'));
      const namesPayments = newlyActiveLines.some((l) => l.includes('services/payments'));
      expect(namesOrders).toBe(true);
      expect(namesPayments).toBe(true);
      // The newly-active aspect is named in the message.
      expect(drifted.stdout).toContain("Aspect 'no-todo-comments'");

      // A draft->non-draft activation surfaces as aspect-newly-active (not an
      // aspect cascade — status is not part of the canonical hash), so the
      // documented remediation is a per-node approve, which records the missing
      // verdict on both nodes.
      const reapprove = run(['approve', '--node', 'services/orders', '--node', 'services/payments'], dir);
      expect(reapprove.status).toBe(0);
      expect(reapprove.stdout).toContain('services/orders');
      expect(reapprove.stdout).toContain('services/payments');
      expect(reapprove.stdout).toContain('2 approved');

      // Drift cleared on both nodes.
      const cleared = run(['check'], dir);
      expect(cleared.status).toBe(0);
      expect(cleared.stdout).not.toContain('aspect-newly-active');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // D6: flipping the SAME shared aspect enforced -> advisory is a RENDER flip,
  // not a refusal change in the code. With a refused (TODO) baseline on BOTH
  // nodes, the flip turns the two BLOCKING errors into two NON-blocking warnings:
  // `yg check` goes from FAIL (2 errors) to PASS (2 warnings) for both nodes at
  // once. The recorded refused verdicts are carried forward unchanged — only
  // their render severity flips.
  it('D6: flipping a SHARED aspect enforced->advisory flips block->warn on EVERY node (check FAIL -> PASS)', () => {
    const dir = hermeticFixture('flip-render-multi');
    try {
      // Plant a TODO in BOTH sources so no-todo-comments (enforced) refuses on
      // both nodes -> two persisted refused verdicts.
      appendFileSync(ordersFile(dir), '\n// TODO: orders debt\n');
      appendFileSync(paymentsFile(dir), '\n// TODO: payments debt\n');
      run(['approve', '--node', 'services/orders', '--node', 'services/payments'], dir);

      // While enforced: check FAILS with both nodes as blocking errors.
      const enforcedCheck = run(['check'], dir);
      expect(enforcedCheck.status).toBe(1);
      expect(enforcedCheck.stdout).toContain('FAIL');

      // Flip enforced -> advisory and re-approve (the aspect-yaml edit cascades;
      // see the BUG note in E7). The persisted refused verdict is carried
      // forward — re-approve re-runs the deterministic check and re-records the
      // same refusal, now under advisory status.
      writeFileSync(
        aspectYaml(dir, 'no-todo-comments'),
        readFileSync(aspectYaml(dir, 'no-todo-comments'), 'utf-8').replace(
          /^status: enforced$/m,
          'status: advisory',
        ),
        'utf-8',
      );
      run(['approve', '--aspect', 'no-todo-comments'], dir);

      const advisoryCheck = run(['check'], dir);
      // Block -> warn on BOTH nodes: the gate now PASSES with two warnings.
      expect(advisoryCheck.status).toBe(0);
      expect(advisoryCheck.stdout).toContain('PASS');
      const warnLines = advisoryCheck.stdout.split('\n').filter((l) => l.includes('advisory'));
      expect(warnLines.some((l) => l.includes('services/orders'))).toBe(true);
      expect(warnLines.some((l) => l.includes('services/payments'))).toBe(true);
      // The violation is still recorded (not erased) — it just renders as a warning.
      expect(advisoryCheck.stdout).toContain('TODO comment found');
      expect(advisoryCheck.stdout).not.toContain('FAIL');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // === Group E: hash (in)stability across the advisory<->enforced flip ===

  // E7: the per-node canonical drift hash and the advisory<->enforced flip.
  //
  // BUG / CONTRACT DIVERGENCE — the per-node hash is NOT stable across the flip.
  //
  //   CONTRACT (knowledge read aspect-status / drift-and-cascade):
  //     "Status is NOT part of the canonical drift hash. The hash stays stable
  //      across advisory <-> enforced flips."
  //
  //   The drift tracker hashes the aspect's DEFINITION metadata EXCLUDING the
  //   `status` field (core/graph/files.ts tracks an `aspect-meta:<id>` synthetic
  //   instead of the raw yg-aspect.yaml whose bytes include `status:`). So a bare
  //   advisory<->enforced flip — check.mjs and source byte-for-byte unchanged —
  //   does NOT change the node's canonical hash and does NOT cascade. (A
  //   draft<->non-draft transition is still surfaced, but via aspect-newly-active,
  //   covered by D5; the render-severity flip is covered by D6.)
  it('E7: a bare enforced->advisory status flip does NOT cascade and the per-node canonical hash stays stable', () => {
    const dir = hermeticFixture('hash-flip-stable');
    try {
      run(['approve', '--node', 'services/orders'], dir);
      run(['approve', '--node', 'services/payments'], dir);
      const before = baselineHash(dir, 'services/orders');

      // Flip ONLY the status line — check.mjs and source are unchanged.
      writeFileSync(
        aspectYaml(dir, 'no-todo-comments'),
        readFileSync(aspectYaml(dir, 'no-todo-comments'), 'utf-8').replace(
          /^status: enforced$/m,
          'status: advisory',
        ),
        'utf-8',
      );

      // No cascade: status is not part of the canonical drift hash. The aspect
      // passes (orders.ts has no TODO), so advisory renders nothing → check clean.
      const drifted = run(['check'], dir);
      expect(drifted.status).toBe(0);
      expect(drifted.stdout).not.toContain("aspect 'no-todo-comments' changed");
      expect(drifted.stdout).not.toContain('Source files changed');

      // The recorded canonical hash is unchanged — a status flip is not drift, so
      // there is nothing to re-approve and the baseline is untouched.
      const after = baselineHash(dir, 'services/orders');
      expect(after).toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // === Group F: a REFUSED enforced verdict is PERSISTED in the baseline ===

  // E8/F8: approving a node whose enforced aspect is violated writes a baseline
  // that RECORDS the refused verdict (verdict:refused, errorSource:codeViolation).
  // A SECOND `yg check` then renders the stored refusal as a blocking error
  // WITHOUT re-running the reviewer — the source is unchanged, so there is no
  // source drift; the verdict is read straight from the baseline.
  it('F8: a refused ENFORCED verdict is persisted in the baseline and a second check renders it without re-running', () => {
    const dir = hermeticFixture('refused-persisted');
    try {
      // Approve payments clean so the only check error comes from the persisted
      // orders refusal.
      expect(run(['approve', '--node', 'services/payments'], dir).status).toBe(0);

      // Violate the enforced no-todo-comments and approve -> refused, exit 1.
      appendFileSync(ordersFile(dir), '\n// TODO: persisted refusal\n');
      const approve = run(['approve', '--node', 'services/orders'], dir);
      expect(approve.status).toBe(1);
      expect(approve.stdout).toContain('no-todo-comments');
      expect(approve.stdout).toContain('NOT SATISFIED');

      // The baseline exists and records the REFUSED verdict (not merely absent).
      expect(existsSync(baselineFile(dir, 'services/orders'))).toBe(true);
      const verdict = aspectVerdict(dir, 'services/orders', 'no-todo-comments');
      expect(verdict?.verdict).toBe('refused');
      expect(verdict?.errorSource).toBe('codeViolation');
      expect(verdict?.reason).toContain('TODO comment found');

      // A second check renders the STORED refusal as a blocking enforced error.
      // The source is unchanged since approve, so this is NOT source drift — the
      // verdict comes straight from the persisted baseline.
      const check = run(['check'], dir);
      expect(check.status).toBe(1);
      expect(check.stdout).toContain('enforced');
      expect(check.stdout).toContain('services/orders');
      expect(check.stdout).toContain("fails enforced aspect 'no-todo-comments'");
      expect(check.stdout).toContain('TODO comment found');
      // It is rendered from the baseline, not re-flagged as new source drift.
      expect(check.stdout).not.toContain('Source files changed');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // === Group G: status_inherit chain for implies ===

  // G9: status_inherit `strictest` (the default) propagates the STRICTEST status
  // down a MULTI-LEVEL implies chain. no-todo-comments (enforced, the service
  // type-default) strictest-implies impA (own default advisory); impA
  // strictest-implies impB (own default advisory). Each level takes
  // max(implier_effective, own_default), so both impA and impB are promoted to
  // [enforced] transitively, and a violation of the deepest one BLOCKS approve.
  //
  // Distinct from cli-implies test 6 (single-level, both enforced) and test 7
  // (single-level own-default) — this pins the TRANSITIVE strictest promotion of
  // an advisory-default aspect across two levels.
  it('G9: strictest status_inherit promotes advisory-default implied aspects to enforced TRANSITIVELY across a 2-level chain', () => {
    const dir = hermeticFixture('status-inherit-chain');
    try {
      // impA and impB both default ADVISORY, attached nowhere except via implies.
      authorLiteralAspect(dir, 'imp-a', 'AAA', 'advisory');
      authorLiteralAspect(dir, 'imp-b', 'BBB', 'advisory');
      // impA strictest-implies impB (bare `implies:` -> strictest default).
      writeFileSync(
        aspectYaml(dir, 'imp-a'),
        [
          'name: impa',
          'description: Source files must not contain the literal token AAA.',
          'reviewer:',
          '  type: deterministic',
          'status: advisory',
          'implies:',
          '  - imp-b',
          '',
        ].join('\n'),
        'utf-8',
      );
      // no-todo-comments (enforced) strictest-implies impA.
      appendFileSync(aspectYaml(dir, 'no-todo-comments'), 'implies:\n  - imp-a\n');

      // Both implied aspects render [enforced] — promoted from their advisory
      // own-default by the strictest cascade flowing through the chain.
      const ctx = run(['context', '--node', 'services/orders'], dir);
      expect(ctx.status).toBe(0);
      expect(ctx.stdout).toContain('imp-a [enforced]');
      expect(ctx.stdout).toContain('imp-b [enforced]');
      expect(ctx.stdout).toContain("implied by 'no-todo-comments'");
      expect(ctx.stdout).toContain("implied by 'imp-a'");

      // A violation of the DEEPEST (2-level) implied aspect blocks approve,
      // confirming the promotion to enforced is real (not cosmetic).
      expect(run(['approve', '--node', 'services/orders'], dir).status).toBe(0);
      appendFileSync(ordersFile(dir), '\n// BBB token\n');
      const refused = run(['approve', '--node', 'services/orders'], dir);
      expect(refused.status).toBe(1);
      expect(refused.stdout).toContain('imp-b');
      expect(refused.stdout).toContain('NOT SATISFIED');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // G10: a DRAFT implier is dormant for implies SET membership — it does NOT pull
  // its implied aspect into the node's effective set (knowledge read aspect-status,
  // "Implies propagation": "If A's effective status on N is draft -> B is NOT
  // propagated via implies; B may still arrive via another channel"). Both the
  // effective-SET (expandImpliesFiltered) and the status MAP skip draft impliers,
  // so the implied aspect is absent from context and never evaluated at approve.
  it('G10: a DRAFT implier does NOT propagate its implied aspect (dormant); context omits it and approve does not block', () => {
    const dir = hermeticFixture('draft-implier-dormant');
    try {
      // draft-implier: DRAFT. implied-by-draft: own default enforced, attached
      // NOWHERE except via the draft implier's implies edge.
      authorLiteralAspect(dir, 'draft-implier', 'DDD', 'draft');
      authorLiteralAspect(dir, 'implied-by-draft', 'EEE', 'enforced');
      writeFileSync(
        aspectYaml(dir, 'draft-implier'),
        [
          'name: draftimplier',
          'description: Source files must not contain the literal token DDD.',
          'reviewer:',
          '  type: deterministic',
          'status: draft',
          'implies:',
          '  - implied-by-draft',
          '',
        ].join('\n'),
        'utf-8',
      );
      // Attach the DRAFT implier on the orders node (channel 1). It is the ONLY
      // path to implied-by-draft.
      writeFileSync(
        ordersNodeYaml(dir),
        [
          'name: OrdersService',
          'description: Creates and retrieves customer orders.',
          'type: service',
          'aspects:',
          '  - draft-implier',
          'mapping:',
          '  - src/services/orders.ts',
          '',
        ].join('\n'),
        'utf-8',
      );

      const ctx = run(['context', '--node', 'services/orders'], dir);
      expect(ctx.status).toBe(0);
      // The draft implier is shown skipped, and the dormant implier does NOT pull
      // its implied aspect into the effective set.
      expect(ctx.stdout).toContain('draft-implier [draft]');
      // implied-by-draft is NOT an effective aspect entry (only the implier's
      // "Implies:" metadata line names it, never as `implied-by-draft [status]`).
      expect(ctx.stdout).not.toContain('implied-by-draft [');
      expect(ctx.stdout).not.toContain("implied by 'draft-implier'");

      // Its violation does NOT block approve — the implied aspect is dormant.
      appendFileSync(ordersFile(dir), '\n// EEE token\n');
      const result = run(['approve', '--node', 'services/orders'], dir);
      expect(result.status).toBe(0);
      expect(result.stdout).not.toContain('NOT SATISFIED');
      // The draft implier itself is announced as skipped.
      expect(result.stdout).toContain('draft-implier');
      expect(result.stdout).toContain('skipped');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // === Group H: approve --aspect on a fully-draft aspect ===

  // H11: `yg approve --aspect <id>` where the aspect's default status is draft
  // (so it is skipped on every node) is a no-op: the CLI prints the all-draft
  // notice for the aspect and exits 0 without writing any baseline.
  it('H11: approve --aspect on a draft-default aspect skips every node and exits 0 with the all-draft notice', () => {
    const dir = hermeticFixture('approve-aspect-draft');
    try {
      // Flip no-todo-comments to draft so `--aspect no-todo-comments` targets a
      // fully-draft aspect.
      writeFileSync(
        aspectYaml(dir, 'no-todo-comments'),
        readFileSync(aspectYaml(dir, 'no-todo-comments'), 'utf-8').replace(
          /^status: enforced$/m,
          'status: draft',
        ),
        'utf-8',
      );

      const approve = run(['approve', '--aspect', 'no-todo-comments'], dir);
      expect(approve.status).toBe(0);
      expect(approve.stdout).toContain(
        "Aspect 'no-todo-comments' has default status 'draft' — reviewer skipped on every node.",
      );
      expect(approve.stdout).toContain('Draft aspects are dormant; no baseline written, no drift tracked.');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
