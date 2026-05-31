import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  cpSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
  const dir = mkdtempSync(path.join(tmpdir(), `yg-supdet-${label}-`));
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

/**
 * Copy the fixture and strip the LLM aspect (`has-doc-comment`) so the node's
 * effective aspects are purely deterministic. This makes the approve/check
 * lifecycle hermetic: no network, no LLM verdict, fully reproducible — only the
 * deterministic check.mjs aspects drive every refuse/pass outcome.
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
 * Repoint the reviewer endpoint at the dead loopback address. The
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
const paymentsNodeYaml = (dir: string) =>
  path.join(dir, '.yggdrasil', 'model', 'services', 'payments', 'yg-node.yaml');
const aspectYaml = (dir: string, id: string) =>
  path.join(dir, '.yggdrasil', 'aspects', ...id.split('/'), 'yg-aspect.yaml');

/**
 * Write a single-file content-scan deterministic aspect that flags every line
 * containing `token`. The aspect id is its directory path under aspects/ — so a
 * HIERARCHICAL id like `family/child` is created as nested directories. Status
 * defaults to enforced; pass `status` to override.
 */
function writeTokenAspect(dir: string, id: string, token: string, status = 'enforced'): void {
  const aspectDir = path.join(dir, '.yggdrasil', 'aspects', ...id.split('/'));
  mkdirSync(aspectDir, { recursive: true });
  // Aspect display name must be a plain identifier — derive it from the leaf.
  const name = id.split('/').join('-');
  writeFileSync(
    path.join(aspectDir, 'yg-aspect.yaml'),
    [
      `name: ${name}`,
      `description: Source lines must not contain the ${token} token.`,
      'reviewer:',
      '  type: deterministic',
      `status: ${status}`,
      '',
    ].join('\n'),
    'utf-8',
  );
  writeFileSync(
    path.join(aspectDir, 'check.mjs'),
    [
      'export function check(ctx) {',
      '  const out = [];',
      '  for (const file of ctx.files) {',
      '    const lines = file.content.split("\\n");',
      '    for (let i = 0; i < lines.length; i++) {',
      `      if (lines[i].includes(${JSON.stringify(token)})) {`,
      `        out.push({ file: file.path, line: i + 1, column: 0, message: ${JSON.stringify(`${id}: ${token} present.`)} });`,
      '      }',
      '    }',
      '  }',
      '  return out;',
      '}',
      '',
    ].join('\n'),
    'utf-8',
  );
}

/** Re-author a service node so its OWN aspects are exactly `aspects`. */
function setNodeAspects(
  nodeYamlPath: string,
  name: string,
  description: string,
  mapping: string,
  aspects: string[],
): void {
  const lines = [`name: ${name}`, `description: ${description}`, 'type: service'];
  if (aspects.length > 0) {
    lines.push('aspects:');
    for (const a of aspects) lines.push(`  - ${a}`);
  }
  lines.push('mapping:', `  - ${mapping}`, '');
  writeFileSync(nodeYamlPath, lines.join('\n'), 'utf-8');
}

// ---------------------------------------------------------------------------
// DETERMINISTIC-reviewer suppress paths NOT covered by cli-status-suppress
// (bracket wildcard, single-line over one of two TODOs, draft no-op) or
// cli-suppress-forms (file-level unterminated disable, single-line wildcard,
// typo no-op, named bracket, graph-aware runner). This suite pins:
//   * hierarchical aspect-id scoping (parent id does NOT waive a child id —
//     the matcher is EXACT-id + wildcard only)
//   * empty-reason rejection (SUPPRESS_MARKER_MISSING_REASON) for the
//     single-line and bracket-disable forms, surfaced at approve
//   * the enable marker requiring NO reason
//   * a draft->advisory flip turning a previously-inert suppress effective
//   * multiple comma-separated ids in ONE single-line marker each waived
//   * a block-comment (slash-star ... star-slash) marker honored
// Fully hermetic: each test builds its own graph in a fresh temp dir, uses only
// deterministic check.mjs aspects, and makes no network/clock/random reads.
// ---------------------------------------------------------------------------

describe.skipIf(!distExists)('CLI E2E — deterministic suppress: hierarchy / empty-reason / flip / multi-id / block-comment', () => {
  // --- 1. HIERARCHICAL id scoping: a parent-id suppress does NOT waive a child-id violation ---
  //
  // ACTUAL BEHAVIOR pinned (src/ast/suppress.ts isLineSuppressed): a range matches
  // a violation only when the violated aspect id is EXACTLY in the range's id set,
  // or the range is wildcard. There is NO parent/child scoping — suppressing
  // `family/parent` does not cover a `family/child` violation on the same line.

  it('1: yg-suppress(family/parent) does NOT waive a family/child violation on the next line; child refuses (exit 1)', () => {
    const dir = hermeticFixture('hier-parent-noop');
    try {
      // Two independent enforced aspects with hierarchical ids; both flag the
      // same token. The node carries BOTH so a single offending line trips them.
      writeTokenAspect(dir, 'family/parent', 'HIERTOKEN');
      writeTokenAspect(dir, 'family/child', 'HIERTOKEN');
      setNodeAspects(
        paymentsNodeYaml(dir),
        'PaymentsService',
        'Charges and refunds payments for orders.',
        'src/services/payments.ts',
        ['family/parent', 'family/child'],
      );
      expect(run(['approve', '--node', 'services/payments'], dir).status).toBe(0);

      // Suppress only the PARENT id over the offending line.
      appendFileSync(
        paymentsFile(dir),
        [
          '',
          '// yg-suppress(family/parent) parent-id marker, debt tracked in the issue tracker',
          'const hierTag = "HIERTOKEN";',
          '',
        ].join('\n'),
        'utf-8',
      );

      const approve = run(['approve', '--node', 'services/payments'], dir);
      expect(approve.status).toBe(1);
      // The parent id IS waived by its exact-id marker; the child id is NOT —
      // a parent-id suppress provides no hierarchical cover for the child.
      expect(approve.stdout).toContain('family/parent — SATISFIED');
      expect(approve.stdout).toContain('family/child — NOT SATISFIED');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- 1b. positive control: the EXACT child id DOES waive the child violation ---

  it('1b: yg-suppress(family/child) waives the family/child violation (exact hierarchical id matches); approve exits 0', () => {
    const dir = hermeticFixture('hier-child-match');
    try {
      writeTokenAspect(dir, 'family/parent', 'HIERTOKEN');
      writeTokenAspect(dir, 'family/child', 'HIERTOKEN');
      setNodeAspects(
        paymentsNodeYaml(dir),
        'PaymentsService',
        'Charges and refunds payments for orders.',
        'src/services/payments.ts',
        ['family/child'], // only the child aspect is effective here
      );
      expect(run(['approve', '--node', 'services/payments'], dir).status).toBe(0);

      appendFileSync(
        paymentsFile(dir),
        [
          '',
          '// yg-suppress(family/child) exact child-id marker, debt tracked in the issue tracker',
          'const hierTag = "HIERTOKEN";',
          '',
        ].join('\n'),
        'utf-8',
      );

      const approve = run(['approve', '--node', 'services/payments'], dir);
      expect(approve.status).toBe(0);
      expect(approve.stdout).toContain('Approved: services/payments');
      expect(approve.stdout).not.toContain('NOT SATISFIED');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- 2. EMPTY-REASON single-line marker is rejected: SUPPRESS_MARKER_MISSING_REASON ---
  //
  // The empty-reason throw lives in collectSuppressions (src/ast/suppress.ts).
  // Under the structure runner it surfaces only while filtering a real
  // violation's file (ranges are collected lazily for files carrying a
  // violation), so the marker must sit on a file that ALSO violates the aspect.

  it('2: a single-line yg-suppress(no-todo-comments) with NO reason is rejected with SUPPRESS_MARKER_MISSING_REASON (exit 1)', () => {
    const dir = hermeticFixture('empty-reason-single');
    try {
      expect(run(['approve', '--node', 'services/orders'], dir).status).toBe(0);

      // Marker has the aspect id but no reason text after the parens. A TODO on
      // the suppressed line gives the runner a violation to filter, which is what
      // triggers suppression collection (and the missing-reason throw).
      appendFileSync(
        ordersFile(dir),
        [
          '',
          '// yg-suppress(no-todo-comments)',
          '// TODO: this line would be the suppress target',
          '',
        ].join('\n'),
        'utf-8',
      );

      const approve = run(['approve', '--node', 'services/orders'], dir);
      expect(approve.status).toBe(1);
      expect(approve.stdout).toContain('SUPPRESS_MARKER_MISSING_REASON');
      expect(approve.stdout).toContain('missing reason');
      expect(approve.stdout).toContain('no-todo-comments — NOT SATISFIED');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- 3. EMPTY-REASON bracket disable marker is rejected too ---

  it('3: a bracket yg-suppress-disable(no-todo-comments) with NO reason is rejected with SUPPRESS_MARKER_MISSING_REASON (exit 1)', () => {
    const dir = hermeticFixture('empty-reason-bracket');
    try {
      expect(run(['approve', '--node', 'services/orders'], dir).status).toBe(0);

      // disable() with no reason → reject. A matching enable closes the range; a
      // TODO inside it gives the runner a violation that forces range collection.
      appendFileSync(
        ordersFile(dir),
        [
          '',
          '// yg-suppress-disable(no-todo-comments)',
          '// TODO: inside the bracket range',
          '// yg-suppress-enable(no-todo-comments)',
          '',
        ].join('\n'),
        'utf-8',
      );

      const approve = run(['approve', '--node', 'services/orders'], dir);
      expect(approve.status).toBe(1);
      expect(approve.stdout).toContain('SUPPRESS_MARKER_MISSING_REASON');
      expect(approve.stdout).toContain('yg-suppress-disable');
      expect(approve.stdout).toContain('no-todo-comments — NOT SATISFIED');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- 4. The ENABLE marker requires NO reason: disable(with reason)..enable(no reason) waives the range ---
  //
  // Only the single-line and disable forms require a reason (makeMarker). The
  // enable form is parsed without a reason at all (RE_ENABLE captures only the
  // id). A bare enable that closes a properly-reasoned disable must waive the
  // range cleanly — no missing-reason error.

  it('4: a disable(reason)..enable(no reason) bracket waives a TODO in range; approve exits 0 with no suppress error', () => {
    const dir = hermeticFixture('enable-no-reason');
    try {
      expect(run(['approve', '--node', 'services/payments'], dir).status).toBe(0);

      appendFileSync(
        paymentsFile(dir),
        [
          '',
          '// yg-suppress-disable(no-todo-comments) legacy block, debt tracked in the issue tracker',
          '// TODO: inside the reasoned-disable / bare-enable bracket',
          'function legacyReconcile(p: Payment): Payment {',
          '  return p;',
          '}',
          '// yg-suppress-enable(no-todo-comments)',
          '',
        ].join('\n'),
        'utf-8',
      );

      const approve = run(['approve', '--node', 'services/payments'], dir);
      expect(approve.status).toBe(0);
      expect(approve.stdout).toContain('Approved: services/payments');
      expect(approve.stdout).not.toContain('NOT SATISFIED');
      // The bare enable is valid syntax — no missing-reason rejection fired.
      expect(approve.all).not.toContain('SUPPRESS_MARKER_MISSING_REASON');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- 5. draft -> advisory flip makes a previously-INERT suppress become effective ---
  //
  // While the aspect is draft the reviewer never runs it, so the suppress is a
  // no-op AND there is no violation. After the flip to advisory the aspect is
  // live: the SAME unchanged suppress now actually waives the now-active
  // violation, so the advisory aspect reports SATISFIED (not a warning).

  it('5: a yg-suppress over a draft aspect is inert; after draft->advisory the same marker waives the now-active violation', () => {
    const dir = hermeticFixture('flip-suppress-effective');
    try {
      // banflip flags HIERTOKEN; start it DRAFT and attach to payments.
      writeTokenAspect(dir, 'banflip', 'FLIPTOKEN', 'draft');
      setNodeAspects(
        paymentsNodeYaml(dir),
        'PaymentsService',
        'Charges and refunds payments for orders.',
        'src/services/payments.ts',
        ['banflip'],
      );

      // Offending line WITH a suppress for banflip. While banflip is draft the
      // aspect is dormant: approve passes and the suppress does nothing.
      appendFileSync(
        paymentsFile(dir),
        [
          '',
          '// yg-suppress(banflip) flip debt, tracked in the issue tracker',
          'const flipTag = "FLIPTOKEN";',
          '',
        ].join('\n'),
        'utf-8',
      );

      const draftApprove = run(['approve', '--node', 'services/payments'], dir);
      expect(draftApprove.status).toBe(0);
      expect(draftApprove.stdout).toContain('skipped'); // draft aspect skipped
      expect(draftApprove.stdout).not.toContain('NOT SATISFIED');

      // Promote banflip draft -> advisory. The aspect is now live; the SAME
      // suppress (unchanged) waives the violation it now produces.
      const flipped = readFileSync(aspectYaml(dir, 'banflip'), 'utf-8').replace(
        /^status: draft$/m,
        'status: advisory',
      );
      writeFileSync(aspectYaml(dir, 'banflip'), flipped, 'utf-8');

      const advisoryApprove = run(['approve', '--node', 'services/payments'], dir);
      expect(advisoryApprove.status).toBe(0);
      expect(advisoryApprove.stdout).toContain('Approved: services/payments');
      // The now-active aspect is waived by the suppress — no advisory warning,
      // no refusal: the suppress that was inert under draft is now effective.
      expect(advisoryApprove.stdout).not.toContain('NOT SATISFIED');
      expect(advisoryApprove.stdout).not.toContain('banflip — NOT SATISFIED');
      // Approve the other node clean (it never carried banflip) so the final
      // check has no unrelated unapproved-node error, then confirm check is
      // green — the waived advisory aspect leaks no warning.
      expect(run(['approve', '--node', 'services/orders'], dir).status).toBe(0);
      const check = run(['check'], dir);
      expect(check.status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- 5b. control: WITHOUT the suppress, after the flip the advisory aspect warns ---

  it('5b: WITHOUT the suppress, after draft->advisory the violation surfaces as a non-blocking advisory warning (approve exits 0)', () => {
    const dir = hermeticFixture('flip-no-suppress-control');
    try {
      writeTokenAspect(dir, 'banflip', 'FLIPTOKEN', 'draft');
      setNodeAspects(
        paymentsNodeYaml(dir),
        'PaymentsService',
        'Charges and refunds payments for orders.',
        'src/services/payments.ts',
        ['banflip'],
      );

      // Same offending line, NO suppress marker.
      appendFileSync(paymentsFile(dir), '\nconst flipTag = "FLIPTOKEN";\n', 'utf-8');

      expect(run(['approve', '--node', 'services/payments'], dir).status).toBe(0);

      const flipped = readFileSync(aspectYaml(dir, 'banflip'), 'utf-8').replace(
        /^status: draft$/m,
        'status: advisory',
      );
      writeFileSync(aspectYaml(dir, 'banflip'), flipped, 'utf-8');

      const advisoryApprove = run(['approve', '--node', 'services/payments'], dir);
      // Advisory violation does NOT block approve, but IS surfaced.
      expect(advisoryApprove.status).toBe(0);
      expect(advisoryApprove.all).toContain('advisory');
      expect(advisoryApprove.all).toContain('banflip');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- 6. MULTIPLE comma-separated ids in ONE single-line marker each waived ---
  //
  // splitAspectList parses a comma list; the single-line range's id set then
  // contains every listed id, so a line violating two distinct aspects is waived
  // by one marker listing both ids.

  it('6: a single-line yg-suppress(ban-foo, ban-bar) waives BOTH aspects on the next line; approve exits 0', () => {
    const dir = hermeticFixture('multi-id-single-line');
    try {
      writeTokenAspect(dir, 'ban-foo', 'MULTITOKEN');
      writeTokenAspect(dir, 'ban-bar', 'MULTITOKEN');
      setNodeAspects(
        paymentsNodeYaml(dir),
        'PaymentsService',
        'Charges and refunds payments for orders.',
        'src/services/payments.ts',
        ['ban-foo', 'ban-bar'],
      );
      expect(run(['approve', '--node', 'services/payments'], dir).status).toBe(0);

      // ONE marker listing BOTH ids, comma-separated, above the offending line.
      appendFileSync(
        paymentsFile(dir),
        [
          '',
          '// yg-suppress(ban-foo, ban-bar) both rules waived, debt tracked in the issue tracker',
          'const multiTag = "MULTITOKEN";',
          '',
        ].join('\n'),
        'utf-8',
      );

      const approve = run(['approve', '--node', 'services/payments'], dir);
      expect(approve.status).toBe(0);
      expect(approve.stdout).toContain('Approved: services/payments');
      expect(approve.stdout).not.toContain('NOT SATISFIED');
      expect(approve.stdout).not.toContain('ban-foo — NOT SATISFIED');
      expect(approve.stdout).not.toContain('ban-bar — NOT SATISFIED');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- 6b. control: a single-line marker naming only ONE of the two ids leaves the other flagged ---

  it('6b: a single-line yg-suppress(ban-foo) leaves ban-bar flagged on the same line; approve exits 1', () => {
    const dir = hermeticFixture('multi-id-partial');
    try {
      writeTokenAspect(dir, 'ban-foo', 'MULTITOKEN');
      writeTokenAspect(dir, 'ban-bar', 'MULTITOKEN');
      setNodeAspects(
        paymentsNodeYaml(dir),
        'PaymentsService',
        'Charges and refunds payments for orders.',
        'src/services/payments.ts',
        ['ban-foo', 'ban-bar'],
      );
      expect(run(['approve', '--node', 'services/payments'], dir).status).toBe(0);

      appendFileSync(
        paymentsFile(dir),
        [
          '',
          '// yg-suppress(ban-foo) only one rule waived, debt tracked in the issue tracker',
          'const multiTag = "MULTITOKEN";',
          '',
        ].join('\n'),
        'utf-8',
      );

      const approve = run(['approve', '--node', 'services/payments'], dir);
      expect(approve.status).toBe(1);
      expect(approve.stdout).toContain('ban-foo — SATISFIED');
      expect(approve.stdout).toContain('ban-bar — NOT SATISFIED');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- 7. BLOCK-COMMENT (slash-star ... star-slash) marker is honored by the deterministic runner ---
  //
  // commentBody strips the slash-star/star-slash delimiters, so a marker written
  // as a block comment is parsed identically to a // line comment. The marker
  // still scopes to the line BELOW it (single-line semantics), so place the
  // violation there.

  it('7: a block-comment slash-star yg-suppress(no-todo-comments) star-slash waives the TODO on the next line; approve exits 0', () => {
    const dir = hermeticFixture('block-comment-marker');
    try {
      expect(run(['approve', '--node', 'services/orders'], dir).status).toBe(0);

      appendFileSync(
        ordersFile(dir),
        [
          '',
          '/* yg-suppress(no-todo-comments) block-comment marker, debt tracked in the issue tracker */',
          '// TODO: waived by the block-comment marker above',
          '',
        ].join('\n'),
        'utf-8',
      );

      const approve = run(['approve', '--node', 'services/orders'], dir);
      expect(approve.status).toBe(0);
      expect(approve.stdout).toContain('Approved: services/orders');
      expect(approve.stdout).not.toContain('NOT SATISFIED');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- 7b. control: the identical block-comment marker WITHOUT a matching id leaves the TODO flagged ---

  it('7b: a block-comment marker with a WRONG id does NOT waive the TODO; approve exits 1 (parsed, but id mismatch)', () => {
    const dir = hermeticFixture('block-comment-wrong-id');
    try {
      expect(run(['approve', '--node', 'services/orders'], dir).status).toBe(0);

      appendFileSync(
        ordersFile(dir),
        [
          '',
          '/* yg-suppress(no-todo-commentz) typo id, debt tracked in the issue tracker */',
          '// TODO: still flagged — the block comment parsed but the id mismatches',
          '',
        ].join('\n'),
        'utf-8',
      );

      const approve = run(['approve', '--node', 'services/orders'], dir);
      expect(approve.status).toBe(1);
      expect(approve.stdout).toContain('no-todo-comments — NOT SATISFIED');
      // The block comment was parsed (no missing-reason error) — it simply did
      // not match the violated aspect id.
      expect(approve.all).not.toContain('SUPPRESS_MARKER_MISSING_REASON');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
