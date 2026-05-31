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

  it('structure aspect implies AST aspect — drift on check-touched file forces re-approve of implied AST aspect', () => {
    // Layout: structure aspect 'structural' implies AST aspect 'astrule'.
    // Both applied to node N with src/a.ts in mapping.
    // 'structural' reads src/a.ts via ctx.fs.read → tracked in checkTouchedFiles.
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

    // yg check must detect drift because checkTouchedFiles[structural][src/a.ts] changed
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

  // status_inherit propagation IS implemented in computeEffectiveAspectStatuses
  // (source/cli/src/core/graph/aspects.ts). An enforced implier with
  // status_inherit: strictest promotes the implied aspect's effective status to
  // enforced even when the implied aspect's own default is advisory — so an
  // implied-aspect violation BLOCKS (exit 1) instead of warning (exit 0).
  // (Deterministic aspects on both sides for hermetic CI — no LLM.)
  it('aspect implies another with status_inherit: strictest — the implied aspect is promoted to enforced and blocks', () => {
    const ygg = path.join(root, '.yggdrasil');
    mkdirSync(path.join(ygg, 'schemas'), { recursive: true });
    mkdirSync(path.join(ygg, 'aspects', 'gate'), { recursive: true });
    mkdirSync(path.join(ygg, 'aspects', 'child'), { recursive: true });
    mkdirSync(path.join(ygg, 'model', 'N'), { recursive: true });
    mkdirSync(path.join(root, 'src'), { recursive: true });
    for (const schema of ['yg-node.yaml', 'yg-aspect.yaml', 'yg-flow.yaml']) {
      copyFileSync(path.join(SCHEMAS_SRC, schema), path.join(ygg, 'schemas', schema));
    }
    writeFileSync(path.join(root, 'src', 'a.ts'), 'export const x = 1; // BANNED\n');
    writeFileSync(path.join(ygg, 'yg-architecture.yaml'), YG_ARCH);
    writeFileSync(path.join(ygg, 'yg-config.yaml'), YG_CONFIG);
    // gate: enforced, always passes, implies child with strictest inheritance.
    writeFileSync(
      path.join(ygg, 'aspects', 'gate', 'yg-aspect.yaml'),
      'name: Gate\ndescription: gate\nreviewer:\n  type: deterministic\nstatus: enforced\nimplies:\n  - id: child\n    status_inherit: strictest\n',
    );
    writeFileSync(path.join(ygg, 'aspects', 'gate', 'check.mjs'), 'export function check() { return []; }\n');
    // child: advisory by its OWN default; flags the BANNED token.
    writeFileSync(
      path.join(ygg, 'aspects', 'child', 'yg-aspect.yaml'),
      'name: Child\ndescription: child\nreviewer:\n  type: deterministic\nstatus: advisory\n',
    );
    writeFileSync(
      path.join(ygg, 'aspects', 'child', 'check.mjs'),
      'export function check(ctx) {\n  const v = [];\n  for (const f of ctx.files) {\n    const lines = f.content.split("\\n");\n    lines.forEach((l, i) => { if (l.includes("BANNED")) v.push({ file: f.path, line: i + 1, column: 0, message: "banned token" }); });\n  }\n  return v;\n}\n',
    );
    writeFileSync(
      path.join(ygg, 'model', 'N', 'yg-node.yaml'),
      'name: N\ntype: service\ndescription: test\nmapping:\n  - src/a.ts\naspects:\n  - gate\n',
    );

    // child reaches N ONLY via the implies edge, and strictest inheritance
    // promotes it from its own advisory default to the implier's enforced status.
    const ctx = run(['context', '--node', 'N'], root);
    expect(ctx.status).toBe(0);
    expect(ctx.stdout).toContain('child [enforced]');

    // Because child is now ENFORCED (not advisory), its BANNED violation BLOCKS:
    // approve refuses (exit 1) instead of recording a non-blocking advisory warning.
    const approve = run(['approve', '--node', 'N'], root);
    expect(approve.status).toBe(1);
    expect(approve.stdout + approve.stderr).toContain('child');
  });
});
