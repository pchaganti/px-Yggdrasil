/**
 * BOUNTY 3 — adversarial invariants for the drift canonical-hash subsystem.
 *
 *   Target source: src/io/hash.ts (computeCanonicalHash, serializeIdentity,
 *   serializeVerdicts via the fold, hashTrackedFiles + reuseByMtime gate) and
 *   the verdict/identity shapes in src/model/drift.ts.
 *
 * These are the invariants that, if broken, cause FALSE-GREEN / LOST-DRIFT /
 * WRONG-VERDICT — the high-value failure modes:
 *
 *   I1  Canonical hash is stable across file-order permutations (already lightly
 *       covered for the obvious case; here we stress many permutations + posix
 *       casing + a single-vs-many fold).
 *   I2  The verdict (approved/refused) + errorSource discriminator are folded so
 *       a HAND-EDITED stored verdict changes the hash. We pin the discriminator
 *       boundary the existing suite misses: an OMITTED errorSource (`undefined`)
 *       on a `refused` verdict serializes as `''` and therefore differs from an
 *       explicit `codeViolation` (the existing test only contrasts codeViolation
 *       vs provider).
 *   I3  The free-text `reason` is EXCLUDED from the fold — two refusals that
 *       differ only in prose hash equal, INCLUDING across approved verdicts and
 *       across the omitted-vs-present errorSource combinations.
 *   I4  mtime is NEVER an input to the canonical hash: changing only a file's
 *       mtime (content untouched) yields the identical canonical hash, while the
 *       fileMtimes map reflects the new mtime. (The existing suite asserts the
 *       cache-hit equality but never proves the canonical hash ignores mtime for
 *       a genuinely re-stat'd file.)
 *   I5  The check gate (reuseByMtime=false) ALWAYS re-hashes content: a content
 *       edit whose stored mtime is forged to equal the on-disk mtime is still
 *       detected, whereas the approve path (reuseByMtime=true) reuses the stale
 *       hash. The existing unit test covers this on hashTrackedFiles directly;
 *       here we ALSO drive it through the real `yg check` binary end-to-end
 *       (the touch-mtime exploit blocked at the spawned gate).
 *   I6  Empty / identity inputs: the empty fold ({} files, EMPTY identity, {}
 *       verdicts) is a fixed, deterministic value distinct from every non-empty
 *       fold, and reproduces across calls.
 *
 * HERMETIC: pure-function probes import the real functions; the E2E group spawns
 * the real binary against a throwaway copy of the e2e-lifecycle fixture and
 * points the reviewer tier at an in-process mock that speaks the Ollama
 * protocol (tests/e2e/support/mock-reviewer.ts) — no network, no real model.
 * Every temp tree is created via mkdtemp under os.tmpdir() and removed in a
 * finally; the repo's own files / src / .yggdrasil are never touched. No
 * randomness; the wall clock is read only in setup (mtime forging), never inside
 * an assertion.
 */
import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, rm, stat, utimes } from 'node:fs/promises';
import {
  existsSync,
  mkdtempSync,
  rmSync,
  cpSync,
  readFileSync,
  writeFileSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import {
  computeCanonicalHash,
  serializeIdentity,
  hashTrackedFiles,
  hashString,
} from '../../../src/io/hash.js';
import type { DriftIdentity, AspectVerdict } from '../../../src/model/drift.js';
import type { TrackedFile } from '../../../src/core/graph/files.js';
import { startMockReviewer, runAsync } from '../../e2e/support/mock-reviewer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '..', '..', '..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'e2e-lifecycle');
const distExists = existsSync(BIN_PATH);

// The empty identity computeCanonicalHash folds when no identity is supplied —
// ownSubset is the empty-string digest, matching hash.ts's EMPTY_IDENTITY.
const EMPTY_IDENTITY: DriftIdentity = { ownSubset: hashString(''), ports: {}, aspects: {} };

// A small but non-trivial identity reused across the determinism probes.
const IDENT: DriftIdentity = {
  ownSubset: 'own-subset-hash',
  ports: { 'svc/b': 'pb', 'svc/a': 'pa' },
  aspects: {
    zeta: { meta: 'mz', tier: 'tz' },
    alpha: { meta: 'ma', checkTouched: { 'src/b.ts': 'hb', 'src/a.ts': 'ha' } },
  },
};

// ───────────────────────────────────────────────────────────────────────────
// I1 — canonical hash is stable across file-order permutations.
// ───────────────────────────────────────────────────────────────────────────
describe('I1 canonical hash — file-order permutation stability', () => {
  // A fixed file map; every permutation of its insertion order must fold equal.
  const fileMap: Record<string, string> = {
    'src/z.ts': hashString('z'),
    'src/a.ts': hashString('a'),
    'src/m/n.ts': hashString('n'),
    'README.md': hashString('r'),
  };

  /** All permutations of a small array (n! — kept to 4 entries → 24). */
  function permutations<T>(arr: T[]): T[][] {
    if (arr.length <= 1) return [arr];
    const out: T[][] = [];
    for (let i = 0; i < arr.length; i++) {
      const rest = [...arr.slice(0, i), ...arr.slice(i + 1)];
      for (const p of permutations(rest)) out.push([arr[i], ...p]);
    }
    return out;
  }

  it('every insertion-order permutation of the file map folds to one hash', () => {
    const entries = Object.entries(fileMap);
    const perms = permutations(entries);
    expect(perms).toHaveLength(24); // 4! — guard the generator itself
    const reference = computeCanonicalHash(fileMap, EMPTY_IDENTITY);
    for (const perm of perms) {
      const reordered = Object.fromEntries(perm) as Record<string, string>;
      expect(computeCanonicalHash(reordered, EMPTY_IDENTITY)).toBe(reference);
    }
  });

  it('a single content change in ONE file flips the otherwise-stable hash', () => {
    const reference = computeCanonicalHash(fileMap, EMPTY_IDENTITY);
    const changed = { ...fileMap, 'src/a.ts': hashString('a-changed') };
    expect(computeCanonicalHash(changed, EMPTY_IDENTITY)).not.toBe(reference);
  });

  it('hashTrackedFiles is order-independent for the same files on disk', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'b3-i1-htf-'));
    try {
      await writeFile(path.join(dir, 'a.txt'), 'alpha', 'utf-8');
      await writeFile(path.join(dir, 'b.txt'), 'beta', 'utf-8');
      await writeFile(path.join(dir, 'c.txt'), 'gamma', 'utf-8');
      const ab: TrackedFile[] = [
        { path: 'a.txt', category: 'source', layer: 'source' },
        { path: 'b.txt', category: 'graph', layer: 'hierarchy' },
        { path: 'c.txt', category: 'source', layer: 'source' },
      ];
      const cba: TrackedFile[] = [
        { path: 'c.txt', category: 'source', layer: 'source' },
        { path: 'b.txt', category: 'graph', layer: 'hierarchy' },
        { path: 'a.txt', category: 'source', layer: 'source' },
      ];
      const r1 = await hashTrackedFiles(dir, ab);
      const r2 = await hashTrackedFiles(dir, cba);
      expect(r2.canonicalHash).toBe(r1.canonicalHash);
      expect(Object.keys(r1.fileHashes).sort()).toEqual(['a.txt', 'b.txt', 'c.txt']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// I2 — verdict + errorSource folded; a hand-edited verdict changes the hash.
// ───────────────────────────────────────────────────────────────────────────
describe('I2 verdict fold — tamper protection & errorSource discriminator', () => {
  const files = { 'src/a.ts': hashString('a') };
  const ident: DriftIdentity = { ownSubset: 'o', ports: {}, aspects: {} };

  it('flipping a stored verdict refused→approved changes the canonical hash', () => {
    const refused: Record<string, AspectVerdict> = {
      a: { verdict: 'refused', errorSource: 'codeViolation' },
    };
    const flipped: Record<string, AspectVerdict> = { a: { verdict: 'approved' } };
    expect(computeCanonicalHash(files, ident, refused)).not.toBe(
      computeCanonicalHash(files, ident, flipped),
    );
  });

  it('an OMITTED errorSource on a refused verdict differs from explicit codeViolation', () => {
    // serializeVerdicts emits `errorSource=${v.errorSource ?? ''}`. An omitted
    // errorSource folds as the empty token, NOT as codeViolation — so a baseline
    // that records `{verdict:"refused"}` is NOT hash-equal to one recording
    // `{verdict:"refused",errorSource:"codeViolation"}`. Pinning this prevents a
    // future refactor from silently defaulting the discriminator and erasing the
    // distinction between an untagged refusal and a code violation.
    const omitted: Record<string, AspectVerdict> = { a: { verdict: 'refused' } };
    const codeViolation: Record<string, AspectVerdict> = {
      a: { verdict: 'refused', errorSource: 'codeViolation' },
    };
    expect(computeCanonicalHash(files, ident, omitted)).not.toBe(
      computeCanonicalHash(files, ident, codeViolation),
    );
  });

  it('errorSource undefined is hash-identical to an entirely omitted errorSource', () => {
    // `errorSource: undefined` and an absent key both serialize via `?? ''` to
    // the same token — they MUST fold equal (no spurious drift from how a writer
    // chose to express "no source").
    const undef: Record<string, AspectVerdict> = { a: { verdict: 'refused', errorSource: undefined } };
    const absent: Record<string, AspectVerdict> = { a: { verdict: 'refused' } };
    expect(computeCanonicalHash(files, ident, undef)).toBe(
      computeCanonicalHash(files, ident, absent),
    );
  });

  it('each errorSource value (codeViolation / provider / checkRuntime) folds distinctly', () => {
    const mk = (src: AspectVerdict['errorSource']): Record<string, AspectVerdict> => ({
      a: { verdict: 'refused', errorSource: src },
    });
    const hCode = computeCanonicalHash(files, ident, mk('codeViolation'));
    const hProv = computeCanonicalHash(files, ident, mk('provider'));
    const hRun = computeCanonicalHash(files, ident, mk('checkRuntime'));
    expect(new Set([hCode, hProv, hRun]).size).toBe(3);
  });

  it('verdict fold is order-independent over aspect ids (sorted)', () => {
    const a: Record<string, AspectVerdict> = {
      zeta: { verdict: 'approved' },
      alpha: { verdict: 'refused', errorSource: 'provider' },
      mid: { verdict: 'approved' },
    };
    const b: Record<string, AspectVerdict> = {
      mid: { verdict: 'approved' },
      alpha: { verdict: 'refused', errorSource: 'provider' },
      zeta: { verdict: 'approved' },
    };
    expect(computeCanonicalHash(files, ident, a)).toBe(computeCanonicalHash(files, ident, b));
  });

  it('adding a verdict for a NEW aspect id changes the hash (no silent absorb)', () => {
    const one: Record<string, AspectVerdict> = { a: { verdict: 'approved' } };
    const two: Record<string, AspectVerdict> = {
      a: { verdict: 'approved' },
      b: { verdict: 'approved' },
    };
    expect(computeCanonicalHash(files, ident, one)).not.toBe(
      computeCanonicalHash(files, ident, two),
    );
  });
});

// ───────────────────────────────────────────────────────────────────────────
// I3 — free-text reason is EXCLUDED from the fold.
// ───────────────────────────────────────────────────────────────────────────
describe('I3 verdict fold — free-text reason is never folded', () => {
  const files = { 'src/a.ts': hashString('a') };
  const ident: DriftIdentity = { ownSubset: 'o', ports: {}, aspects: {} };

  it('two refusals differing only in reason hash equal', () => {
    const r1: Record<string, AspectVerdict> = {
      a: { verdict: 'refused', reason: 'short', errorSource: 'codeViolation' },
    };
    const r2: Record<string, AspectVerdict> = {
      a: { verdict: 'refused', reason: 'a much longer, totally different prose reason', errorSource: 'codeViolation' },
    };
    expect(computeCanonicalHash(files, ident, r1)).toBe(computeCanonicalHash(files, ident, r2));
  });

  it('reason present vs absent on the SAME verdict hashes equal', () => {
    const withReason: Record<string, AspectVerdict> = {
      a: { verdict: 'refused', reason: 'because', errorSource: 'provider' },
    };
    const noReason: Record<string, AspectVerdict> = {
      a: { verdict: 'refused', errorSource: 'provider' },
    };
    expect(computeCanonicalHash(files, ident, withReason)).toBe(
      computeCanonicalHash(files, ident, noReason),
    );
  });

  it('reason is excluded even on an approved verdict', () => {
    const a1: Record<string, AspectVerdict> = { a: { verdict: 'approved', reason: 'noted' } };
    const a2: Record<string, AspectVerdict> = { a: { verdict: 'approved' } };
    expect(computeCanonicalHash(files, ident, a1)).toBe(computeCanonicalHash(files, ident, a2));
  });

  it('but a verdict flip is NOT masked by an identical reason', () => {
    // Reason is excluded, yet the verdict itself is folded — so two entries with
    // the SAME reason but different verdicts must still diverge. This guards that
    // reason-exclusion did not accidentally exclude the verdict too.
    const refused: Record<string, AspectVerdict> = {
      a: { verdict: 'refused', reason: 'same prose', errorSource: 'codeViolation' },
    };
    const approved: Record<string, AspectVerdict> = {
      a: { verdict: 'approved', reason: 'same prose' },
    };
    expect(computeCanonicalHash(files, ident, refused)).not.toBe(
      computeCanonicalHash(files, ident, approved),
    );
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Identity fold — section isolation & checkTouched empty-vs-absent.
// ───────────────────────────────────────────────────────────────────────────
describe('identity fold — determinism and section sensitivity', () => {
  it('serializeIdentity is stable across reordering of ports, aspects, and fields', () => {
    const a: DriftIdentity = {
      ownSubset: 'o',
      ports: { 'p/b': '2', 'p/a': '1' },
      aspects: { y: { tier: 'ty', meta: 'my' }, x: { meta: 'mx' } },
    };
    const b: DriftIdentity = {
      ownSubset: 'o',
      ports: { 'p/a': '1', 'p/b': '2' },
      aspects: { x: { meta: 'mx' }, y: { meta: 'my', tier: 'ty' } },
    };
    expect(serializeIdentity(a)).toBe(serializeIdentity(b));
  });

  it('canonical hash reacts to a change in each identity section independently', () => {
    const base = computeCanonicalHash({}, IDENT);
    expect(computeCanonicalHash({}, { ...IDENT, ownSubset: 'x' })).not.toBe(base);
    expect(computeCanonicalHash({}, { ...IDENT, ports: { 'svc/a': 'pa' } })).not.toBe(base);
    expect(
      computeCanonicalHash({}, {
        ...IDENT,
        aspects: { ...IDENT.aspects, alpha: { meta: 'ma-changed' } },
      }),
    ).not.toBe(base);
  });

  it('a tier change is detectable; an absent tier differs from a present one', () => {
    const withTier: DriftIdentity = { ownSubset: 'o', ports: {}, aspects: { a: { meta: 'm', tier: 't' } } };
    const noTier: DriftIdentity = { ownSubset: 'o', ports: {}, aspects: { a: { meta: 'm' } } };
    expect(computeCanonicalHash({}, withTier)).not.toBe(computeCanonicalHash({}, noTier));
  });

  it('checkTouched={} (empty map) is DISTINCT from an absent checkTouched', () => {
    // serializeAspectIdentity only emits the checkTouched segment when the field
    // is `!== undefined`. An empty map therefore adds `checkTouched={}` to the
    // line, while an absent field omits it entirely → distinct hashes. This is
    // deliberate domain optionality (cold-start absent vs a recorded empty
    // read-set), so the two must NOT collide.
    const empty: DriftIdentity = { ownSubset: 'o', ports: {}, aspects: { a: { meta: 'm', checkTouched: {} } } };
    const absent: DriftIdentity = { ownSubset: 'o', ports: {}, aspects: { a: { meta: 'm' } } };
    expect(computeCanonicalHash({}, empty)).not.toBe(computeCanonicalHash({}, absent));
  });

  it('checkTouched is order-independent over its entries', () => {
    const a: DriftIdentity = {
      ownSubset: 'o', ports: {},
      aspects: { x: { meta: 'm', checkTouched: { 'p1': 'h1', 'p2': 'h2' } } },
    };
    const b: DriftIdentity = {
      ownSubset: 'o', ports: {},
      aspects: { x: { meta: 'm', checkTouched: { 'p2': 'h2', 'p1': 'h1' } } },
    };
    expect(computeCanonicalHash({}, a)).toBe(computeCanonicalHash({}, b));
  });
});

// ───────────────────────────────────────────────────────────────────────────
// I4 — mtime is NEVER folded into the canonical hash.
// ───────────────────────────────────────────────────────────────────────────
describe('I4 mtime is never an input to the canonical hash', () => {
  it('changing only a file mtime (content untouched) keeps the canonical hash', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'b3-i4-mtime-'));
    try {
      const fp = path.join(dir, 'a.ts');
      await writeFile(fp, 'STABLE CONTENT', 'utf-8');
      const tf: TrackedFile[] = [{ path: 'a.ts', category: 'source', layer: 'source' }];
      const r1 = await hashTrackedFiles(dir, tf);

      // Bump only the mtime far into the future; content is identical.
      const future = new Date(Date.now() + 5 * 60_000);
      await utimes(fp, future, future);
      const r2 = await hashTrackedFiles(dir, tf);

      // mtime map reflects the change, but the canonical hash does NOT.
      expect(r2.fileMtimes['a.ts']).not.toBe(r1.fileMtimes['a.ts']);
      expect(r2.canonicalHash).toBe(r1.canonicalHash);
      expect(r2.fileHashes['a.ts']).toBe(r1.fileHashes['a.ts']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('two stored baselines with different mtimes but identical files+identity fold equal', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'b3-i4-stored-'));
    try {
      const fp = path.join(dir, 'a.ts');
      await writeFile(fp, 'CONTENT', 'utf-8');
      const tf: TrackedFile[] = [{ path: 'a.ts', category: 'source', layer: 'source' }];
      const base = await hashTrackedFiles(dir, tf);

      // Stored data with a deliberately WRONG mtime but the correct hash. With
      // reuseByMtime=false the gate ignores the mtime entirely and re-hashes.
      const stored = {
        hashes: base.fileHashes,
        mtimes: { 'a.ts': base.fileMtimes['a.ts'] + 999_999 },
      };
      const recheck = await hashTrackedFiles(dir, tf, stored, [], undefined, undefined, false);
      expect(recheck.canonicalHash).toBe(base.canonicalHash);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// I5 — reuseByMtime gate: approve reuses by mtime; check ALWAYS re-hashes.
// ───────────────────────────────────────────────────────────────────────────
describe('I5 reuseByMtime gate — content edit with forged mtime', () => {
  it('approve path reuses stale hash; check path re-hashes the tampered content', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'b3-i5-gate-'));
    try {
      const fp = path.join(dir, 'source.ts');
      await writeFile(fp, 'export const x = 1;', 'utf-8');
      const tf: TrackedFile[] = [{ path: 'source.ts', category: 'source', layer: 'source' }];

      const baseline = await hashTrackedFiles(dir, tf);
      const storedHash = baseline.fileHashes['source.ts'];

      // Tamper content, then forge the stored mtime to equal the new on-disk
      // mtime — the touch-mtime exploit (`touch -r`): an attacker editing code
      // and restoring the recorded timestamp.
      await writeFile(fp, 'export const x = 999; // tampered', 'utf-8');
      const onDiskMtime = (await stat(fp)).mtimeMs;
      const stored = {
        hashes: { 'source.ts': storedHash },
        mtimes: { 'source.ts': onDiskMtime }, // forged: stored == on-disk
      };

      // approve path (reuseByMtime=true): trusts the matching mtime, reuses stale
      const approve = await hashTrackedFiles(dir, tf, stored, [], undefined, undefined, true);
      expect(approve.fileHashes['source.ts']).toBe(storedHash);

      // check gate (reuseByMtime=false): re-reads disk, exposes the tamper
      const check = await hashTrackedFiles(dir, tf, stored, [], undefined, undefined, false);
      expect(check.fileHashes['source.ts']).toBe(hashString('export const x = 999; // tampered'));
      expect(check.fileHashes['source.ts']).not.toBe(storedHash);
      expect(check.canonicalHash).not.toBe(baseline.canonicalHash);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reuseByMtime=false leaves a genuinely-unchanged file green (no false drift)', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'b3-i5-clean-'));
    try {
      const fp = path.join(dir, 'clean.ts');
      await writeFile(fp, 'export const clean = true;', 'utf-8');
      const tf: TrackedFile[] = [{ path: 'clean.ts', category: 'source', layer: 'source' }];
      const base = await hashTrackedFiles(dir, tf);
      const stored = { hashes: base.fileHashes, mtimes: base.fileMtimes };
      const recheck = await hashTrackedFiles(dir, tf, stored, [], undefined, undefined, false);
      expect(recheck.canonicalHash).toBe(base.canonicalHash);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// I6 — empty / identity inputs.
// ───────────────────────────────────────────────────────────────────────────
describe('I6 empty and identity inputs', () => {
  it('the fully-empty fold is deterministic and reproduces', () => {
    const a = computeCanonicalHash({}, EMPTY_IDENTITY, {});
    const b = computeCanonicalHash({}, EMPTY_IDENTITY, {});
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
  });

  it('omitted verdicts equals an explicit empty verdict set', () => {
    expect(computeCanonicalHash({}, EMPTY_IDENTITY)).toBe(
      computeCanonicalHash({}, EMPTY_IDENTITY, {}),
    );
  });

  it('an empty verdict set differs from a single-verdict set (empty section is present, not skipped)', () => {
    const files = { 'src/a.ts': hashString('a') };
    expect(computeCanonicalHash(files, EMPTY_IDENTITY, {})).not.toBe(
      computeCanonicalHash(files, EMPTY_IDENTITY, { a: { verdict: 'approved' } }),
    );
  });

  it('the empty fold differs from any non-empty file/identity/verdict fold', () => {
    const empty = computeCanonicalHash({}, EMPTY_IDENTITY, {});
    expect(computeCanonicalHash({ f: hashString('x') }, EMPTY_IDENTITY, {})).not.toBe(empty);
    expect(computeCanonicalHash({}, { ...EMPTY_IDENTITY, ownSubset: 'nonempty' }, {})).not.toBe(empty);
    expect(computeCanonicalHash({}, EMPTY_IDENTITY, { a: { verdict: 'approved' } })).not.toBe(empty);
  });

  it('hashTrackedFiles over zero tracked files matches the empty pure fold', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'b3-i6-empty-'));
    try {
      const { canonicalHash, fileHashes } = await hashTrackedFiles(dir, []);
      expect(fileHashes).toEqual({});
      expect(canonicalHash).toBe(computeCanonicalHash({}, EMPTY_IDENTITY, {}));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// E2E — drive the canonical-hash + reuseByMtime gate through the real binary.
// The in-process mock answers the enforced LLM aspect (has-doc-comment); the
// deterministic aspects run locally. spawnSync would deadlock the in-process
// mock, so we use the async runAsync helper (per support/mock-reviewer.ts).
// ───────────────────────────────────────────────────────────────────────────
describe.skipIf(!distExists)('E2E — yg check gate over the canonical hash', () => {
  /** Fresh git-backed copy of the lifecycle fixture with the reviewer pointed at `endpoint`. */
  function fixtureRepo(label: string, endpoint: string): string {
    const dir = mkdtempSync(path.join(tmpdir(), `b3-e2e-${label}-`));
    cpSync(FIXTURE, dir, { recursive: true });
    const cfg = path.join(dir, '.yggdrasil', 'yg-config.yaml');
    writeFileSync(
      cfg,
      readFileSync(cfg, 'utf-8').replace(
        /endpoint:\s*["']?[^"'\n]+["']?/,
        `endpoint: "${endpoint}"`,
      ),
      'utf-8',
    );
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('git', ['add', '-A'], { cwd: dir });
    execFileSync('git', ['-c', 'user.email=a@b.c', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: dir });
    return dir;
  }

  it('approve both nodes → clean check (0); edit content → drift (1); revert → clean (0)', async () => {
    const mock = await startMockReviewer({ respond: () => ({ satisfied: true, reason: 'ok' }) });
    const dir = fixtureRepo('lifecycle', mock.endpoint);
    try {
      const approve = await runAsync(
        ['approve', '--node', 'services/orders', '--node', 'services/payments'],
        dir,
      );
      expect(approve.status).toBe(0);

      const clean = await runAsync(['check'], dir);
      expect(clean.status).toBe(0);
      expect(clean.all).toContain('PASS');

      // Content edit → the check gate re-hashes and reports source drift.
      const orders = path.join(dir, 'src', 'services', 'orders.ts');
      const original = readFileSync(orders, 'utf-8');
      writeFileSync(orders, original + '\n// e2e edit\n', 'utf-8');
      const drifted = await runAsync(['check'], dir);
      expect(drifted.status).toBe(1);
      expect(drifted.all).toContain('services/orders');
      expect(/Source files changed/.test(drifted.all)).toBe(true);

      // Reverting to byte-identical content clears the drift — the canonical
      // hash is purely content (+ identity + verdict) based, not mtime based.
      writeFileSync(orders, original, 'utf-8');
      const reverted = await runAsync(['check'], dir);
      expect(reverted.status).toBe(0);
    } finally {
      await mock.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('touch-mtime exploit: content edit + forged baseline mtime is STILL detected by yg check', async () => {
    const mock = await startMockReviewer({ respond: () => ({ satisfied: true, reason: 'ok' }) });
    const dir = fixtureRepo('exploit', mock.endpoint);
    try {
      await runAsync(['approve', '--node', 'services/orders', '--node', 'services/payments'], dir);
      const clean = await runAsync(['check'], dir);
      expect(clean.status).toBe(0);

      const orders = path.join(dir, 'src', 'services', 'orders.ts');
      const baselinePath = path.join(dir, '.yggdrasil', '.drift-state', 'services', 'orders.json');
      expect(existsSync(baselinePath)).toBe(true);

      // Tamper the source AND forge the stored mtime in the committed baseline to
      // match the on-disk mtime — exactly the `touch -r` exploit that would fool
      // an mtime-trusting gate.
      writeFileSync(orders, readFileSync(orders, 'utf-8') + '\n// tampered\n', 'utf-8');
      const onDisk = statSync(orders).mtimeMs;
      const baseline = JSON.parse(readFileSync(baselinePath, 'utf-8')) as {
        mtimes: Record<string, number>;
      };
      baseline.mtimes['src/services/orders.ts'] = onDisk;
      writeFileSync(baselinePath, JSON.stringify(baseline), 'utf-8');

      // The check gate uses reuseByMtime=false → re-hashes content → drift wins.
      const result = await runAsync(['check'], dir);
      expect(result.status).toBe(1);
      expect(result.all).toContain('services/orders');
    } finally {
      await mock.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
