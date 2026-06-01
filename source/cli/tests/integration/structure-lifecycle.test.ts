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

const YG_ARCH = `node_types:
  module:
    description: Logical grouping
    log_required: false
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

function layout(root: string): void {
  const ygg = path.join(root, '.yggdrasil');
  mkdirSync(path.join(ygg, 'schemas'), { recursive: true });
  mkdirSync(path.join(ygg, 'aspects', 'touches-a'), { recursive: true });
  mkdirSync(path.join(ygg, 'model', 'N'), { recursive: true });
  mkdirSync(path.join(root, 'src'), { recursive: true });

  // Copy required schema files from sample fixture
  for (const schema of ['yg-node.yaml', 'yg-aspect.yaml', 'yg-flow.yaml']) {
    copyFileSync(path.join(SCHEMAS_SRC, schema), path.join(ygg, 'schemas', schema));
  }

  writeFileSync(path.join(root, 'src', 'a.ts'), 'export const x = 1;\n');
  writeFileSync(path.join(ygg, 'yg-architecture.yaml'), YG_ARCH);
  writeFileSync(path.join(ygg, 'yg-config.yaml'), YG_CONFIG);
  writeFileSync(
    path.join(ygg, 'model', 'N', 'yg-node.yaml'),
    `name: N\ntype: service\ndescription: test node\nmapping:\n  - src/a.ts\naspects:\n  - touches-a\n`,
  );
  writeFileSync(
    path.join(ygg, 'aspects', 'touches-a', 'yg-aspect.yaml'),
    `name: TouchesA\ndescription: reads src/a.ts\nreviewer:\n  type: deterministic\nstatus: enforced\n`,
  );
  writeFileSync(
    path.join(ygg, 'aspects', 'touches-a', 'check.mjs'),
    `export function check(ctx) { ctx.fs.read('src/a.ts'); return []; }\n`,
  );
}

function readBaseline(root: string, nodePath: string): Record<string, unknown> {
  const stateDir = path.join(root, '.yggdrasil', '.drift-state');
  // Drift state is stored as nested path like cli/commands/N -> cli/commands/N.json
  // or at the root level as N.json
  const segments = nodePath.split('/');
  const jsonPath = path.join(stateDir, ...segments.slice(0, -1), segments[segments.length - 1] + '.json');
  return JSON.parse(readFileSync(jsonPath, 'utf-8')) as Record<string, unknown>;
}

describe.skipIf(!distExists)('structure aspect lifecycle', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'yg-structure-lifecycle-'));
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('create → approve → edit → drift → re-approve → no drift', () => {
    // 1. Lay out a minimal repo
    layout(root);

    // 2. yg approve --node N
    const approveResult = run(['approve', '--node', 'N'], root);
    expect(approveResult.status).toBe(0);

    // 3. Read baseline, assert identity.aspects[touches-a].checkTouched populated
    const baseline = readBaseline(root, 'N');
    const aspects = (baseline.identity as { aspects: Record<string, { checkTouched?: Record<string, string> }> }).aspects;
    const ct = aspects['touches-a']?.checkTouched;
    expect(ct).toBeDefined();
    expect(Object.keys(ct!)).toContain('src/a.ts');

    // 4. Modify src/a.ts to trigger drift
    writeFileSync(path.join(root, 'src', 'a.ts'), 'export const x = 2;\n');

    // 5. yg check → expect exit code 1 (drift detected)
    const checkDrift = run(['check'], root);
    expect(checkDrift.status).toBe(1);
    // Output should contain drift-related language
    expect(checkDrift.stdout.toLowerCase()).toMatch(/drift|approve/);

    // 6. yg approve --node N (re-approve after edit)
    const reApproveResult = run(['approve', '--node', 'N'], root);
    expect(reApproveResult.status).toBe(0);

    // 7. yg check → exit code 0 (no drift)
    const checkClean = run(['check'], root);
    expect(checkClean.status).toBe(0);
  });
});
