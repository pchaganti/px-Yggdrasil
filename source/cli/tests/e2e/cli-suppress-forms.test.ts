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
  const dir = mkdtempSync(path.join(tmpdir(), `yg-suppress-${label}-`));
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

const ordersNodeYaml = (dir: string) =>
  path.join(dir, '.yggdrasil', 'model', 'services', 'orders', 'yg-node.yaml');
const paymentsNodeYaml = (dir: string) =>
  path.join(dir, '.yggdrasil', 'model', 'services', 'payments', 'yg-node.yaml');

/**
 * Write a single-file-style deterministic aspect that flags every line
 * containing `token`. The aspect id is the directory name. Both the single-file
 * and the graph-aware deterministic runners surface `ctx.files[].content`, so a
 * content-scan check like this exercises the per-file path.
 */
function writeTokenAspect(dir: string, id: string, token: string): void {
  const aspectDir = path.join(dir, '.yggdrasil', 'aspects', id);
  mkdirSync(aspectDir, { recursive: true });
  writeFileSync(
    path.join(aspectDir, 'yg-aspect.yaml'),
    [
      `name: ${id}`,
      `description: Source lines must not contain the ${token} token.`,
      'reviewer:',
      '  type: deterministic',
      'status: enforced',
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

/**
 * Write a GRAPH-AWARE deterministic aspect. It reaches the node's own mapped
 * file through the graph surface (`ctx.node.files` + `ctx.fs.read`) rather than
 * iterating raw `ctx.files`, and reports `file`+`line`. This is the path STRUCT-1
 * taught to honor in-source `yg-suppress` markers (the structure runner filters
 * suppressed violations by aspect id + line).
 */
function writeGraphAwareAspect(dir: string, id: string, token: string): void {
  const aspectDir = path.join(dir, '.yggdrasil', 'aspects', id);
  mkdirSync(aspectDir, { recursive: true });
  writeFileSync(
    path.join(aspectDir, 'yg-aspect.yaml'),
    [
      `name: ${id}`,
      `description: Graph-aware rule — a node's own file must not contain the ${token} token.`,
      'reviewer:',
      '  type: deterministic',
      'status: enforced',
      '',
    ].join('\n'),
    'utf-8',
  );
  writeFileSync(
    path.join(aspectDir, 'check.mjs'),
    [
      'export function check(ctx) {',
      '  const out = [];',
      '  for (const f of ctx.node.files) {',
      '    const content = ctx.fs.read(f.path);',
      '    const lines = content.split("\\n");',
      '    for (let i = 0; i < lines.length; i++) {',
      `      if (lines[i].includes(${JSON.stringify(token)})) {`,
      `        out.push({ file: f.path, line: i + 1, column: 0, message: ${JSON.stringify(`${id}: ${token} present.`)} });`,
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
function setNodeAspects(nodeYamlPath: string, name: string, description: string, mapping: string, aspects: string[]): void {
  const lines = [`name: ${name}`, `description: ${description}`, 'type: service'];
  if (aspects.length > 0) {
    lines.push('aspects:');
    for (const a of aspects) lines.push(`  - ${a}`);
  }
  lines.push('mapping:', `  - ${mapping}`, '');
  writeFileSync(nodeYamlPath, lines.join('\n'), 'utf-8');
}

// ---------------------------------------------------------------------------
// yg-suppress SYNTACTIC FORMS + edge cases NOT covered by cli-status-suppress
// (which already pins: bracket wildcard range, single-line over one of two
// TODOs, draft-aspect suppress no-op). Fully hermetic: every test builds its
// own graph in a fresh temp dir, uses only deterministic check.mjs aspects, and
// makes no network / clock / random reads in any assertion.
// ---------------------------------------------------------------------------

describe.skipIf(!distExists)('CLI E2E — yg-suppress syntactic forms + aspect-path matching', () => {
  // --- 1. FILE-LEVEL placement: bare disable() at the top waives the WHOLE file ---
  //
  // REVIEWER-TYPE-SPECIFIC SUPPRESS SEMANTICS — pinning the DETERMINISTIC behavior.
  //
  // Suppress is interpreted differently by the two reviewer types:
  //   * LLM aspects: the reviewer prompt (src/llm/aspect-verifier.ts) INSTRUCTS the
  //     model that the marker "applies contextually to the surrounding code
  //     (function, class, or block)... at file level, the entire file." So for an
  //     LLM aspect a single-line / file-level marker IS contextual / whole-file.
  //     The `yg knowledge read suppress-syntax` "File-level placement" wording
  //     describes THIS behavior.
  //   * DETERMINISTIC aspects (AST + structure runners, src/ast/suppress.ts): purely
  //     LINE-BASED. A single-line `yg-suppress(<id>)` covers exactly ONE line — the
  //     line immediately below it (`m.line + 1`). A marker on line 1 waives only
  //     line 2; a violation deeper in the file is NOT waived. The only construct
  //     that waives "to end of file" is a bare `yg-suppress-disable(<id>)` with NO
  //     matching `enable` — the unterminated disable range extends through the last
  //     line. The knowledge doc does not currently spell out this deterministic
  //     line-based difference (recorded in .temp/dogfood-report.md).
  //
  // This suite exercises the DETERMINISTIC runners, so the whole-file waiver here is
  // the unterminated disable. (See test 1b for the proof that the single-line form
  // does NOT do whole-file scoping under the deterministic runner.)

  it('1: a file-level yg-suppress-disable(no-todo-comments) (no enable) waives a TODO deep in the file; approve+check green', () => {
    const dir = hermeticFixture('file-level-disable');
    try {
      expect(run(['approve', '--node', 'services/orders'], dir).status).toBe(0);
      expect(run(['approve', '--node', 'services/payments'], dir).status).toBe(0);

      // File-level marker at the TOP (before any code), then a TODO buried in a
      // function body further down. The unterminated disable covers to EOF.
      const body = readFileSync(paymentsFile(dir), 'utf-8');
      writeFileSync(
        paymentsFile(dir),
        [
          '// yg-suppress-disable(no-todo-comments) generated file, debt tracked in the issue tracker',
          body,
          '',
          'function deepHelper(p: Payment): Payment {',
          '  // TODO: buried debt far below the file-level marker',
          '  return p;',
          '}',
          '',
        ].join('\n'),
        'utf-8',
      );

      const approve = run(['approve', '--node', 'services/payments'], dir);
      expect(approve.status).toBe(0);
      expect(approve.stdout).toContain('Approved: services/payments');
      expect(approve.stdout).not.toContain('NOT SATISFIED');

      const check = run(['check'], dir);
      expect(check.status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- 1b. NEGATION + the single-line-at-top divergence proof ---

  it('1b: the identical deep TODO refuses WITHOUT the file-level disable; a single-line marker on line 1 does NOT cover it either', () => {
    const dir = hermeticFixture('file-level-control');
    try {
      expect(run(['approve', '--node', 'services/payments'], dir).status).toBe(0);
      const clean = readFileSync(paymentsFile(dir), 'utf-8');

      const deepTodo = [
        '',
        'function deepHelper(p: Payment): Payment {',
        '  // TODO: buried debt far below the top of the file',
        '  return p;',
        '}',
        '',
      ].join('\n');

      // (a) No marker at all -> the enforced aspect refuses.
      writeFileSync(paymentsFile(dir), clean + deepTodo, 'utf-8');
      const noMarker = run(['approve', '--node', 'services/payments'], dir);
      expect(noMarker.status).toBe(1);
      expect(noMarker.stdout).toContain('no-todo-comments');
      expect(noMarker.stdout).toContain('NOT SATISFIED');

      // (b) A SINGLE-LINE yg-suppress(...) on line 1 still refuses: under the
      // DETERMINISTIC runner the single-line form covers only the line
      // immediately below the marker (line 2), not the whole file. (The
      // contextual / whole-file reading in the suppress-syntax doc is the LLM
      // reviewer's behavior; deterministic suppress is strictly line-based.)
      writeFileSync(
        paymentsFile(dir),
        '// yg-suppress(no-todo-comments) generated file, debt tracked in the issue tracker\n' +
          clean +
          deepTodo,
        'utf-8',
      );
      const singleLineTop = run(['approve', '--node', 'services/payments'], dir);
      expect(singleLineTop.status).toBe(1);
      expect(singleLineTop.stdout).toContain('no-todo-comments');
      expect(singleLineTop.stdout).toContain('NOT SATISFIED');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- 2. SINGLE-LINE WILDCARD waives EVERY aspect on the contextual block ---

  it('2: a single-line yg-suppress(*) above one line waives TWO distinct aspects both violated on that line; approve exits 0', () => {
    const dir = hermeticFixture('single-line-wildcard');
    try {
      // Two independent enforced aspects that both flag any line carrying the
      // same token. Attach both to the payments node.
      writeTokenAspect(dir, 'ban-foo', 'BADTOKEN');
      writeTokenAspect(dir, 'ban-bar', 'BADTOKEN');
      setNodeAspects(
        paymentsNodeYaml(dir),
        'PaymentsService',
        'Charges and refunds payments for orders.',
        'src/services/payments.ts',
        ['ban-foo', 'ban-bar'],
      );
      expect(run(['approve', '--node', 'services/payments'], dir).status).toBe(0);

      // ONE wildcard single-line marker directly above the single offending line.
      appendFileSync(
        paymentsFile(dir),
        [
          '',
          '// yg-suppress(*) generated reconciliation constant, debt tracked in the issue tracker',
          'const reconcileTag = "BADTOKEN";',
          '',
        ].join('\n'),
        'utf-8',
      );

      const approve = run(['approve', '--node', 'services/payments'], dir);
      expect(approve.status).toBe(0);
      expect(approve.stdout).toContain('Approved: services/payments');
      // BOTH aspects waived by the single wildcard marker — neither refuses.
      expect(approve.stdout).not.toContain('NOT SATISFIED');
      expect(approve.stdout).not.toContain('ban-foo — NOT SATISFIED');
      expect(approve.stdout).not.toContain('ban-bar — NOT SATISFIED');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- 2b. control: the same line WITHOUT the wildcard marker fires both aspects ---

  it('2b: WITHOUT the wildcard marker the identical line trips BOTH aspects; approve exits 1', () => {
    const dir = hermeticFixture('single-line-wildcard-control');
    try {
      writeTokenAspect(dir, 'ban-foo', 'BADTOKEN');
      writeTokenAspect(dir, 'ban-bar', 'BADTOKEN');
      setNodeAspects(
        paymentsNodeYaml(dir),
        'PaymentsService',
        'Charges and refunds payments for orders.',
        'src/services/payments.ts',
        ['ban-foo', 'ban-bar'],
      );
      expect(run(['approve', '--node', 'services/payments'], dir).status).toBe(0);

      appendFileSync(paymentsFile(dir), '\nconst reconcileTag = "BADTOKEN";\n', 'utf-8');

      const approve = run(['approve', '--node', 'services/payments'], dir);
      expect(approve.status).toBe(1);
      expect(approve.stdout).toContain('ban-foo — NOT SATISFIED');
      expect(approve.stdout).toContain('ban-bar — NOT SATISFIED');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- 3. WRONG aspect-path is a silent no-op (matched by id, not blanket-applied) ---

  it('3: a yg-suppress naming a NON-EXISTENT aspect-path does NOT waive the real violation; no "unknown target" notice; exit 1', () => {
    const dir = hermeticFixture('wrong-path-noop');
    try {
      expect(run(['approve', '--node', 'services/orders'], dir).status).toBe(0);

      // Marker names "no-todo-commentz" — a typo. The real aspect is
      // "no-todo-comments". The token is matched as a plain string against the
      // aspect id; a non-matching id suppresses nothing.
      appendFileSync(
        ordersFile(dir),
        [
          '',
          '// yg-suppress(no-todo-commentz) typo in the aspect id, debt tracked in the issue tracker',
          '// TODO: this is still flagged because the suppress id does not match',
          '',
        ].join('\n'),
        'utf-8',
      );

      const approve = run(['approve', '--node', 'services/orders'], dir);
      expect(approve.status).toBe(1);
      expect(approve.stdout).toContain('no-todo-comments');
      expect(approve.stdout).toContain('NOT SATISFIED');
      // The CLI does NOT warn that the suppress id is unknown — a wrong/typo'd
      // aspect-path is silently inert (nothing validates the id exists).
      expect(approve.all.toLowerCase()).not.toContain('unknown suppress');
      expect(approve.all.toLowerCase()).not.toContain('suppress target');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- 4. CORRECT aspect-path IS waived (positive control for test 3) ---

  it('4: the SAME violation with the CORRECT aspect-path in the single-line marker IS waived; approve exits 0', () => {
    const dir = hermeticFixture('correct-path-match');
    try {
      expect(run(['approve', '--node', 'services/orders'], dir).status).toBe(0);

      // Identical placement to test 3, but the id is spelled correctly.
      appendFileSync(
        ordersFile(dir),
        [
          '',
          '// yg-suppress(no-todo-comments) known debt, tracked in the issue tracker',
          '// TODO: this is waived because the suppress id matches exactly',
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

  // --- 5. GRAPH-AWARE (structure) runner honors in-source yg-suppress (STRUCT-1) ---

  it('5: a graph-aware (ctx.graph/ctx.fs) violation is waived by a single-line yg-suppress; approve exits 0', () => {
    const dir = hermeticFixture('graph-aware-suppress');
    try {
      // FORBIDDENMARK is chosen so it never appears inside the marker comment
      // text itself (the aspect id contains no such substring) — the only
      // matching line is the offending code line.
      writeGraphAwareAspect(dir, 'graph-no-forbidden', 'FORBIDDENMARK');
      setNodeAspects(
        ordersNodeYaml(dir),
        'OrdersService',
        'Creates and retrieves customer orders.',
        'src/services/orders.ts',
        ['graph-no-forbidden'],
      );
      expect(run(['approve', '--node', 'services/orders'], dir).status).toBe(0);

      appendFileSync(
        ordersFile(dir),
        [
          '',
          '// yg-suppress(graph-no-forbidden) graph-shape debt, tracked in the issue tracker',
          'const forbiddenTag = "FORBIDDENMARK";',
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

  it('5b: the same graph-aware violation refuses WITHOUT the marker, and a WRONG-id marker does NOT waive it; exit 1', () => {
    const dir = hermeticFixture('graph-aware-control');
    try {
      writeGraphAwareAspect(dir, 'graph-no-forbidden', 'FORBIDDENMARK');
      setNodeAspects(
        ordersNodeYaml(dir),
        'OrdersService',
        'Creates and retrieves customer orders.',
        'src/services/orders.ts',
        ['graph-no-forbidden'],
      );
      expect(run(['approve', '--node', 'services/orders'], dir).status).toBe(0);
      const clean = readFileSync(ordersFile(dir), 'utf-8');

      // (a) No marker -> graph-aware aspect refuses.
      writeFileSync(ordersFile(dir), clean + '\nconst forbiddenTag = "FORBIDDENMARK";\n', 'utf-8');
      const noMarker = run(['approve', '--node', 'services/orders'], dir);
      expect(noMarker.status).toBe(1);
      expect(noMarker.stdout).toContain('graph-no-forbidden — NOT SATISFIED');

      // (b) Wrong-id marker -> still refuses (suppress is matched by aspect id).
      writeFileSync(
        ordersFile(dir),
        clean +
          '\n// yg-suppress(graph-no-forbiddenz) wrong id, debt tracked in the issue tracker\n' +
          'const forbiddenTag = "FORBIDDENMARK";\n',
        'utf-8',
      );
      const wrongId = run(['approve', '--node', 'services/orders'], dir);
      expect(wrongId.status).toBe(1);
      expect(wrongId.stdout).toContain('graph-no-forbidden — NOT SATISFIED');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- 6. NAMED bracket disable/enable waives ONLY that aspect; a second aspect in the range still fires ---

  it('6: a bracket yg-suppress-disable(ban-foo)..enable(ban-foo) waives only ban-foo; ban-bar in the same range still refuses; exit 1', () => {
    const dir = hermeticFixture('named-bracket');
    try {
      // Two enforced aspects flagging the same token; attach both to payments.
      writeTokenAspect(dir, 'ban-foo', 'BADTOKEN');
      writeTokenAspect(dir, 'ban-bar', 'BADTOKEN');
      setNodeAspects(
        paymentsNodeYaml(dir),
        'PaymentsService',
        'Charges and refunds payments for orders.',
        'src/services/payments.ts',
        ['ban-foo', 'ban-bar'],
      );
      expect(run(['approve', '--node', 'services/payments'], dir).status).toBe(0);

      // A bracket scoped to ONE NAMED aspect (NOT wildcard) around the offending
      // line. Only ban-foo is named, so ban-bar still fires inside the range.
      appendFileSync(
        paymentsFile(dir),
        [
          '',
          '// yg-suppress-disable(ban-foo) legacy reconciliation block, debt tracked in the issue tracker',
          'const reconcileTag = "BADTOKEN";',
          '// yg-suppress-enable(ban-foo)',
          '',
        ].join('\n'),
        'utf-8',
      );

      const approve = run(['approve', '--node', 'services/payments'], dir);
      expect(approve.status).toBe(1);
      // ban-foo is waived by the named bracket; ban-bar is NOT (different id).
      expect(approve.stdout).toContain('ban-foo — SATISFIED');
      expect(approve.stdout).toContain('ban-bar — NOT SATISFIED');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
