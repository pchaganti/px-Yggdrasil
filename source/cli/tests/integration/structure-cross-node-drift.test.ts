import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(__dirname, '..', '..', 'dist', 'bin.js');
const SCHEMAS_SRC = path.join(__dirname, '..', 'fixtures', 'sample-project', '.yggdrasil', 'schemas');
const distExists = existsSync(BIN);

const YG_CONFIG = `version: "5.0.0"
quality:
  max_direct_relations: 10
reviewer:
  default: standard
  tiers:
    standard:
      provider: ollama
      consensus: 1
      config: { model: m, endpoint: http://x }
`;

// 'service' type has NO relations: map, so 'uses' is an unconstrained relation
// type — the validator skips architecture-relation enforcement for it. This lets
// node N declare a `uses` relation to node B without an explicit allow-list.
const YG_ARCH = `node_types:
  service:
    description: Discrete service unit
    log_required: false
    when:
      path: "**"
`;

function run(
  args: string[],
  cwd: string,
): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync('node', [BIN, ...args], {
    cwd,
    encoding: 'utf-8',
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status,
  };
}

/**
 * Lay out a repo with two nodes:
 *   - B: owns src/b.ts (no aspects).
 *   - N: owns src/a.ts, declares `uses -> B`, carries an ENFORCED structure
 *     aspect `reads-b` that reaches B cross-node via ctx.graph.node('B') and
 *     reads B's mapped file. The cross-node read records src/b.ts in N's
 *     structureTouchedFiles baseline — so editing src/b.ts must drift N.
 */
function layout(root: string): void {
  const ygg = path.join(root, '.yggdrasil');
  mkdirSync(path.join(ygg, 'schemas'), { recursive: true });
  mkdirSync(path.join(ygg, 'aspects', 'reads-b'), { recursive: true });
  mkdirSync(path.join(ygg, 'model', 'N'), { recursive: true });
  mkdirSync(path.join(ygg, 'model', 'B'), { recursive: true });
  mkdirSync(path.join(root, 'src'), { recursive: true });

  for (const schema of ['yg-node.yaml', 'yg-aspect.yaml', 'yg-flow.yaml']) {
    copyFileSync(path.join(SCHEMAS_SRC, schema), path.join(ygg, 'schemas', schema));
  }

  writeFileSync(path.join(root, 'src', 'a.ts'), 'export const a = 1;\n');
  writeFileSync(path.join(root, 'src', 'b.ts'), 'export const b = 1;\n');
  writeFileSync(path.join(ygg, 'yg-architecture.yaml'), YG_ARCH);
  writeFileSync(path.join(ygg, 'yg-config.yaml'), YG_CONFIG);

  writeFileSync(
    path.join(ygg, 'model', 'B', 'yg-node.yaml'),
    `name: B\ntype: service\ndescription: file owner\nmapping:\n  - src/b.ts\n`,
  );
  writeFileSync(
    path.join(ygg, 'model', 'N', 'yg-node.yaml'),
    `name: N\ntype: service\ndescription: dependent node\nmapping:\n  - src/a.ts\nrelations:\n  - target: B\n    type: uses\naspects:\n  - reads-b\n`,
  );
  writeFileSync(
    path.join(ygg, 'aspects', 'reads-b', 'yg-aspect.yaml'),
    `name: ReadsB\ndescription: reads node B's file cross-node\nreviewer:\n  type: deterministic\nstatus: enforced\n`,
  );
  // Reaching B via ctx.graph.node('B') reads B's mapped files (src/b.ts) and
  // records them as touched — this is the cross-node read under test.
  writeFileSync(
    path.join(ygg, 'aspects', 'reads-b', 'check.mjs'),
    `export function check(ctx) {\n  const b = ctx.graph.node('B');\n  if (b) { void b.files; }\n  return [];\n}\n`,
  );
}

function readBaseline(root: string, nodePath: string): Record<string, unknown> {
  const stateDir = path.join(root, '.yggdrasil', '.drift-state');
  const segments = nodePath.split('/');
  const jsonPath = path.join(stateDir, ...segments.slice(0, -1), segments[segments.length - 1] + '.json');
  return JSON.parse(readFileSync(jsonPath, 'utf-8')) as Record<string, unknown>;
}

describe.skipIf(!distExists)('structure aspect cross-node drift + impact', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'yg-xnode-'));
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('editing a cross-node file read by a structure aspect drifts the dependent node', () => {
    layout(root);

    // Approve both nodes (full repo).
    const approveB = run(['approve', '--node', 'B'], root);
    expect(approveB.status).toBe(0);
    const approveN = run(['approve', '--node', 'N'], root);
    expect(approveN.status).toBe(0);

    // N's baseline must record src/b.ts under structureTouchedFiles[reads-b] —
    // proof the cross-node read participates in N's drift identity.
    const baselineN = readBaseline(root, 'N');
    const stf = baselineN.structureTouchedFiles as Record<string, Record<string, string>> | undefined;
    expect(stf).toBeDefined();
    expect(stf!['reads-b']).toBeDefined();
    expect(Object.keys(stf!['reads-b'])).toContain('src/b.ts');
    // src/b.ts must NOT appear in N's own files map (it is cross-node, owned by B).
    const nFiles = baselineN.files as Record<string, string>;
    expect(nFiles['src/b.ts']).toBeUndefined();

    // Clean check after approving both.
    const checkClean = run(['check'], root);
    expect(checkClean.status).toBe(0);

    // Edit B's file — N reads it cross-node, so N must now drift.
    writeFileSync(path.join(root, 'src', 'b.ts'), 'export const b = 2;\n');

    const checkDrift = run(['check'], root);
    // Before this fix, collectTrackedFiles was called without the baseline at the
    // drift sites, so the structure-touched layer was never emitted and editing a
    // cross-node-read file did NOT drift N — check would exit 0 here.
    expect(checkDrift.status).toBe(1);
    expect(checkDrift.stdout).toContain('N');
    // The changed cross-node file must NOT be misreported as a deleted file.
    expect(checkDrift.stdout).not.toMatch(/src\/b\.ts.*\(deleted\)/);

    // Re-approve N → clears the drift.
    const reApproveN = run(['approve', '--node', 'N'], root);
    expect(reApproveN.status).toBe(0);

    const checkAfter = run(['check'], root);
    expect(checkAfter.status).toBe(0);
  });

  it('yg impact --file on a cross-node-read file names the dependent node', () => {
    layout(root);

    // Approve both so N's structureTouchedFiles baseline records src/b.ts (precise mode).
    expect(run(['approve', '--node', 'B'], root).status).toBe(0);
    expect(run(['approve', '--node', 'N'], root).status).toBe(0);

    const impact = run(['impact', '--file', 'src/b.ts'], root);
    // src/b.ts is owned by B AND read cross-node by N's structure aspect.
    // The structure-cascade section must name N — not report "Blast radius: 0".
    expect(impact.stdout).toContain('N');
    expect(impact.stdout).toMatch(/structure aspects: 1 node/);
    expect(impact.stdout).not.toMatch(/Blast radius:\s*0\b/);
  });
});
