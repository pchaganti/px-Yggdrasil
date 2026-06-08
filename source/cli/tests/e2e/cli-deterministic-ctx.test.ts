import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  rmSync,
  cpSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// E2E suite — the GRAPH-AWARE deterministic check.mjs surface.
//
// Proves, end-to-end against the real built binary, the four pillars of the
// graph-aware deterministic reviewer that have zero E2E coverage today:
//   * ctx.graph (node lookup, children) — cross-node topology rules
//   * ctx.fs (exists/list/read) — file-system shape rules
//   * ctx.parseAst — syntax-tree inspection inside a graph-aware check
//   * the allowed-reads boundary — UndeclaredGraphReadError /
//     structure-aspect-undeclared-graph-read when a check reaches outside it
// plus the `yg deterministic-test` command surface: --node (graph-scoped),
// --files (ad-hoc), and --check-determinism.
//
// Every aspect / check.mjs used here is AUTHORED INTO A FRESH mkdtemp COPY of
// the committed e2e-lifecycle fixture. The committed fixture is never mutated;
// zero committed bytes change. Each test rmSync's its temp dir in finally.
// Fully hermetic: no network host/port, no random source, no wall-clock reads
// inside assertions. The fixture's LLM aspect is stripped so every outcome is
// driven purely by deterministic check.mjs runs (no LLM, no reviewer endpoint).
// ---------------------------------------------------------------------------

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
  const dir = mkdtempSync(path.join(tmpdir(), `yg-detctx-${label}-`));
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

/**
 * Copy the fixture and strip the LLM aspect (`has-doc-comment`) so the node's
 * effective aspects are purely deterministic. This makes the lifecycle hermetic:
 * no network, no LLM verdict, fully reproducible — only deterministic check.mjs
 * runs drive every refuse/pass outcome.
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

/**
 * Author a deterministic aspect into the temp graph: writes the aspect dir,
 * yg-aspect.yaml, and check.mjs. All bytes land in the temp copy only.
 */
function writeAspect(dir: string, id: string, description: string, checkSource: string): void {
  const aspectDir = path.join(dir, '.yggdrasil', 'aspects', id);
  mkdirSync(aspectDir, { recursive: true });
  writeFileSync(
    path.join(aspectDir, 'yg-aspect.yaml'),
    [
      `name: ${id}`,
      `description: ${description}`,
      'reviewer:',
      '  type: deterministic',
      'status: enforced',
      '',
    ].join('\n'),
    'utf-8',
  );
  writeFileSync(path.join(aspectDir, 'check.mjs'), checkSource, 'utf-8');
}

/** Append an aspect id to a node's own `aspects:` list (creating the list). */
function attachAspectToNode(dir: string, nodePath: string, aspectId: string): void {
  const nodeYaml = path.join(dir, '.yggdrasil', 'model', ...nodePath.split('/'), 'yg-node.yaml');
  const content = readFileSync(nodeYaml, 'utf-8');
  if (/^aspects:/m.test(content)) {
    // Insert after the existing aspects: line's last list entry. Simplest robust
    // approach: append a new entry right after the `aspects:` line.
    const out = content.replace(/^aspects:\n/m, `aspects:\n  - ${aspectId}\n`);
    writeFileSync(nodeYaml, out, 'utf-8');
  } else {
    writeFileSync(nodeYaml, content.trimEnd() + `\naspects:\n  - ${aspectId}\n`, 'utf-8');
  }
}

const ordersFile = (dir: string) => path.join(dir, 'src', 'services', 'orders.ts');

const baselinePath = (dir: string, node: string) =>
  path.join(dir, '.yggdrasil', '.drift-state', ...node.split('/')) + '.json';

// ---------------------------------------------------------------------------
// Reusable check.mjs sources (authored into the temp copy at run time).
// ---------------------------------------------------------------------------

// Graph topology rule: every child of a node must be of type `service`.
// Attached to the `services` (module) parent — uses ctx.graph.children.
const CHILD_TYPE_CHECK = `export function check(ctx) {
  const violations = [];
  for (const child of ctx.graph.children(ctx.node)) {
    if (child.type !== 'service') {
      violations.push({
        message: \`Child '\${child.id}' has type '\${child.type}', expected 'service'.\`,
      });
    }
  }
  return violations;
}
`;

// Graph + file rule: the node's own source file (read back through
// ctx.graph.node(ctx.node.id), always inside the allowed set) must export a
// create* function. Attached to a node WITH files so `yg approve` evaluates it.
const GRAPH_NAME_MATCH_CHECK = `export function check(ctx) {
  const violations = [];
  const self = ctx.graph.node(ctx.node.id);
  if (!self) return violations;
  for (const file of self.files) {
    if (!/export\\s+function\\s+create/.test(file.content)) {
      violations.push({
        file: file.path,
        line: 1,
        column: 0,
        message: \`Service must export a create* function (node '\${self.id}').\`,
      });
    }
  }
  return violations;
}
`;

// Allowed-reads boundary violation: reach a SIBLING node id that is NOT in the
// allowed set (no relation, not ancestor/descendant). ctx.graph.node throws
// UndeclaredGraphReadError -> structure-aspect-undeclared-graph-read.
const CROSS_GRAPH_READ_CHECK = `export function check(ctx) {
  // 'services/payments' is a sibling of 'services/orders' — outside the allowed
  // reads boundary. This throws and the runner surfaces a boundary violation.
  const other = ctx.graph.node('services/payments');
  return other ? [] : [];
}
`;

// ctx.parseAst rule: parse the node's own files and count export_statement
// nodes via the re-exported tree-sitter `walk` helper. Flags a file with none.
const AST_EXPORTS_CHECK = `import { walk } from '@chrisdudek/yg/structure';
export function check(ctx) {
  const violations = [];
  for (const file of ctx.files) {
    const tree = ctx.parseAst(file, 'typescript');
    let exportCount = 0;
    walk(tree.rootNode, (n) => {
      if (n.type === 'export_statement') exportCount++;
    });
    if (exportCount === 0) {
      violations.push({
        file: file.path,
        line: 1,
        column: 0,
        message: \`No exported declarations found (ctx.parseAst saw \${exportCount} export_statement nodes).\`,
      });
    }
  }
  return violations;
}
`;

// Intentionally NON-deterministic: a module-level call counter. The aspect is
// imported once per process and the two runOnce() calls of --check-determinism
// share module state, so call 1 returns a violation and call 2 returns none.
// No random/clock source — a pure (but stateful) counter.
const FLAKY_CHECK = `let calls = 0;
export function check(ctx) {
  calls++;
  if (calls === 1) {
    const f = ctx.files[0];
    return [{
      file: f ? f.path : undefined,
      line: 1,
      column: 0,
      message: 'First-run-only violation (call counter).',
    }];
  }
  return [];
}
`;

// Finding G: ctx.graph.node(id).files must expose a glob-mapped node's files.
// Reads the node's OWN files two ways — via ctx.files (glob-expanded) and via
// ctx.graph.node(ctx.node.id).files — and flags a mismatch. A glob mapping that
// ctx.graph fails to expand makes the second count 0 while the first is N.
const GLOB_GRAPH_FILES_CHECK = `export function check(ctx) {
  const self = ctx.graph.node(ctx.node.id);
  const viaGraph = self ? self.files.length : 0;
  const viaOwn = ctx.files.length;
  if (viaGraph !== viaOwn) {
    return [{
      file: ctx.files[0] ? ctx.files[0].path : ctx.node.id,
      line: 1,
      column: 0,
      message: \`ctx.graph exposed \${viaGraph} files but the node owns \${viaOwn} (glob mapping not expanded in ctx.graph).\`,
    }];
  }
  return [];
}
`;

describe.skipIf(!distExists)('CLI E2E — graph-aware deterministic ctx surface + deterministic-test', () => {
  // -------------------------------------------------------------------------
  // Scenario 1: GRAPH-AWARE check passes/refuses through yg approve.
  // -------------------------------------------------------------------------

  it('S1a: a graph-aware (ctx.graph + ctx.files) rule that HOLDS passes deterministic-test and approve', () => {
    const dir = deterministicFixture('s1a');
    try {
      writeAspect(dir, 'graph-name-match', 'Service file must export a create* function (read via ctx.graph).', GRAPH_NAME_MATCH_CHECK);
      attachAspectToNode(dir, 'services/orders', 'graph-name-match');

      // deterministic-test --node confirms the rule holds with the real ctx.
      const test = run(['deterministic-test', '--aspect', 'graph-name-match', '--node', 'services/orders'], dir);
      expect(test.status).toBe(0);
      expect(test.all).toContain('No violations.');

      // approve evaluates the same graph-aware aspect and records a baseline.
      run(['log', 'add', '--node', 'services/orders', '--reason', 'attach graph-aware export rule'], dir);
      const approve = run(['approve', '--node', 'services/orders'], dir);
      expect(approve.status).toBe(0);
      expect(approve.all).toContain('Approved: services/orders');
      expect(existsSync(baselinePath(dir, 'services/orders'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('S1b: breaking the graph-aware rule makes approve REFUSE (exit 1) naming the aspect', () => {
    const dir = deterministicFixture('s1b');
    try {
      writeAspect(dir, 'graph-name-match', 'Service file must export a create* function (read via ctx.graph).', GRAPH_NAME_MATCH_CHECK);
      attachAspectToNode(dir, 'services/orders', 'graph-name-match');

      // Rename the only create* export so the rule no longer holds.
      const broken = readFileSync(ordersFile(dir), 'utf-8').replace(
        'export function createOrder',
        'export function buildOrder',
      );
      writeFileSync(ordersFile(dir), broken, 'utf-8');

      run(['log', 'add', '--node', 'services/orders', '--reason', 'rename create export to exercise refusal'], dir);
      const approve = run(['approve', '--node', 'services/orders'], dir);
      expect(approve.status).toBe(1);
      expect(approve.all).toContain('graph-name-match');
      expect(approve.all).toContain('NOT SATISFIED');
      // The violation message produced by the graph-aware check surfaces.
      expect(approve.all).toContain("Service must export a create* function (node 'services/orders').");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('S1c: a ctx.graph.children topology rule HOLDS, and a wrongly-typed child breaks it', () => {
    const dir = deterministicFixture('s1c');
    try {
      writeAspect(dir, 'child-type', 'Every child of the services module must be of type service.', CHILD_TYPE_CHECK);
      attachAspectToNode(dir, 'services', 'child-type');

      // HOLDS: all children of `services` (orders, payments) are type `service`.
      const ok = run(['deterministic-test', '--aspect', 'child-type', '--node', 'services'], dir);
      expect(ok.status).toBe(0);
      expect(ok.all).toContain('No violations.');

      // BREAK: add a child node of a different type (module, parent-only).
      const subDir = path.join(dir, '.yggdrasil', 'model', 'services', 'sub');
      mkdirSync(subDir, { recursive: true });
      writeFileSync(
        path.join(subDir, 'yg-node.yaml'),
        ['name: SubModule', 'description: A wrongly-typed child for testing.', 'type: module', ''].join('\n'),
        'utf-8',
      );

      const broken = run(['deterministic-test', '--aspect', 'child-type', '--node', 'services'], dir);
      expect(broken.status).toBe(1);
      // Graph-level violation (no file) renders under the <graph> bucket.
      expect(broken.all).toContain('<graph>');
      expect(broken.all).toContain("Child 'services/sub' has type 'module', expected 'service'.");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // Scenario 2: ALLOWED-READS boundary — reaching a node outside the boundary.
  // -------------------------------------------------------------------------

  it('S2: ctx.graph.node on an out-of-boundary sibling surfaces structure-aspect-undeclared-graph-read', () => {
    const dir = deterministicFixture('s2');
    try {
      writeAspect(dir, 'cross-read', 'Reads a sibling node outside the allowed boundary on purpose.', CROSS_GRAPH_READ_CHECK);
      attachAspectToNode(dir, 'services/orders', 'cross-read');

      // services/payments is a SIBLING of services/orders — not ancestor,
      // descendant, or relation target — so it is outside the allowed reads set.
      const test = run(['deterministic-test', '--aspect', 'cross-read', '--node', 'services/orders'], dir);
      expect(test.status).toBe(1);
      // The runner converts UndeclaredGraphReadError into an actionable violation.
      expect(test.all).toContain("Aspect tried to read undeclared graph node 'services/payments'");
      expect(test.all).toContain('Add a relation in yg-node.yaml');

      // The same boundary error blocks approve (exit 1) and names the aspect.
      run(['log', 'add', '--node', 'services/orders', '--reason', 'attach boundary-violating check'], dir);
      const approve = run(['approve', '--node', 'services/orders'], dir);
      expect(approve.status).toBe(1);
      expect(approve.all).toContain('cross-read');
      expect(approve.all).toContain('NOT SATISFIED');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // Scenario 3: ctx.parseAst inspects the node's own files.
  // -------------------------------------------------------------------------

  it('S3a: a ctx.parseAst rule PASSES on conforming code (exports present)', () => {
    const dir = deterministicFixture('s3a');
    try {
      writeAspect(dir, 'ast-exports', 'Service file must contain at least one exported declaration (via ctx.parseAst).', AST_EXPORTS_CHECK);
      attachAspectToNode(dir, 'services/orders', 'ast-exports');

      const test = run(['deterministic-test', '--aspect', 'ast-exports', '--node', 'services/orders'], dir);
      expect(test.status).toBe(0);
      expect(test.all).toContain('No violations.');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('S3b: the same ctx.parseAst rule FLAGS violating code (no exports), exit 1', () => {
    const dir = deterministicFixture('s3b');
    try {
      writeAspect(dir, 'ast-exports', 'Service file must contain at least one exported declaration (via ctx.parseAst).', AST_EXPORTS_CHECK);
      attachAspectToNode(dir, 'services/orders', 'ast-exports');

      // Strip every `export ` keyword so the parsed tree has no export_statement.
      const stripped = readFileSync(ordersFile(dir), 'utf-8').replace(/^export /gm, '');
      writeFileSync(ordersFile(dir), stripped, 'utf-8');

      const test = run(['deterministic-test', '--aspect', 'ast-exports', '--node', 'services/orders'], dir);
      expect(test.status).toBe(1);
      expect(test.all).toContain('No exported declarations found');
      // Confirms parseAst actually walked the tree and found zero exports.
      expect(test.all).toContain('0 export_statement nodes');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // Scenario 4: yg deterministic-test --check-determinism.
  // -------------------------------------------------------------------------

  it('S4a: --check-determinism passes for a STABLE graph-aware check (exit 0)', () => {
    const dir = deterministicFixture('s4a');
    try {
      writeAspect(dir, 'graph-name-match', 'Service file must export a create* function (read via ctx.graph).', GRAPH_NAME_MATCH_CHECK);
      attachAspectToNode(dir, 'services/orders', 'graph-name-match');

      const test = run(
        ['deterministic-test', '--aspect', 'graph-name-match', '--node', 'services/orders', '--check-determinism'],
        dir,
      );
      expect(test.status).toBe(0);
      expect(test.all).toContain('No violations.');
      // A stable check must NOT trigger the non-determinism dump.
      expect(test.all).not.toContain('non-deterministic');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('S4b: --check-determinism FAILS (exit 1) for a check that differs across runs, with a Run 1 / Run 2 dump', () => {
    const dir = deterministicFixture('s4b');
    try {
      // Module-level call counter — NOT a random or clock source. The two
      // consecutive runOnce() calls in --check-determinism share module state.
      writeAspect(dir, 'flaky', 'Intentionally non-deterministic via a module-level call counter.', FLAKY_CHECK);
      attachAspectToNode(dir, 'services/orders', 'flaky');

      const test = run(
        ['deterministic-test', '--aspect', 'flaky', '--node', 'services/orders', '--check-determinism'],
        dir,
      );
      expect(test.status).toBe(1);
      expect(test.all).toContain("Deterministic aspect 'flaky' produced non-deterministic results");
      // The diagnostic dumps both runs' violation sets.
      expect(test.all).toContain('Run 1:');
      expect(test.all).toContain('Run 2:');
      expect(test.all).toContain('First-run-only violation (call counter).');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // Scenario 5: --node (graph-scoped) vs --files (ad-hoc) on a graph-aware aspect.
  //
  // --node runs the graph-aware structure runner: ctx.graph / ctx.fs /
  // ctx.parseAst are all present. --files runs the single-file AST runner:
  // ctx exposes only ctx.files — no graph-aware surfaces. A graph-aware check
  // therefore THROWS in --files mode (TypeError: ctx.graph/ctx.parseAst
  // undefined). This is the documented mode distinction, asserted here.
  // -------------------------------------------------------------------------

  it('S5a: --node runs the graph-aware ctx (ctx.graph works); the same aspect in --files mode throws (no graph ctx)', () => {
    const dir = deterministicFixture('s5a');
    try {
      writeAspect(dir, 'graph-name-match', 'Service file must export a create* function (read via ctx.graph).', GRAPH_NAME_MATCH_CHECK);
      attachAspectToNode(dir, 'services/orders', 'graph-name-match');

      // --node: graph-aware ctx is available, rule holds.
      const node = run(['deterministic-test', '--aspect', 'graph-name-match', '--node', 'services/orders'], dir);
      expect(node.status).toBe(0);
      expect(node.all).toContain('No violations.');

      // --files: ad-hoc single-file runner — ctx.graph is undefined, so the
      // graph-aware check throws. exit 1, error names the aspect.
      const files = run(['deterministic-test', '--aspect', 'graph-name-match', '--files', 'src/services/orders.ts'], dir);
      expect(files.status).toBe(1);
      expect(files.all).toContain("check.mjs threw an exception while running (aspect 'graph-name-match')");
      // ctx.graph is absent in --files mode — the thrown error reflects that.
      expect(files.all).toContain("Cannot read properties of undefined (reading 'node')");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('S5b: --files runs a single-file (ctx.files-only) check ad-hoc with no graph attachment', () => {
    const dir = deterministicFixture('s5b');
    try {
      // The fixture ships `no-todo-comments` — a pure ctx.files check. In --files
      // mode it runs ad-hoc with no node/graph: a clean file passes, a TODO flags.
      const clean = run(['deterministic-test', '--aspect', 'no-todo-comments', '--files', 'src/services/orders.ts'], dir);
      expect(clean.status).toBe(0);
      expect(clean.all).toContain('No violations.');

      const withTodo = readFileSync(ordersFile(dir), 'utf-8') + '\n// TODO: ad-hoc check should flag this\n';
      writeFileSync(ordersFile(dir), withTodo, 'utf-8');
      const flagged = run(['deterministic-test', '--aspect', 'no-todo-comments', '--files', 'src/services/orders.ts'], dir);
      expect(flagged.status).toBe(1);
      expect(flagged.all).toContain('TODO comment found');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // Mode guards (cheap, hermetic) — exactly-one-mode contract.
  // -------------------------------------------------------------------------

  it('S5c: deterministic-test rejects both --node and --files together (exit 1)', () => {
    const dir = deterministicFixture('s5c');
    try {
      const test = run(
        ['deterministic-test', '--aspect', 'no-todo-comments', '--node', 'services/orders', '--files', 'src/services/orders.ts'],
        dir,
      );
      expect(test.status).toBe(1);
      expect(test.all).toContain('Both --node and --files were provided');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('S5d: deterministic-test rejects neither --node nor --files (exit 1)', () => {
    const dir = deterministicFixture('s5d');
    try {
      const test = run(['deterministic-test', '--aspect', 'no-todo-comments'], dir);
      expect(test.status).toBe(1);
      expect(test.all).toContain('Neither --node nor --files was provided');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // Finding G: a glob-mapped node's files must be visible through ctx.graph.
  // -------------------------------------------------------------------------

  it('G: ctx.graph exposes a glob-mapped node\'s files (matches ctx.files)', () => {
    const dir = deterministicFixture('glob-graph');
    try {
      // orders owns its source file via a GLOB instead of the exact path.
      const ordersYaml = path.join(dir, '.yggdrasil', 'model', 'services', 'orders', 'yg-node.yaml');
      const y = readFileSync(ordersYaml, 'utf-8').replace('src/services/orders.ts', 'src/services/order*.ts');
      writeFileSync(ordersYaml, y, 'utf-8');

      writeAspect(dir, 'glob-graph-files', 'ctx.graph must expose the same files a node owns.', GLOB_GRAPH_FILES_CHECK);
      attachAspectToNode(dir, 'services/orders', 'glob-graph-files');

      const test = run(['deterministic-test', '--aspect', 'glob-graph-files', '--node', 'services/orders'], dir);
      // Post-fix: ctx.graph expands the glob, so it sees the same file ctx.files does.
      expect(test.all).toContain('No violations');
      expect(test.all).not.toContain('glob mapping not expanded');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
