import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// E2E for `yg relations --suggest` — a READ-ONLY triage command. We build a
// self-contained project (programmatically, no shared fixture) with an
// undeclared cross-node TypeScript edge (node a imports node b's file, with NO
// declared relation a → b), run the REAL built binary, and assert:
//   - exit 0 (read-only: it never blocks, never writes),
//   - the per-node suggestion lists the undeclared edge + the exact relations:
//     stanza to add (allowed type computed from the architecture allow-list),
//   - the lock is UNCHANGED across the run (no relation_verdicts written).
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const distExists = existsSync(BIN_PATH);

function run(args: string[], cwd: string) {
  const result = spawnSync('node', [BIN_PATH, ...args], { cwd, encoding: 'utf-8' });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  return { stdout, stderr, status: result.status, all: stdout + stderr };
}

function writeNode(root: string, nodeRel: string, name: string, body: string): void {
  const dir = path.join(root, '.yggdrasil', 'model', nodeRel);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'yg-node.yaml'), body, 'utf-8');
}

/** Build a minimal valid project with an UNDECLARED cross-node TS edge a → b. */
function makeProject(label: string): string {
  const root = mkdtempSync(path.join(tmpdir(), `yg-rel-suggest-${label}-`));

  mkdirSync(path.join(root, '.yggdrasil', 'schemas'), { recursive: true });
  writeFileSync(path.join(root, '.yggdrasil', 'schemas', 'yg-node.yaml'), 'type: node\n');
  writeFileSync(path.join(root, '.yggdrasil', 'schemas', 'yg-aspect.yaml'), 'type: aspect\n');
  writeFileSync(path.join(root, '.yggdrasil', 'schemas', 'yg-flow.yaml'), 'type: flow\n');

  // `service uses service` is allowed → the suggestion for the a → b edge is
  // an allowed-type stanza (not a dead-end).
  writeFileSync(
    path.join(root, '.yggdrasil', 'yg-architecture.yaml'),
    `node_types:\n  service:\n    description: 'unit'\n    log_required: false\n    when:\n      path: "**"\n    relations:\n      uses: [service]\n`,
    'utf-8',
  );
  writeFileSync(
    path.join(root, '.yggdrasil', 'yg-config.yaml'),
    'reviewer:\n  tiers:\n    standard:\n      provider: ollama\n      consensus: 1\n      config:\n        model: llama3\n        temperature: 0\n',
    'utf-8',
  );

  // Node a imports node b's file but declares NO relation → undeclared edge.
  writeNode(root, 'a', 'A', 'name: A\ntype: service\nmapping:\n  - src/a\n');
  writeNode(root, 'b', 'B', 'name: B\ntype: service\nmapping:\n  - src/b\n');

  mkdirSync(path.join(root, 'src', 'a'), { recursive: true });
  mkdirSync(path.join(root, 'src', 'b'), { recursive: true });
  writeFileSync(
    path.join(root, 'src', 'a', 'foo.ts'),
    "import { bar } from '../b/bar';\nexport const foo = bar;\n",
    'utf-8',
  );
  writeFileSync(path.join(root, 'src', 'b', 'bar.ts'), 'export const bar = 2;\n', 'utf-8');

  return root;
}

const lockPath = (root: string) => path.join(root, '.yggdrasil', 'yg-lock.json');

describe.skipIf(!distExists)('CLI E2E — yg relations --suggest (read-only triage)', () => {
  it('lists the undeclared edge + relations: stanza per node, exits 0, and leaves the lock unchanged', () => {
    const root = makeProject('basic');
    try {
      const beforeExists = existsSync(lockPath(root));
      const before = beforeExists ? readFileSync(lockPath(root), 'utf-8') : null;

      const { status, stdout } = run(['relations', '--suggest'], root);

      // Read-only: never blocks.
      expect(status).toBe(0);
      // Names the offending node and the undeclared target.
      expect(stdout).toContain('a: undeclared cross-node dependencies detected');
      expect(stdout).toContain('src/a/foo.ts:1 → b');
      // Computes the allowed relation types. `uses` is explicitly allowed
      // (service uses service); the other five relation types are absent from
      // the architecture table → unconstrained → also allowed. The stanza uses
      // the first canonical type (`uses`).
      expect(stdout).toContain(
        'allowed relation type(s) [uses, calls, extends, implements, emits, listens]',
      );
      expect(stdout).toContain('relations:');
      expect(stdout).toContain('- target: b');
      expect(stdout).toContain('type: uses');

      // Lock unchanged: either still absent, or byte-identical to before. In
      // particular no relation_verdicts were persisted by the read-only command.
      const afterExists = existsSync(lockPath(root));
      const after = afterExists ? readFileSync(lockPath(root), 'utf-8') : null;
      expect(afterExists).toBe(beforeExists);
      expect(after).toBe(before);
      if (after !== null) expect(after).not.toContain('relation_verdicts');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports a clean result and writes nothing when every cross-node edge is declared', () => {
    const root = makeProject('clean');
    try {
      // Declare a --uses--> b so the edge is sanctioned.
      writeNode(
        root,
        'a',
        'A',
        'name: A\ntype: service\nrelations:\n  - target: b\n    type: uses\nmapping:\n  - src/a\n',
      );

      const before = existsSync(lockPath(root)) ? readFileSync(lockPath(root), 'utf-8') : null;
      const { status, stdout } = run(['relations', '--suggest'], root);

      expect(status).toBe(0);
      expect(stdout).toContain('No undeclared cross-node dependencies detected');

      const after = existsSync(lockPath(root)) ? readFileSync(lockPath(root), 'utf-8') : null;
      expect(after).toBe(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
