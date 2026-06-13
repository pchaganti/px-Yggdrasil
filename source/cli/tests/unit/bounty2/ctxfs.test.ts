import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  symlinkSync,
  realpathSync,
  cpSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  resolveAllowedReadPath,
  createCtxFs,
  UndeclaredFsReadError,
} from '../../../src/structure/ctx-fs.js';

// ===========================================================================
// Branch-coverage bug-bounty suite for ctx-fs.ts:
//   - isAllowed(p, set)             — all 5 branches (both sides of each bool)
//   - resolveAllowedReadPath(...)   — every early-return + the success path
//   - assertRealpathContained(...)  — in-repo symlink ok, escaping symlink
//                                     rejected, nonexistent leaf, fs-root walk
//
// resolveAllowedReadPath is the public entry point that internally exercises
// isAllowed and assertRealpathContained (both module-private). We drive every
// branch through it (and through the createCtxFs facade, which calls it). One
// E2E group spawns the real `yg` binary so the same matching is confirmed
// end-to-end through `yg aspect-test`.
//
// Determinism: no random data (mkdtemp's suffix is OS-provided, not asserted
// on); no wall-clock reads in assertions; every temp tree removed in finally.
// ===========================================================================

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'e2e-lifecycle');
const distExists = existsSync(BIN_PATH);

/** Build a fresh temp repo with the given files and return its REAL path. */
function makeRepo(
  files: Record<string, string>,
): { root: string; cleanup: () => void } {
  const raw = mkdtempSync(path.join(tmpdir(), 'yg-ctxfs-'));
  // /tmp may itself be a symlink (e.g. macOS /tmp -> /private/tmp); canonicalize
  // so our own absolute-path assertions compare against the real root.
  const root = realpathSync(raw);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return { root, cleanup: () => rmSync(raw, { recursive: true, force: true }) };
}

describe('ctx-fs — isAllowed branch matrix (via resolveAllowedReadPath)', () => {
  // ---- isAllowed branch 1: p === '' → false -----------------------------
  // resolveAllowedReadPath rejects rel === '' BEFORE reaching isAllowed (the
  // repo root itself). So the only way to observe isAllowed's empty branch is
  // a path that normalizes to '' relative to root — i.e. the root directory.
  it("rejects the repo root itself (rel === '' early-return)", () => {
    const { root, cleanup } = makeRepo({ 'src/a.ts': 'a' });
    try {
      expect(() =>
        resolveAllowedReadPath('.', new Set(['src/a.ts']), root),
      ).toThrow(UndeclaredFsReadError);
    } finally {
      cleanup();
    }
  });

  // ---- isAllowed branch 2: set.has(p) exact-hit → true ------------------
  it('admits an exact allowed-set member (set.has true)', () => {
    const { root, cleanup } = makeRepo({ 'src/a.ts': 'a' });
    try {
      expect(resolveAllowedReadPath('src/a.ts', new Set(['src/a.ts']), root)).toBe(
        'src/a.ts',
      );
    } finally {
      cleanup();
    }
  });

  // ---- isAllowed branch 3: a.startsWith(p + '/') → true -----------------
  // p ('src') is an ANCESTOR directory of allowed entry 'src/a.ts'. Exact-hit
  // is false (set has no 'src'), mappingEntryMatchesFile('src/a.ts','src') is
  // false, so the ancestor branch is the one that admits it.
  it('admits an ancestor directory of an allowed file (a.startsWith(p + "/"))', () => {
    const { root, cleanup } = makeRepo({ 'src/a.ts': 'a' });
    try {
      expect(resolveAllowedReadPath('src', new Set(['src/a.ts']), root)).toBe('src');
    } finally {
      cleanup();
    }
  });

  // The ancestor branch also lets the literal leading prefix of a GLOB entry
  // be probed (exists/list on the parent dir of glob-matched files).
  it('admits the literal leading prefix of a glob allowed entry (ancestor branch via glob)', () => {
    const { root, cleanup } = makeRepo({ 'src/db/X.ts': 'x' });
    try {
      // 'src/db/*Repository.ts'.startsWith('src/db' + '/') is true.
      expect(
        resolveAllowedReadPath('src/db', new Set(['src/db/*Repository.ts']), root),
      ).toBe('src/db');
    } finally {
      cleanup();
    }
  });

  // ---- isAllowed branch 4a: mappingEntryMatchesFile plain dir-prefix ----
  // Allowed entry is a bare directory 'src/lib'. p='src/lib/baz.ts': exact-hit
  // false, ancestor-of false ('src/lib'.startsWith('src/lib/baz.ts/') is
  // false), so the plain dir-prefix branch (f.startsWith(e + '/')) admits it.
  it('admits a file under a bare-directory allowed entry (plain prefix match)', () => {
    const { root, cleanup } = makeRepo({ 'src/lib/baz.ts': 'b' });
    try {
      expect(
        resolveAllowedReadPath('src/lib/baz.ts', new Set(['src/lib']), root),
      ).toBe('src/lib/baz.ts');
    } finally {
      cleanup();
    }
  });

  // ---- isAllowed branch 4b: mappingEntryMatchesFile glob match ----------
  it('admits a file matching a glob allowed entry (glob branch true)', () => {
    const { root, cleanup } = makeRepo({ 'src/db/FooRepository.ts': 'r' });
    try {
      expect(
        resolveAllowedReadPath(
          'src/db/FooRepository.ts',
          new Set(['src/db/*Repository.ts']),
          root,
        ),
      ).toBe('src/db/FooRepository.ts');
    } finally {
      cleanup();
    }
  });

  // ---- isAllowed branch 5: none match → false ---------------------------
  it('rejects a file matching NO allowed entry (glob branch false → none)', () => {
    const { root, cleanup } = makeRepo({ 'src/db/Helper.ts': 'h' });
    try {
      expect(() =>
        resolveAllowedReadPath(
          'src/db/Helper.ts',
          new Set(['src/db/*Repository.ts']),
          root,
        ),
      ).toThrow(UndeclaredFsReadError);
    } finally {
      cleanup();
    }
  });

  it('rejects a plainly-unmapped file (all branches false)', () => {
    const { root, cleanup } = makeRepo({ 'src/a.ts': 'a', 'src/b.ts': 'b' });
    try {
      expect(() =>
        resolveAllowedReadPath('src/b.ts', new Set(['src/a.ts']), root),
      ).toThrow(UndeclaredFsReadError);
    } finally {
      cleanup();
    }
  });

  it('rejects against an EMPTY allowed set (for-loop body never runs → none → false)', () => {
    const { root, cleanup } = makeRepo({ 'src/a.ts': 'a' });
    try {
      expect(() =>
        resolveAllowedReadPath('src/a.ts', new Set<string>(), root),
      ).toThrow(UndeclaredFsReadError);
    } finally {
      cleanup();
    }
  });

  // Sibling-prefix false-positive guard: 'src/lib2/x.ts' must NOT be admitted
  // by allowed 'src/lib' (startsWith requires the trailing '/').
  it('does not admit a sibling whose name merely shares a prefix (no false dir match)', () => {
    const { root, cleanup } = makeRepo({ 'src/lib2/x.ts': 'x' });
    try {
      expect(() =>
        resolveAllowedReadPath('src/lib2/x.ts', new Set(['src/lib']), root),
      ).toThrow(UndeclaredFsReadError);
    } finally {
      cleanup();
    }
  });
});

describe('ctx-fs — resolveAllowedReadPath early-return branches', () => {
  // ---- rel === '' reject (root) -----------------------------------------
  it("rejects '' / '.' / './' that resolve to the repo root (rel === '')", () => {
    const { root, cleanup } = makeRepo({ 'src/a.ts': 'a' });
    const set = new Set(['src/a.ts']);
    try {
      // normalizeMappingPath('') === '', resolves to root, rel === ''.
      expect(() => resolveAllowedReadPath('', set, root)).toThrow(
        UndeclaredFsReadError,
      );
      // './' normalizes to '' as well.
      expect(() => resolveAllowedReadPath('./', set, root)).toThrow(
        UndeclaredFsReadError,
      );
    } finally {
      cleanup();
    }
  });

  // ---- rel.startsWith('..') reject (dotdot escape) ----------------------
  it("rejects a path that escapes the repo via '..' (rel starts with '..')", () => {
    const { root, cleanup } = makeRepo({ 'src/a.ts': 'a' });
    try {
      expect(() =>
        resolveAllowedReadPath('../outside.ts', new Set(['src/a.ts']), root),
      ).toThrow(UndeclaredFsReadError);
    } finally {
      cleanup();
    }
  });

  it("rejects a deep '..' traversal that climbs out of the repo", () => {
    const { root, cleanup } = makeRepo({ 'src/lib/baz.ts': 'b' });
    try {
      // Even though 'src/lib' is allowed, the resolved rel climbs above root.
      expect(() =>
        resolveAllowedReadPath(
          'src/lib/../../../../../etc/passwd',
          new Set(['src/lib']),
          root,
        ),
      ).toThrow(UndeclaredFsReadError);
    } finally {
      cleanup();
    }
  });

  // ---- path.isAbsolute(rel) reject (absolute) ---------------------------
  // On POSIX, path.relative(root, '/etc/passwd') yields a '..'-leading string,
  // so this is caught by the startsWith('..') arm. To hit the isAbsolute arm
  // in isolation we rely on the OR-chain: any absolute outside path is rejected.
  it('rejects an absolute path outside the repo', () => {
    const { root, cleanup } = makeRepo({ 'src/a.ts': 'a' });
    try {
      expect(() =>
        resolveAllowedReadPath('/etc/passwd', new Set(['src/a.ts']), root),
      ).toThrow(UndeclaredFsReadError);
    } finally {
      cleanup();
    }
  });

  it('rejects an absolute path that points INSIDE the repo but is not allowed', () => {
    const { root, cleanup } = makeRepo({ 'src/a.ts': 'a', 'src/b.ts': 'b' });
    try {
      // Absolute-but-inside: normalizeMappingPath keeps it absolute, path.resolve
      // returns it, path.relative gives 'src/b.ts' (in-repo) — so it passes the
      // lexical gate and is rejected by the allow-set instead.
      expect(() =>
        resolveAllowedReadPath(
          path.join(root, 'src/b.ts'),
          new Set(['src/a.ts']),
          root,
        ),
      ).toThrow(UndeclaredFsReadError);
    } finally {
      cleanup();
    }
  });

  // ---- not-allowed reject (isAllowed false after lexical gate passes) ----
  it('rejects an in-repo, lexically-clean, but un-allowlisted path', () => {
    const { root, cleanup } = makeRepo({ 'src/a.ts': 'a', 'src/secret.ts': 's' });
    try {
      expect(() =>
        resolveAllowedReadPath('src/secret.ts', new Set(['src/a.ts']), root),
      ).toThrow(UndeclaredFsReadError);
    } finally {
      cleanup();
    }
  });

  // ---- allowed pass (full success path, all gates clear) ----------------
  it('returns the repo-relative path on the full success path', () => {
    const { root, cleanup } = makeRepo({ 'src/a.ts': 'a' });
    try {
      const out = resolveAllowedReadPath('./src/a.ts', new Set(['src/a.ts']), root);
      expect(out).toBe('src/a.ts');
    } finally {
      cleanup();
    }
  });

  it('succeeds for a not-yet-existing (nonexistent leaf) allowed path — lexical+allow-set pass, realpath has nothing to follow', () => {
    const { root, cleanup } = makeRepo({ 'src/a.ts': 'a' });
    try {
      // 'src/ghost.ts' does not exist on disk but is allow-listed and in-repo.
      // assertRealpathContained walks up to the existing 'src' dir (in-repo),
      // so no throw — resolveAllowedReadPath returns the rel path.
      const out = resolveAllowedReadPath(
        'src/ghost.ts',
        new Set(['src/ghost.ts']),
        root,
      );
      expect(out).toBe('src/ghost.ts');
    } finally {
      cleanup();
    }
  });
});

describe('ctx-fs — assertRealpathContained (symlink-escape guard)', () => {
  // ---- in-repo symlink: ok ----------------------------------------------
  it('allows reading through a symlink that points INSIDE the repo', () => {
    const { root, cleanup } = makeRepo({ 'src/foo.ts': 'foo-content' });
    try {
      mkdirSync(path.join(root, 'src/lib'), { recursive: true });
      // src/lib/alias.ts -> src/foo.ts (both in-repo).
      symlinkSync(
        path.join(root, 'src/foo.ts'),
        path.join(root, 'src/lib/alias.ts'),
        'file',
      );
      const touched: string[] = [];
      const fs = createCtxFs({
        allowedSet: new Set(['src/lib']),
        projectRoot: root,
        touchedFiles: touched,
      });
      expect(fs.read('src/lib/alias.ts')).toBe('foo-content');
      expect(touched).toContain('src/lib/alias.ts');
    } finally {
      cleanup();
    }
  });

  // ---- escaping symlink: reject -----------------------------------------
  it('rejects a read whose REAL path escapes the repo via a symlinked dir', () => {
    const { root, cleanup } = makeRepo({ 'src/lib/keep.ts': 'k' });
    const outside = mkdtempSync(path.join(tmpdir(), 'yg-outside-'));
    writeFileSync(path.join(outside, 'secret.txt'), 'SECRET');
    try {
      // src/lib/escape -> <outside>; 'src/lib' is allow-listed.
      symlinkSync(outside, path.join(root, 'src/lib/escape'), 'dir');
      const touched: string[] = [];
      const fs = createCtxFs({
        allowedSet: new Set(['src/lib']),
        projectRoot: root,
        touchedFiles: touched,
      });
      expect(() => fs.read('src/lib/escape/secret.txt')).toThrow(
        UndeclaredFsReadError,
      );
      expect(() => fs.exists('src/lib/escape/secret.txt')).toThrow(
        UndeclaredFsReadError,
      );
    } finally {
      rmSync(outside, { recursive: true, force: true });
      cleanup();
    }
  });

  it('rejects via resolveAllowedReadPath directly when the existing ancestor symlink escapes', () => {
    const { root, cleanup } = makeRepo({ 'src/lib/keep.ts': 'k' });
    const outside = mkdtempSync(path.join(tmpdir(), 'yg-outside2-'));
    writeFileSync(path.join(outside, 'secret.txt'), 'SECRET');
    try {
      symlinkSync(outside, path.join(root, 'src/lib/escape'), 'dir');
      // The leaf '.../secret.txt' exists through the link; its realpath is the
      // outside dir → relReal starts with '..' → throw.
      expect(() =>
        resolveAllowedReadPath(
          'src/lib/escape/secret.txt',
          new Set(['src/lib']),
          root,
        ),
      ).toThrow(UndeclaredFsReadError);
    } finally {
      rmSync(outside, { recursive: true, force: true });
      cleanup();
    }
  });

  // ---- nonexistent leaf: probe walks up to existing in-repo ancestor ----
  it('allows a nonexistent leaf whose existing ancestor is in-repo (realpath nothing to follow)', () => {
    const { root, cleanup } = makeRepo({ 'src/lib/real.ts': 'r' });
    try {
      const touched: string[] = [];
      const fs = createCtxFs({
        allowedSet: new Set(['src/lib']),
        projectRoot: root,
        touchedFiles: touched,
      });
      // src/lib/ghost.ts does not exist; assertRealpathContained probes up to
      // 'src/lib' (exists, in-repo) → no throw. The subsequent statSync fails
      // → exists() returns false (NOT a throw).
      expect(fs.exists('src/lib/ghost.ts')).toBe(false);
      expect(touched).toContain('src/lib/ghost.ts');
    } finally {
      cleanup();
    }
  });

  // ---- nonexistent leaf under a symlinked dir that escapes: STILL reject -
  // The leaf does not exist, but its nearest existing ancestor is the escaping
  // symlink dir itself, whose realpath is outside the repo → throw.
  it('rejects a nonexistent leaf under an escaping symlinked dir (ancestor realpath escapes)', () => {
    const { root, cleanup } = makeRepo({ 'src/lib/keep.ts': 'k' });
    const outside = mkdtempSync(path.join(tmpdir(), 'yg-outside3-'));
    try {
      symlinkSync(outside, path.join(root, 'src/lib/escape'), 'dir');
      const touched: string[] = [];
      const fs = createCtxFs({
        allowedSet: new Set(['src/lib']),
        projectRoot: root,
        touchedFiles: touched,
      });
      expect(() => fs.exists('src/lib/escape/missing.txt')).toThrow(
        UndeclaredFsReadError,
      );
    } finally {
      rmSync(outside, { recursive: true, force: true });
      cleanup();
    }
  });

  // ---- projectRoot under a symlink: both sides canonicalized → ok -------
  // realRoot is realpath(projectRoot). If we pass a SYMLINKED root and read an
  // in-repo file, the relative(realRoot, realProbe) must still be in-repo.
  it('handles a projectRoot that is itself reached through a symlink', () => {
    const { root, cleanup } = makeRepo({ 'src/a.ts': 'a-content' });
    const linkParent = mkdtempSync(path.join(tmpdir(), 'yg-rootlink-'));
    const linkedRoot = path.join(linkParent, 'link');
    try {
      symlinkSync(root, linkedRoot, 'dir');
      const touched: string[] = [];
      const fs = createCtxFs({
        allowedSet: new Set(['src/a.ts']),
        projectRoot: linkedRoot, // a symlink to the real root
        touchedFiles: touched,
      });
      // realRoot = realpath(linkedRoot) = root; realProbe = root/src/a.ts →
      // in-repo, no throw.
      expect(fs.read('src/a.ts')).toBe('a-content');
    } finally {
      rmSync(linkParent, { recursive: true, force: true });
      cleanup();
    }
  });

  // ---- createCtxFs facade: touched tracking on every op, plus list ------
  it('list() returns dir entries for an allowed dir and tracks touched', () => {
    const { root, cleanup } = makeRepo({
      'src/lib/baz.ts': 'b',
      'src/lib/qux.ts': 'q',
    });
    try {
      const touched: string[] = [];
      const fs = createCtxFs({
        allowedSet: new Set(['src/lib']),
        projectRoot: root,
        touchedFiles: touched,
      });
      const entries = fs.list('src/lib');
      expect(entries).toEqual(
        expect.arrayContaining([
          { name: 'baz.ts', kind: 'file' },
          { name: 'qux.ts', kind: 'file' },
        ]),
      );
      expect(touched).toContain('src/lib');
    } finally {
      cleanup();
    }
  });

  it('exists() returns "dir" for an allowed dir and "file" for an allowed file', () => {
    const { root, cleanup } = makeRepo({ 'src/lib/baz.ts': 'b' });
    try {
      const touched: string[] = [];
      const fs = createCtxFs({
        allowedSet: new Set(['src/lib/baz.ts']),
        projectRoot: root,
        touchedFiles: touched,
      });
      expect(fs.exists('src/lib/baz.ts')).toBe('file');
      // 'src/lib' is an ancestor of the allowed file → admitted, and it is a dir.
      expect(fs.exists('src/lib')).toBe('dir');
    } finally {
      cleanup();
    }
  });
});

// ===========================================================================
// E2E — the SAME isAllowed / realpath matching reached through the real `yg`
// binary via `yg aspect-test --node <path> --aspect <id>`, which runs
// a graph-scoped check.mjs whose ctx.fs.read goes through resolveAllowedRead-
// Path. We copy the e2e-lifecycle fixture into a temp dir, rewrite the dormant
// `wip-rule` check.mjs to perform a specific read, and assert the surfaced
// verdict (exit code + rendered message).
//
// orders' allowed-set = its own mapping (src/services/orders.ts) only; the
// sibling payments.ts is therefore NOT allowed.
// ===========================================================================

function run(args: string[], cwd: string): {
  stdout: string;
  stderr: string;
  status: number | null;
  all: string;
} {
  const result = spawnSync('node', [BIN_PATH, ...args], { cwd, encoding: 'utf-8' });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  return { stdout, stderr, status: result.status, all: stdout + stderr };
}

function copyFixture(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-ctxfs-e2e-${label}-`));
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

/** Overwrite the dormant wip-rule check.mjs with a custom body. */
function setWipCheck(dir: string, body: string): void {
  writeFileSync(
    path.join(dir, '.yggdrasil', 'aspects', 'wip-rule', 'check.mjs'),
    body,
    'utf-8',
  );
}

describe.skipIf(!distExists)('ctx-fs — E2E through yg aspect-test', () => {
  it("E1: ctx.fs.read of an ALLOWED own-mapping file → no violation (isAllowed true path)", () => {
    const dir = copyFixture('allowed');
    try {
      setWipCheck(
        dir,
        [
          'export function check(ctx) {',
          "  const c = ctx.fs.read('src/services/orders.ts');",
          "  if (typeof c !== 'string') return [{ message: 'not string', file: 'src/services/orders.ts', line: 1 }];",
          '  return [];',
          '}',
          '',
        ].join('\n'),
      );
      const { status, all } = run(
        ['aspect-test', '--node', 'services/orders', '--aspect', 'wip-rule'],
        dir,
      );
      expect(status).toBe(0);
      expect(all).toContain('No violations.');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("E2: ctx.fs.read of a sibling NOT in the allowed-set → undeclared-fs-read (exit 1)", () => {
    const dir = copyFixture('denied');
    try {
      setWipCheck(
        dir,
        [
          'export function check(ctx) {',
          "  ctx.fs.read('src/services/payments.ts');",
          '  return [];',
          '}',
          '',
        ].join('\n'),
      );
      const { status, all } = run(
        ['aspect-test', '--node', 'services/orders', '--aspect', 'wip-rule'],
        dir,
      );
      expect(status).toBe(1);
      expect(all).toContain(
        "Aspect tried to read undeclared path 'src/services/payments.ts'",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("E3: ctx.fs.read of an absolute outside path → undeclared-fs-read (exit 1)", () => {
    const dir = copyFixture('absolute');
    try {
      setWipCheck(
        dir,
        [
          'export function check(ctx) {',
          "  ctx.fs.read('/etc/passwd');",
          '  return [];',
          '}',
          '',
        ].join('\n'),
      );
      const { status, all } = run(
        ['aspect-test', '--node', 'services/orders', '--aspect', 'wip-rule'],
        dir,
      );
      expect(status).toBe(1);
      expect(all).toContain('Aspect tried to read undeclared path');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("E4: ctx.fs.read through an in-repo symlinked DIR mapping that escapes → undeclared-fs-read (exit 1)", () => {
    const dir = copyFixture('symlink-escape');
    const outside = mkdtempSync(path.join(tmpdir(), 'yg-ctxfs-e2e-outside-'));
    try {
      writeFileSync(path.join(outside, 'secret.txt'), 'SECRET');
      // Remap orders to a directory we control; the directory holds a symlink
      // pointing outside the repo. The textual path stays in-repo and is
      // allow-listed (under the dir mapping), but the realpath guard rejects it.
      mkdirSync(path.join(dir, 'src/services/orderdir'), { recursive: true });
      writeFileSync(
        path.join(dir, 'src/services/orderdir/real.ts'),
        'export const x = 1;\n',
      );
      symlinkSync(outside, path.join(dir, 'src/services/orderdir/escape'), 'dir');
      // orders.ts is removed and the node remapped to the directory.
      rmSync(path.join(dir, 'src/services/orders.ts'), { force: true });
      writeFileSync(
        path.join(dir, '.yggdrasil', 'model', 'services', 'orders', 'yg-node.yaml'),
        [
          'name: OrdersService',
          'description: Creates and retrieves customer orders.',
          'type: service',
          'aspects:',
          '  - wip-rule',
          'mapping:',
          '  - src/services/orderdir',
          '',
        ].join('\n'),
        'utf-8',
      );
      setWipCheck(
        dir,
        [
          'export function check(ctx) {',
          "  ctx.fs.read('src/services/orderdir/escape/secret.txt');",
          '  return [];',
          '}',
          '',
        ].join('\n'),
      );
      const { status, all } = run(
        ['aspect-test', '--node', 'services/orders', '--aspect', 'wip-rule'],
        dir,
      );
      expect(status).toBe(1);
      expect(all).toContain(
        "Aspect tried to read undeclared path 'src/services/orderdir/escape/secret.txt'",
      );
    } finally {
      rmSync(outside, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
