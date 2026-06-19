import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Hermetic E2E for the silent-drop false-green detection (mapped-file-gitignored).
//
// A git-tracked file that is ALSO gitignored (here via `git add -f` after a
// .gitignore rule) and is reached ONLY through a DIRECTORY mapping entry is
// counted "covered" by the coverage scan yet is dropped from the node's subject
// set by the gitignore filter — no reviewer ever sees it (a false green). This
// suite spawns the REAL built binary against a GIT-INITIALIZED temp fixture and
// asserts the PROCESS EXIT CODE and the rendered blocking error, the contract
// the runCheck-level integration tests cannot reach (CLI wrapper + real exit).
//
// No network / clock / random: the reviewer tier points at a loopback that is
// never dialed by `yg check` (no LLM call on the check path).
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const LOOPBACK = 'http://127.0.0.1:11434';
const distExists = existsSync(BIN_PATH);

function git(args: string[], cwd: string): void {
  const r = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
}

function run(args: string[], cwd: string): { status: number | null; out: string } {
  const r = spawnSync('node', [BIN_PATH, ...args], { cwd, encoding: 'utf-8' });
  return { status: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') };
}

/**
 * Scaffold a git repo whose single service node maps the DIRECTORY `src/svc/`.
 * `src/svc/i.ts` is a normal tracked file; `src/svc/secret.ts` matches a
 * .gitignore rule but is force-added so it is BOTH tracked AND gitignored — the
 * exact silent-drop condition. The node mapping is the directory, so secret.ts is
 * counted covered yet dropped from review.
 *
 * @param rescue when true, the node ALSO names src/svc/secret.ts directly in its
 *   mapping. A direct file entry bypasses gitignore, so the file is included and
 *   there is NO silent drop — the detection must stay quiet.
 */
function scaffold(label: string, opts: { rescue?: boolean }): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-gitignored-e2e-${label}-`));
  const ygRoot = path.join(dir, '.yggdrasil');
  mkdirSync(path.join(ygRoot, 'model', 'svc'), { recursive: true });
  writeFileSync(
    path.join(ygRoot, 'yg-architecture.yaml'),
    ['node_types:', '  service:', "    description: 'A service'", '    log_required: false', '    when:', '      path: "**"', ''].join('\n'),
    'utf-8',
  );
  writeFileSync(
    path.join(ygRoot, 'yg-config.yaml'),
    [
      'version: "5.1.0"',
      'coverage:',
      '  required:',
      '    - src/svc/',
      'reviewer:',
      '  tiers:',
      '    standard:',
      '      provider: ollama',
      '      consensus: 1',
      '      config:',
      '        model: test',
      `        endpoint: ${LOOPBACK}`,
      '',
    ].join('\n'),
    'utf-8',
  );
  const mappingLines = opts.rescue
    ? '  - src/svc/\n  - src/svc/secret.ts\n'
    : '  - src/svc/\n';
  writeFileSync(
    path.join(ygRoot, 'model', 'svc', 'yg-node.yaml'),
    `name: Svc\ntype: service\ndescription: demo\nmapping:\n${mappingLines}`,
    'utf-8',
  );
  mkdirSync(path.join(dir, 'src', 'svc'), { recursive: true });
  // secret.ts matches this .gitignore rule but is force-added below.
  writeFileSync(path.join(dir, '.gitignore'), 'src/svc/secret.ts\n', 'utf-8');
  writeFileSync(path.join(dir, 'src', 'svc', 'i.ts'), '', 'utf-8');
  writeFileSync(path.join(dir, 'src', 'svc', 'secret.ts'), 'export const k = 1;\n', 'utf-8');
  git(['init', '-q'], dir);
  git(['config', 'user.email', 't@t.t'], dir);
  git(['config', 'user.name', 't'], dir);
  git(['add', '-A'], dir); // tracks .gitignore, config, node, i.ts (NOT secret.ts — it's ignored)
  git(['add', '-f', 'src/svc/secret.ts'], dir); // force-track the gitignored file
  return dir;
}

describe('E2E: mapped-file-gitignored silent-drop detection via the real CLI binary', () => {
  it.skipIf(!distExists)(
    'a git-tracked, gitignored, directory-mapped file is a blocking error: exits 1 (FAIL) and names the file',
    () => {
      const dir = scaffold('drop', { rescue: false });
      try {
        const { status, out } = run(['check'], dir);
        expect(status).toBe(1); // false-green detection blocks
        expect(out).toContain('FAIL');
        expect(out).toContain('mapped-file-gitignored');
        expect(out).toContain('src/svc/secret.ts');
        expect(out).toContain('.gitignore');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!distExists)(
    'a directly-named mapping entry rescues the file: the silent-drop error is NOT raised',
    () => {
      const dir = scaffold('rescue', { rescue: true });
      try {
        const { out } = run(['check'], dir);
        // No mapped-file-gitignored error. (Other unrelated errors, e.g. an
        // unverified pair on the directly-mapped file, may still keep exit 1 —
        // assert only that THIS detection stays quiet.)
        expect(out).not.toContain('mapped-file-gitignored');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
