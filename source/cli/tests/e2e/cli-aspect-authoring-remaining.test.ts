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
import { startMockReviewer, runAsync } from './support/mock-reviewer.js';

// Hermetic E2E — ASPECT AUTHORING, the remaining (~uncovered) paths:
//   * ctx.parseYaml / ctx.parseJson / ctx.parseToml — the structured-data parse
//     helpers of the graph-aware deterministic ctx surface. cli-deterministic-ctx
//     exercises ctx.parseAst only; the three structured-data parsers are unpinned.
//     Pinned here on a CONFORMING input (parse succeeds, semantic rule holds) and
//     a MALFORMED input (the helper throws — the check catches it and emits a
//     clean author violation, proving the helper genuinely parses).
//   * a per-attach `when` on a DESCENDANTS.RELATIONS atom (a descendant that
//     declares a relation of a given type to a given target_type). cli-aspect-authoring
//     E2 covers descendants.type and cli-channels-extended B2 covers descendants.type;
//     the descendants.relations atom is unexercised end-to-end. (The consumes_port
//     when-atom on an aspect attach is already pinned by cli-ports-enforcement 4a;
//     the relation-atom by cli-aspect-authoring E1 — both deliberately SKIPPED here.)
//   * the reference-file MODIFICATION cascade with a WORKING LLM verdict (the
//     in-process mock): editing an LLM aspect's declared `references:` file drifts
//     EVERY node the aspect reaches, and a clean re-approve via the reviewer CLEARS
//     the cascade — the full round-trip. cli-drift-cascade-variety 2 pins only the
//     cascade MESSAGE with a KILLED reviewer (no clean approve is reachable there).
//   * aspect REMOVAL lazy baseline cleanup: detaching an aspect from a node and
//     re-approving evicts its stale per-aspect verdict from the baseline.
//
// Harness (run / BIN_PATH / copyFixture / deterministicFixture / killReviewer) is
// reused verbatim from cli-deterministic-lifecycle.test.ts; the mock-reviewer
// harness (startMockReviewer / runAsync) from support/mock-reviewer.ts. Every graph
// is built in a fresh mkdtemp COPY of the committed e2e-lifecycle fixture; the
// committed fixture is never mutated; each test rmSync's its dir in finally. No
// network, no fixed port, no clock/random in assertions.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'e2e-lifecycle');

const distExists = existsSync(BIN_PATH);

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
  const dir = mkdtempSync(path.join(tmpdir(), `yg-authrem-${label}-`));
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

/**
 * Copy the fixture and strip the LLM aspect (`has-doc-comment`) so the node's
 * effective aspects are purely deterministic. Keeps the suite hermetic: no
 * reviewer endpoint is contacted, every approve/context/check outcome is
 * reproducible, and only deterministic check.mjs runs drive every verdict.
 */
function deterministicFixture(label: string): string {
  const dir = copyFixture(label);
  const archPath = path.join(dir, '.yggdrasil', 'yg-architecture.yaml');
  const arch = readFileSync(archPath, 'utf-8')
    .split('\n')
    .filter((line) => line.trim() !== '- has-doc-comment')
    .join('\n');
  writeFileSync(archPath, arch, 'utf-8');
  rmSync(path.join(dir, '.yggdrasil', 'aspects', 'has-doc-comment'), {
    recursive: true,
    force: true,
  });
  return dir;
}

// --- path helpers (operate on the temp COPY only) ---------------------------

const nodeYaml = (dir: string, node: string) =>
  path.join(dir, '.yggdrasil', 'model', ...node.split('/'), 'yg-node.yaml');
const aspectDir = (dir: string, id: string) => path.join(dir, '.yggdrasil', 'aspects', id);
const aspectYaml = (dir: string, id: string) => path.join(aspectDir(dir, id), 'yg-aspect.yaml');
const baselineFile = (dir: string, node: string) =>
  path.join(dir, '.yggdrasil', '.drift-state', ...node.split('/')) + '.json';

/** Author a deterministic aspect (yg-aspect.yaml + check.mjs) into the temp copy. */
function writeDeterministicAspect(dir: string, id: string, description: string, checkSource: string): void {
  const adir = aspectDir(dir, id);
  mkdirSync(adir, { recursive: true });
  writeFileSync(
    aspectYaml(dir, id),
    [
      `name: ${id.replace(/-/g, '')}`,
      `description: ${description}`,
      'reviewer:',
      '  type: deterministic',
      'status: enforced',
      '',
    ].join('\n'),
    'utf-8',
  );
  writeFileSync(path.join(adir, 'check.mjs'), checkSource, 'utf-8');
}

/** Read the persisted per-aspect verdict keys from a node baseline. */
function verdictKeys(dir: string, node: string): string[] {
  const base = JSON.parse(readFileSync(baselineFile(dir, node), 'utf-8')) as {
    aspectVerdicts?: Record<string, unknown>;
  };
  return Object.keys(base.aspectVerdicts ?? {});
}

/**
 * Silence the two channels that deliver `no-todo-comments` unconditionally in the
 * committed fixture (the `service` architecture-type default, channel 3, and the
 * order-processing flow, channel 5), leaving a node's own declaration as the sole
 * delivery path — so a per-attach `when` is the ONLY include/exclude lever.
 */
function isolateNoTodoToNodeChannel(dir: string): void {
  const archPath = path.join(dir, '.yggdrasil', 'yg-architecture.yaml');
  writeFileSync(
    archPath,
    readFileSync(archPath, 'utf-8').replace(
      '    aspects:\n      - no-todo-comments\n      - requires-named-export\n',
      '    aspects:\n      - requires-named-export\n',
    ),
    'utf-8',
  );
  const flowPath = path.join(dir, '.yggdrasil', 'flows', 'order-processing', 'yg-flow.yaml');
  writeFileSync(
    flowPath,
    readFileSync(flowPath, 'utf-8').replace('aspects:\n  - no-todo-comments\n', 'aspects: []\n'),
    'utf-8',
  );
}

// `no-todo-comments [enforced]` is the stable heading substring `yg context`
// prints when the aspect is effective; wholly absent when `when` filters it out.
const EFFECTIVE_MARKER = 'no-todo-comments [enforced]';

// ---------------------------------------------------------------------------
// A check.mjs that parses every mapped data file with the format-appropriate
// ctx parse helper, validates a single field, and CATCHES a parse failure to
// emit a clean author violation. This pins that ctx.parseYaml/Json/Toml actually
// parse: a conforming file yields the parsed value (semantic rule holds), a
// malformed file makes the helper throw (surfaced as an author violation here).
// ---------------------------------------------------------------------------
const PARSE_HELPERS_CHECK = `export function check(ctx) {
  const violations = [];
  for (const file of ctx.files) {
    let data;
    if (file.path.endsWith('.yaml') || file.path.endsWith('.yml')) {
      try { data = ctx.parseYaml(file); }
      catch (e) { violations.push({ file: file.path, line: 1, column: 0, message: 'parseYaml failed: ' + e.message }); continue; }
    } else if (file.path.endsWith('.json')) {
      try { data = ctx.parseJson(file); }
      catch (e) { violations.push({ file: file.path, line: 1, column: 0, message: 'parseJson failed: ' + e.message }); continue; }
    } else if (file.path.endsWith('.toml')) {
      try { data = ctx.parseToml(file); }
      catch (e) { violations.push({ file: file.path, line: 1, column: 0, message: 'parseToml failed: ' + e.message }); continue; }
    } else {
      continue;
    }
    if (data == null || data.enabled !== true) {
      violations.push({ file: file.path, line: 1, column: 0, message: 'parsed object must have enabled === true, got ' + JSON.stringify(data && data.enabled) });
    }
  }
  return violations;
}
`;

/**
 * Attach the parse-helpers aspect to services/orders and add a single data file
 * (of the given extension+content) to that node's mapping. The orders node then
 * owns the .ts source plus the one data file; the check reads the data file
 * through the matching ctx parse helper.
 */
function setupParseFixture(dir: string, dataName: string, dataContent: string): void {
  writeDeterministicAspect(dir, 'parse-helpers', 'Parsed config files must declare enabled true.', PARSE_HELPERS_CHECK);
  writeFileSync(path.join(dir, 'src', 'services', dataName), dataContent, 'utf-8');
  writeFileSync(
    nodeYaml(dir, 'services/orders'),
    [
      'name: OrdersService',
      'description: Creates and retrieves customer orders.',
      'type: service',
      'aspects:',
      '  - parse-helpers',
      'mapping:',
      '  - src/services/orders.ts',
      `  - src/services/${dataName}`,
      '',
    ].join('\n'),
    'utf-8',
  );
}

describe.skipIf(!distExists)('CLI E2E — aspect authoring remaining paths (parse helpers / descendants.relations / reference cascade / removal cleanup)', () => {
  // =========================================================================
  // GROUP P — ctx.parseYaml / parseJson / parseToml structured-data helpers.
  // cli-deterministic-ctx pins ctx.parseAst only; these three are unpinned.
  // =========================================================================

  it('P1: ctx.parseYaml parses a CONFORMING .yaml mapped file — the semantic rule holds (No violations)', () => {
    const dir = deterministicFixture('p1-yaml-ok');
    try {
      setupParseFixture(dir, 'cfg.yaml', 'name: widget\nenabled: true\n');
      const test = run(['deterministic-test', '--aspect', 'parse-helpers', '--node', 'services/orders'], dir);
      expect(test.status).toBe(0);
      expect(test.all).toContain('No violations.');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('P2: ctx.parseYaml on a CONFORMING-but-wrong-VALUE .yaml flags the semantic rule (exit 1, parsed value surfaced)', () => {
    const dir = deterministicFixture('p2-yaml-value');
    try {
      // Valid YAML, but enabled is false → the helper parsed it; the rule fails.
      setupParseFixture(dir, 'cfg.yaml', 'name: widget\nenabled: false\n');
      const test = run(['deterministic-test', '--aspect', 'parse-helpers', '--node', 'services/orders'], dir);
      expect(test.status).toBe(1);
      expect(test.all).toContain('parsed object must have enabled === true, got false');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('P3: ctx.parseYaml on a MALFORMED .yaml throws — the check catches it and reports parseYaml failed (exit 1)', () => {
    const dir = deterministicFixture('p3-yaml-bad');
    try {
      // Broken block structure → the yaml parser throws.
      setupParseFixture(dir, 'cfg.yaml', 'name: [1, 2\n  - broken: : :\n');
      const test = run(['deterministic-test', '--aspect', 'parse-helpers', '--node', 'services/orders'], dir);
      expect(test.status).toBe(1);
      expect(test.all).toContain('parseYaml failed:');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('P4: ctx.parseJson parses a CONFORMING .json mapped file — the semantic rule holds (No violations)', () => {
    const dir = deterministicFixture('p4-json-ok');
    try {
      setupParseFixture(dir, 'cfg.json', '{ "name": "widget", "enabled": true }\n');
      const test = run(['deterministic-test', '--aspect', 'parse-helpers', '--node', 'services/orders'], dir);
      expect(test.status).toBe(0);
      expect(test.all).toContain('No violations.');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('P5: ctx.parseJson on a MALFORMED .json throws — the check catches it and reports parseJson failed (exit 1)', () => {
    const dir = deterministicFixture('p5-json-bad');
    try {
      setupParseFixture(dir, 'cfg.json', '{ "name": "widget", enabled true \n');
      const test = run(['deterministic-test', '--aspect', 'parse-helpers', '--node', 'services/orders'], dir);
      expect(test.status).toBe(1);
      expect(test.all).toContain('parseJson failed:');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('P6: ctx.parseToml parses a CONFORMING .toml mapped file — the semantic rule holds (No violations)', () => {
    const dir = deterministicFixture('p6-toml-ok');
    try {
      setupParseFixture(dir, 'cfg.toml', 'name = "widget"\nenabled = true\n');
      const test = run(['deterministic-test', '--aspect', 'parse-helpers', '--node', 'services/orders'], dir);
      expect(test.status).toBe(0);
      expect(test.all).toContain('No violations.');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('P7: ctx.parseToml on a MALFORMED .toml throws — the check catches it and reports parseToml failed (exit 1)', () => {
    const dir = deterministicFixture('p7-toml-bad');
    try {
      setupParseFixture(dir, 'cfg.toml', 'name = = "widget"\n');
      const test = run(['deterministic-test', '--aspect', 'parse-helpers', '--node', 'services/orders'], dir);
      expect(test.status).toBe(1);
      expect(test.all).toContain('parseToml failed:');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('P8: a CONFORMING parse-helpers aspect drives a real yg approve to a recorded baseline (exit 0)', () => {
    const dir = deterministicFixture('p8-approve');
    try {
      setupParseFixture(dir, 'cfg.toml', 'name = "widget"\nenabled = true\n');
      run(['log', 'add', '--node', 'services/orders', '--reason', 'attach parse-helpers rule with a conforming config file'], dir);
      const approve = run(['approve', '--node', 'services/orders'], dir);
      expect(approve.status).toBe(0);
      expect(approve.all).toContain('Approved: services/orders');
      expect(existsSync(baselineFile(dir, 'services/orders'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // =========================================================================
  // GROUP D — per-attach `when` on a DESCENDANTS.RELATIONS atom. cli-aspect-authoring
  // E2 + cli-channels-extended B2 cover descendants.type; the descendants.relations
  // atom (a descendant declaring a relation of a given type to a given target_type)
  // is unexercised. Gated on the `services` MODULE having any service descendant
  // that `calls` another service.
  // =========================================================================

  it('D1: descendants.relations atom INCLUDES the aspect when a descendant declares the matching relation', () => {
    const dir = deterministicFixture('d1-desc-rel-true');
    try {
      isolateNoTodoToNodeChannel(dir);
      // orders (a service descendant of `services`) declares calls→payments.
      writeFileSync(
        nodeYaml(dir, 'services/orders'),
        [
          'name: OrdersService',
          'description: Creates and retrieves customer orders.',
          'type: service',
          'relations:',
          '  - target: services/payments',
          '    type: calls',
          'mapping:',
          '  - src/services/orders.ts',
          '',
        ].join('\n'),
        'utf-8',
      );
      // Attach on the module, gated on a descendant that calls a service.
      writeFileSync(
        nodeYaml(dir, 'services'),
        [
          'name: Services',
          'description: Organizational grouping of services.',
          'type: module',
          'aspects:',
          '  - id: no-todo-comments',
          '    when:',
          '      descendants:',
          '        relations:',
          '          calls:',
          '            target_type: service',
          '',
        ].join('\n'),
        'utf-8',
      );
      const ctx = run(['context', '--node', 'services'], dir);
      expect(ctx.status).toBe(0);
      expect(ctx.stdout).toContain(EFFECTIVE_MARKER);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('D2: descendants.relations atom EXCLUDES the aspect when no descendant declares the relation', () => {
    const dir = deterministicFixture('d2-desc-rel-false');
    try {
      isolateNoTodoToNodeChannel(dir);
      // No descendant declares any relation (the committed children have none).
      writeFileSync(
        nodeYaml(dir, 'services'),
        [
          'name: Services',
          'description: Organizational grouping of services.',
          'type: module',
          'aspects:',
          '  - id: no-todo-comments',
          '    when:',
          '      descendants:',
          '        relations:',
          '          calls:',
          '            target_type: service',
          '',
        ].join('\n'),
        'utf-8',
      );
      const ctx = run(['context', '--node', 'services'], dir);
      expect(ctx.status).toBe(0);
      expect(ctx.stdout).not.toContain(EFFECTIVE_MARKER);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // =========================================================================
  // GROUP R — reference-file MODIFICATION cascade with a WORKING LLM verdict.
  // The in-process mock plays the reviewer so a CLEAN approve is reachable; the
  // node's baseline then records the reference file's hash. Editing the reference
  // file drifts every node the aspect reaches, and a clean re-approve via the mock
  // CLEARS the cascade — the full round-trip cli-drift-cascade-variety 2 cannot do
  // with a killed reviewer (no clean LLM verdict is recorded there).
  // =========================================================================

  function withReference(dir: string): string {
    // Declare a reference file on the committed LLM aspect (NOT stripped here).
    writeFileSync(
      aspectYaml(dir, 'has-doc-comment'),
      [
        'name: HasDocComment',
        "description: Every source file must begin with a documentation comment describing the file's purpose.",
        'reviewer:',
        '  type: llm',
        'status: enforced',
        'references:',
        '  - docs/guidance.md',
        '',
      ].join('\n'),
      'utf-8',
    );
    mkdirSync(path.join(dir, 'docs'), { recursive: true });
    const guidance = path.join(dir, 'docs', 'guidance.md');
    writeFileSync(guidance, '# Guidance\n\nDescribe the file purpose in the opening comment.\n', 'utf-8');
    return guidance;
  }

  function pointReviewer(dir: string, endpoint: string): void {
    const p = path.join(dir, '.yggdrasil', 'yg-config.yaml');
    writeFileSync(p, readFileSync(p, 'utf-8').replace(/endpoint:\s*["']?[^"'\n]+["']?/, `endpoint: "${endpoint}"`), 'utf-8');
  }

  it('R1: editing an LLM aspect reference file cascades to BOTH nodes; a clean re-approve via the reviewer CLEARS it', async () => {
    const dir = copyFixture('r1-reference-roundtrip');
    const mock = await startMockReviewer({ respond: () => ({ satisfied: true, reason: 'ok' }) });
    try {
      pointReviewer(dir, mock.endpoint);
      const guidance = withReference(dir);

      // Clean LLM approve on both participants — the baseline records the ref hash.
      const a1 = await runAsync(['approve', '--node', 'services/orders'], dir);
      const a2 = await runAsync(['approve', '--node', 'services/payments'], dir);
      expect(a1.status).toBe(0);
      expect(a2.status).toBe(0);
      expect(run(['check'], dir).status).toBe(0);

      // Edit the reference file → reference-file cascade across both nodes.
      appendFileSync(guidance, '\nAdditional guidance appended to trigger a cascade.\n');
      const drifted = run(['check'], dir);
      expect(drifted.status).toBe(1);
      expect(drifted.stdout).toContain('cascade');
      expect(drifted.stdout).toContain("reference file 'docs/guidance.md'");
      expect(drifted.stdout).toContain("declared by aspect 'has-doc-comment'");

      // A clean re-approve of the aspect re-runs the reviewer and clears the cascade.
      const reapprove = await runAsync(['approve', '--aspect', 'has-doc-comment'], dir);
      expect(reapprove.status).toBe(0);
      expect(reapprove.all).toContain('services/orders');
      expect(reapprove.all).toContain('services/payments');

      const cleared = run(['check'], dir);
      expect(cleared.stdout).not.toContain("reference file 'docs/guidance.md'");
      expect(cleared.status).toBe(0);
    } finally {
      await mock.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('R2: an aspect-only reference cascade re-runs ONLY that aspect — one reviewer call per affected node', async () => {
    const dir = copyFixture('r2-reference-cost');
    const mock = await startMockReviewer({ respond: () => ({ satisfied: true, reason: 'ok' }) });
    try {
      pointReviewer(dir, mock.endpoint);
      const guidance = withReference(dir);

      // Baseline both nodes; has-doc-comment is the sole LLM aspect → 1 call each.
      await runAsync(['approve', '--node', 'services/orders'], dir);
      await runAsync(['approve', '--node', 'services/payments'], dir);
      const afterBaseline = mock.chatCount();
      expect(afterBaseline).toBe(2);

      // Edit the reference → cascade → re-approve the aspect across both nodes.
      appendFileSync(guidance, '\nMore guidance.\n');
      const reapprove = await runAsync(['approve', '--aspect', 'has-doc-comment'], dir);
      expect(reapprove.status).toBe(0);
      // Exactly one additional reviewer call per affected node (orders, payments).
      expect(mock.chatCount()).toBe(afterBaseline + 2);
    } finally {
      await mock.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // =========================================================================
  // GROUP X — aspect REMOVAL lazy baseline cleanup. Detaching an aspect from a
  // node and re-approving evicts its stale per-aspect verdict from the baseline,
  // so no orphaned verdict lingers. Distinct from the draft-transition eviction
  // pinned by cli-aspect-status-extended (which keeps the aspect, only drafts it).
  // =========================================================================

  it('X1: attaching an aspect records its verdict; REMOVING it from the node evicts the stale verdict on re-approve', () => {
    const dir = deterministicFixture('x1-removal-cleanup');
    try {
      // Author an always-pass aspect and attach it to orders.
      writeDeterministicAspect(dir, 'extra-rule', 'An extra always-pass deterministic rule.', 'export function check(ctx) { return []; }\n');
      writeFileSync(
        nodeYaml(dir, 'services/orders'),
        [
          'name: OrdersService',
          'description: Creates and retrieves customer orders.',
          'type: service',
          'aspects:',
          '  - extra-rule',
          'mapping:',
          '  - src/services/orders.ts',
          '',
        ].join('\n'),
        'utf-8',
      );
      const first = run(['approve', '--node', 'services/orders'], dir);
      expect(first.status).toBe(0);
      // The baseline records a verdict for the attached aspect.
      expect(verdictKeys(dir, 'services/orders')).toContain('extra-rule');

      // Detach extra-rule from the node (back to the committed node shape) and
      // delete the now-orphaned aspect so `yg check` stays clean.
      writeFileSync(
        nodeYaml(dir, 'services/orders'),
        [
          'name: OrdersService',
          'description: Creates and retrieves customer orders.',
          'type: service',
          'mapping:',
          '  - src/services/orders.ts',
          '',
        ].join('\n'),
        'utf-8',
      );
      rmSync(aspectDir(dir, 'extra-rule'), { recursive: true, force: true });

      const second = run(['approve', '--node', 'services/orders'], dir);
      expect(second.status).toBe(0);
      // The removed aspect's verdict is GONE — no stale entry lingers.
      expect(verdictKeys(dir, 'services/orders')).not.toContain('extra-rule');
      // The node's remaining (type-default) aspects keep their verdicts.
      expect(verdictKeys(dir, 'services/orders')).toContain('no-todo-comments');
      // No drift remains FOR THIS NODE after the cleanup re-approve. (The fixture's
      // other node services/payments is intentionally left unapproved, so a global
      // `yg check` exit 0 is not expected — scope the assertion to services/orders.)
      const check = run(['check'], dir);
      const ordersDrift = check.stdout
        .split('\n')
        .filter((l) => l.includes('services/orders') && (l.includes('drift') || l.includes('unapproved')));
      expect(ordersDrift.length).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
