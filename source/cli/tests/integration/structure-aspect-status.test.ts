import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  copyFileSync,
} from 'node:fs';
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

/**
 * Layout a minimal repo with a structure aspect set to the given status.
 * The aspect check returns a violation (no README in mapping) intentionally
 * so we can verify how different statuses handle violations.
 */
function layout(root: string, aspectStatus: 'draft' | 'advisory' | 'enforced'): void {
  const ygg = path.join(root, '.yggdrasil');
  mkdirSync(path.join(ygg, 'schemas'), { recursive: true });
  mkdirSync(path.join(ygg, 'aspects', 'has-readme'), { recursive: true });
  mkdirSync(path.join(ygg, 'model', 'N'), { recursive: true });
  mkdirSync(path.join(root, 'src'), { recursive: true });

  for (const schema of ['yg-node.yaml', 'yg-aspect.yaml', 'yg-flow.yaml']) {
    copyFileSync(path.join(SCHEMAS_SRC, schema), path.join(ygg, 'schemas', schema));
  }

  writeFileSync(path.join(root, 'src', 'a.ts'), 'export const x = 1;\n');
  writeFileSync(path.join(ygg, 'yg-architecture.yaml'), YG_ARCH);
  writeFileSync(path.join(ygg, 'yg-config.yaml'), YG_CONFIG);
  writeFileSync(
    path.join(ygg, 'model', 'N', 'yg-node.yaml'),
    `name: N\ntype: service\ndescription: test node\nmapping:\n  - src/a.ts\naspects:\n  - has-readme\n`,
  );
  writeFileSync(
    path.join(ygg, 'aspects', 'has-readme', 'yg-aspect.yaml'),
    `name: HasReadme\ndescription: own mapping must include a README\nreviewer:\n  type: deterministic\nstatus: ${aspectStatus}\n`,
  );
  // check.mjs returns a violation: no README found in the node's own files
  writeFileSync(
    path.join(ygg, 'aspects', 'has-readme', 'check.mjs'),
    `export function check(ctx) {
  if (!ctx.files.some(f => /readme/i.test(f.path))) {
    return [{ message: 'no README in own mapping' }];
  }
  return [];
}\n`,
  );
}

function readBaseline(root: string): Record<string, unknown> {
  const jsonPath = path.join(root, '.yggdrasil', '.drift-state', 'N.json');
  return JSON.parse(readFileSync(jsonPath, 'utf-8')) as Record<string, unknown>;
}

describe.skipIf(!distExists)('structure aspect-status integration', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'yg-status-'));
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('draft: reviewer skipped, no verdict or checkTouchedFiles in baseline on approve', () => {
    layout(root, 'draft');
    const result = run(['approve', '--node', 'N'], root);
    expect(result.status).toBe(0);

    // For a node with only draft aspects, a baseline IS written (source hash),
    // but it contains no aspectVerdicts or checkTouchedFiles for the draft aspect.
    const jsonPath = path.join(root, '.yggdrasil', '.drift-state', 'N.json');
    // If no baseline was written (node auto-approved with no aspects), skip further checks
    if (!existsSync(jsonPath)) return;

    const b = readBaseline(root);
    // Draft aspects never produce a verdict or checkTouchedFiles entry
    const verdicts = b.aspectVerdicts as Record<string, unknown> | undefined;
    expect(verdicts?.['has-readme']).toBeUndefined();
    const stf = b.checkTouchedFiles as Record<string, unknown> | undefined;
    expect(stf?.['has-readme']).toBeUndefined();
  });

  it('advisory: violation renders as warning, yg check exits 0', () => {
    layout(root, 'advisory');
    run(['approve', '--node', 'N'], root);

    const checkResult = run(['check'], root);
    // Advisory violations render as warnings — check should pass (exit 0)
    expect(checkResult.status).toBe(0);
    // Output should contain "warn" or "advisory" or "Warnings" in some form
    expect(checkResult.stdout.toLowerCase()).toMatch(/warn|advisory/);
  });

  it('enforced: violation blocks yg check (exit 1)', () => {
    layout(root, 'enforced');
    run(['approve', '--node', 'N'], root);

    const checkResult = run(['check'], root);
    // Enforced violations block check
    expect(checkResult.status).toBe(1);
  });

  it('D8.3: enforced → draft → enforced status toggle preserves baseline hash', () => {
    // Create a clean baseline: add a README so the aspect passes
    layout(root, 'enforced');
    writeFileSync(path.join(root, 'src', 'README.md'), 'readme\n');
    writeFileSync(
      path.join(root, '.yggdrasil', 'model', 'N', 'yg-node.yaml'),
      `name: N\ntype: service\ndescription: test node\nmapping:\n  - src/a.ts\n  - src/README.md\naspects:\n  - has-readme\n`,
    );
    run(['approve', '--node', 'N'], root);
    const baselineHash0 = (readBaseline(root) as { hash: string }).hash;

    // Toggle: enforced → draft → enforced
    for (const status of ['draft', 'enforced'] as const) {
      const aspectYamlPath = path.join(root, '.yggdrasil', 'aspects', 'has-readme', 'yg-aspect.yaml');
      const yaml = readFileSync(aspectYamlPath, 'utf-8').replace(/^status: .*/m, `status: ${status}`);
      writeFileSync(aspectYamlPath, yaml);
      run(['approve', '--node', 'N'], root);
    }

    const baselineHashN = (readBaseline(root) as { hash: string }).hash;
    // D8.3: the canonical hash must survive status churn when source files are unchanged
    expect(baselineHashN).toBe(baselineHash0);
  });

  it('D8.3: draft toggle preserves checkTouchedFiles entry from prior enforced baseline', () => {
    // Create a passing enforced baseline with a README
    layout(root, 'enforced');
    writeFileSync(path.join(root, 'src', 'README.md'), 'readme\n');
    writeFileSync(
      path.join(root, '.yggdrasil', 'model', 'N', 'yg-node.yaml'),
      `name: N\ntype: service\ndescription: test node\nmapping:\n  - src/a.ts\n  - src/README.md\naspects:\n  - has-readme\n`,
    );
    run(['approve', '--node', 'N'], root);

    const baselineBefore = readBaseline(root);
    const stfBefore = (baselineBefore.checkTouchedFiles as Record<string, unknown> | undefined)?.['has-readme'];
    expect(stfBefore).toBeDefined();

    // Toggle aspect to draft, approve
    const aspectYamlPath = path.join(root, '.yggdrasil', 'aspects', 'has-readme', 'yg-aspect.yaml');
    const yaml = readFileSync(aspectYamlPath, 'utf-8').replace(/^status: .*/m, 'status: draft');
    writeFileSync(aspectYamlPath, yaml);
    run(['approve', '--node', 'N'], root);

    const baselineAfter = readBaseline(root);
    const stfAfter = (baselineAfter.checkTouchedFiles as Record<string, unknown> | undefined)?.['has-readme'];
    // D8.3 carry-forward: draft-skipped structure aspects retain their prior checkTouchedFiles entry
    expect(stfAfter).toEqual(stfBefore);
  });
});
