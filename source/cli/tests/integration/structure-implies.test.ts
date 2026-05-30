import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
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

describe.skipIf(!distExists)('structure aspect implies cascade', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'yg-implies-'));
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('structure aspect implies AST aspect — drift on structure-touched file forces re-approve of implied AST aspect', () => {
    // Layout: structure aspect 'structural' implies AST aspect 'astrule'.
    // Both applied to node N with src/a.ts in mapping.
    // 'structural' reads src/a.ts via ctx.fs.read → tracked in structureTouchedFiles.
    // After approve: mutate src/a.ts → check should detect drift (both aspects need re-approve).
    // NOTE: using type:ast for the implied aspect (not LLM) for deterministic CI behaviour.
    const ygg = path.join(root, '.yggdrasil');
    mkdirSync(path.join(ygg, 'schemas'), { recursive: true });
    mkdirSync(path.join(ygg, 'aspects', 'structural'), { recursive: true });
    mkdirSync(path.join(ygg, 'aspects', 'astrule'), { recursive: true });
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
      `name: N\ntype: service\ndescription: test\nmapping:\n  - src/a.ts\naspects:\n  - structural\n`,
    );
    // structure aspect with implies: [astrule]
    writeFileSync(
      path.join(ygg, 'aspects', 'structural', 'yg-aspect.yaml'),
      `name: Structural\ndescription: structure rule that reads src/a.ts\nreviewer:\n  type: deterministic\nimplies:\n  - astrule\nstatus: enforced\n`,
    );
    writeFileSync(
      path.join(ygg, 'aspects', 'structural', 'check.mjs'),
      `export function check(ctx) { ctx.fs.read('src/a.ts'); return []; }\n`,
    );
    // implied AST aspect — trivially passes
    writeFileSync(
      path.join(ygg, 'aspects', 'astrule', 'yg-aspect.yaml'),
      `name: AstRule\ndescription: ast-judged rule that always passes\nreviewer:\n  type: deterministic\nlanguage:\n  - typescript\nstatus: enforced\n`,
    );
    writeFileSync(
      path.join(ygg, 'aspects', 'astrule', 'check.mjs'),
      `export function check(_ctx) { return []; }\n`,
    );

    // Initial approve — both aspects run
    const approveResult = run(['approve', '--node', 'N'], root);
    expect(approveResult.status).toBe(0);

    // Mutate the file the structure aspect tracked
    writeFileSync(path.join(root, 'src', 'a.ts'), 'export const x = 2;\n');

    // yg check must detect drift because structureTouchedFiles[structural][src/a.ts] changed
    const checkResult = run(['check'], root);
    expect(checkResult.status).toBe(1);
    // Output should reference drift and suggest approve
    expect(checkResult.stdout.toLowerCase()).toMatch(/drift|approve/);

    // Re-approve clears drift
    const reApproveResult = run(['approve', '--node', 'N'], root);
    expect(reApproveResult.status).toBe(0);

    const checkClean = run(['check'], root);
    expect(checkClean.status).toBe(0);
  });

  // status_inherit is not yet implemented in the effective-aspect-status computation.
  // This test is skipped until statusInherit propagation is wired in
  // source/cli/src/core/graph/aspects.ts (computeEffectiveAspectStatuses).
  it.skip('LLM aspect implies structure aspect with status_inherit: strictest — effective status promotes to enforced', () => {
    // When an enforced LLM aspect implies a structure aspect via
    //   implies:
    //     - id: struct-aspect
    //       status_inherit: strictest
    // the structure aspect's effective status should be promoted to enforced even
    // if its own declared status is advisory. This test will verify that promotion
    // via `yg context --node N` output containing "enforced" for the structure aspect,
    // or by verifying that yg check exits 1 (enforced violation) rather than 0
    // (advisory warning) when the structure aspect produces a violation.
    //
    // TODO: implement status_inherit propagation in computeEffectiveAspectStatuses
    // in source/cli/src/core/graph/aspects.ts, then enable this test.
  });
});
