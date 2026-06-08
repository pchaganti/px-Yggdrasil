import { describe, it, expect, afterEach } from 'vitest';
import { execSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { validateAppendOnly } from '../../../src/core/log-integrity.js';
import { validateFormat } from '../../../src/core/log-format.js';
import { parseLog } from '../../../src/core/parsing/log-parser.js';
import { loadGraph } from '../../../src/core/graph-loader.js';
import { logMergeResolve } from '../../../src/core/log/log-merge-resolve.js';
import { readNodeDriftState, writeNodeDriftState } from '../../../src/io/drift-state-store.js';
import { DRIFT_STATE_SCHEMA_VERSION } from '../../../src/model/drift.js';

// ---------------------------------------------------------------------------
// HERMETICITY
//
// Every test here is LLM-independent, network-free and clock-free in its
// assertions. The pure-function suites (validateAppendOnly, validateFormat,
// parseLog) take in-memory strings. The merge-resolve suites build throwaway
// git repos under mkdtemp (no remote, no fetch). The single E2E test spawns the
// real binary against a copy of the committed e2e-lifecycle fixture and only
// exercises `yg log` (add/read/merge-resolve) — never the reviewer — so no
// provider endpoint is dialed. All temp dirs are tracked and removed in
// afterEach; the committed fixture bytes are never mutated.
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'e2e-lifecycle');
const distExists = existsSync(BIN_PATH);

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

function sha256(s: string): string {
  return createHash('sha256').update(Buffer.from(s, 'utf-8')).digest('hex');
}

// ===========================================================================
// validateAppendOnly — invariants the existing suite does NOT cover.
//
// The existing test file covers: ok / appended / boundary_missing /
// prefix_modified / trailing-newline-in-prefix / empty-with-baseline.
// The high-value gaps below are: REORDERING, INSERT-BEFORE-BOUNDARY, UTF-8
// byte-offset correctness, tampered (non-strict) stored datetime, and the
// fence-awareness invariant shared with parseLog.
// ===========================================================================

describe('validateAppendOnly — adversarial integrity invariants', () => {
  const e1 = '## [2026-05-11T14:23:00.000Z]\nFirst.\n';
  const e2 = '## [2026-05-11T14:24:00.000Z]\nSecond.\n';
  const e3 = '## [2026-05-11T14:25:00.000Z]\nThird.\n';

  it('INVARIANT: reordering two pre-baseline entries is detected (prefix bytes change)', () => {
    // Baseline boundary = e3 (the last entry). The hashed prefix is e1+e2+e3.
    // Swapping e1 and e2 keeps every datetime present (so boundary is still
    // found) but the prefix BYTES differ → must be prefix_modified, not ok.
    const original = e1 + e2 + e3;
    const stored = sha256(original);
    const reordered = e2 + e1 + e3;
    const result = validateAppendOnly(reordered, '2026-05-11T14:25:00.000Z', stored);
    expect(result).toEqual({ ok: false, reason: 'prefix_modified' });
  });

  it('INVARIANT: inserting a NEW entry before the baseline boundary is detected', () => {
    // Baseline = e2. Inserting e_extra between e1 and e2 shifts e2 deeper into
    // the file; the prefix [0..e2.offsetEnd) now contains the injected entry, so
    // the hash differs. Drift must not silently go green.
    const original = e1 + e2;
    const stored = sha256(original);
    const eExtra = '## [2026-05-11T14:23:30.000Z]\nInjected.\n';
    const tampered = e1 + eExtra + e2;
    const result = validateAppendOnly(tampered, '2026-05-11T14:24:00.000Z', stored);
    expect(result).toEqual({ ok: false, reason: 'prefix_modified' });
  });

  it('INVARIANT: deleting the entry just before the boundary is detected', () => {
    // Baseline = e3. Removing e2 (a prior, non-boundary entry) shrinks the
    // prefix → prefix_modified. The boundary datetime still exists.
    const original = e1 + e2 + e3;
    const stored = sha256(original);
    const withDeletion = e1 + e3;
    const result = validateAppendOnly(withDeletion, '2026-05-11T14:25:00.000Z', stored);
    expect(result).toEqual({ ok: false, reason: 'prefix_modified' });
  });

  it('INVARIANT: hash is over UTF-8 BYTES — a multibyte body before boundary hashes correctly', () => {
    // Body contains characters that are multi-byte in UTF-8 (emoji + CJK). The
    // prefix offset is a BYTE offset; if the implementation sliced by chars the
    // boundary would land mid-codepoint and the hash would mismatch on an
    // otherwise-unchanged file. This asserts byte-correctness end to end.
    const eUtf = '## [2026-05-11T14:23:00.000Z]\nBody with 😀 and 漢字 multibyte.\n';
    const content = eUtf + e2;
    const stored = sha256(eUtf);
    const result = validateAppendOnly(content, '2026-05-11T14:23:00.000Z', stored);
    expect(result).toEqual({ ok: true });
  });

  it('INVARIANT: a single byte flipped inside a multibyte body trips prefix_modified', () => {
    const eUtf = '## [2026-05-11T14:23:00.000Z]\nBody with 😀 unchanged.\n';
    const stored = sha256(eUtf);
    const tampered = '## [2026-05-11T14:23:00.000Z]\nBody with 🙃 swapped emoji.\n' + e2;
    const result = validateAppendOnly(tampered, '2026-05-11T14:23:00.000Z', stored);
    expect(result).toEqual({ ok: false, reason: 'prefix_modified' });
  });

  it('INVARIANT: a tampered (non-strict ISO) stored datetime is rejected up front', () => {
    // Defense in depth: even if the file legitimately contains a matching
    // header, a stored baseline datetime that is not strict ISO must never
    // validate (it indicates a tampered/forged drift-state).
    const content = '## [2026-05-11T14:23:00Z]\nFirst.\n';
    // stored datetime lacks milliseconds → DATETIME_STRICT fails → boundary_missing
    const result = validateAppendOnly(content, '2026-05-11T14:23:00Z', sha256(content));
    expect(result).toEqual({ ok: false, reason: 'boundary_missing' });
  });

  it('INVARIANT: a header that only exists INSIDE a code fence is not a valid boundary', () => {
    // The boundary datetime appears, but only as text inside an open ``` fence.
    // parseLog (and therefore validateAppendOnly) must treat it as body, not a
    // header, so the boundary is NOT found → boundary_missing. If fence-awareness
    // were inconsistent here an attacker could hide the real history.
    const fenced =
      '## [2026-05-11T14:20:00.000Z]\n' +
      '```\n' +
      '## [2026-05-11T14:23:00.000Z]\n' +
      '```\n';
    const result = validateAppendOnly(fenced, '2026-05-11T14:23:00.000Z', sha256(fenced));
    expect(result).toEqual({ ok: false, reason: 'boundary_missing' });
  });

  it('byte-offset of a real boundary that follows a fenced pseudo-header is correct', () => {
    // The fenced "## [..]" line is body of e1; the REAL boundary is the strict
    // datetime header after the fence closes. Hash over [0..boundary.offsetEnd)
    // must include the whole fenced block.
    const e1Fenced =
      '## [2026-05-11T14:23:00.000Z]\n' +
      '```\n' +
      '## [9999-01-01T00:00:00.000Z]\n' +
      '```\n';
    const content = e1Fenced + e2;
    const result = validateAppendOnly(content, '2026-05-11T14:24:00.000Z', sha256(content));
    expect(result).toEqual({ ok: true });
  });
});

// ===========================================================================
// validateFormat — body level-2-header detection edge cases the suite misses.
// ===========================================================================

describe('validateFormat — level-2 / ordering edge cases', () => {
  it('a bare `##` (no trailing space) in body is NOT a level-2 header violation', () => {
    // The detector keys on the literal `## ` prefix (with space). A line of just
    // `##` or `##x` is not a markdown ATX H2 and must not false-positive.
    const content = '## [2026-05-11T14:23:00.123Z]\nbody\n##\n##notaheading\n';
    const v = validateFormat(content);
    expect(v.find((x) => x.reason === 'level2_header_in_body')).toBeUndefined();
  });

  it('a level-3 (`### `) header in body is allowed', () => {
    const content = '## [2026-05-11T14:23:00.123Z]\nintro\n### subsection\nmore\n';
    const v = validateFormat(content);
    expect(v.find((x) => x.reason === 'level2_header_in_body')).toBeUndefined();
  });

  it('equal consecutive datetimes raise BOTH duplicate_datetime and out_of_order', () => {
    // `<=` ordering check fires on equality too; the same line is a duplicate.
    const content =
      '## [2026-05-11T14:23:00.000Z]\na.\n' +
      '## [2026-05-11T14:23:00.000Z]\nb.\n';
    const v = validateFormat(content);
    expect(v.find((x) => x.reason === 'duplicate_datetime')).toBeDefined();
    expect(v.find((x) => x.reason === 'out_of_order')).toBeDefined();
  });

  it('a `## [date]` header INSIDE a fence does not participate in ordering checks', () => {
    // The fenced header looks earlier-dated but is body text; it must not be
    // parsed as an entry, so no out_of_order even though its datetime < real one.
    const content =
      '## [2026-05-11T14:24:00.000Z]\n' +
      '```\n' +
      '## [2026-05-11T10:00:00.000Z]\n' +
      '```\n';
    const v = validateFormat(content);
    expect(v.find((x) => x.reason === 'out_of_order')).toBeUndefined();
    expect(v.find((x) => x.reason === 'duplicate_datetime')).toBeUndefined();
  });

  it('first line being a fence open raises invalid_start (it is not a header)', () => {
    const content = '```\ncode\n```\n';
    const v = validateFormat(content);
    expect(v.find((x) => x.reason === 'invalid_start')).toBeDefined();
  });

  it('parseLog and validateFormat agree on entry count for fenced pseudo-headers', () => {
    // One real entry whose body contains a fenced "## [..]" line. parseLog must
    // see exactly ONE entry — the invariant that the two readers agree.
    const content =
      '## [2026-05-11T14:23:00.000Z]\n' +
      '```\n' +
      '## [2026-05-11T14:24:00.000Z]\n' +
      '```\n';
    expect(parseLog(content)).toHaveLength(1);
    expect(validateFormat(content).find((x) => x.reason === 'out_of_order')).toBeUndefined();
  });
});

// ===========================================================================
// merge-resolve — convergent union, no-op merge, and baseline-write invariants
// not exercised by the existing core suite.
// ===========================================================================

const ANCESTOR_LOG = '## [2026-05-11T10:00:00.000Z]\nbase.\n';
const P1_NEW = '## [2026-05-11T11:00:00.000Z]\nfeat1.\n';
const P2_NEW = '## [2026-05-11T12:00:00.000Z]\nfeat2.\n';

interface MergeRepo {
  projectRoot: string;
  nodePath: string;
}

/**
 * Build a throwaway git repo: ancestor log entry on `billing`, two divergent
 * branches each appending one entry (parent1Add / parent2Add), merged with
 * `resolvedLog` written into log.md and committed as a merge commit.
 */
async function setupMergeRepo(opts: {
  ancestor?: string;
  parent1Add?: string;
  parent2Add?: string;
  resolved: string;
}): Promise<MergeRepo> {
  const ancestor = opts.ancestor ?? ANCESTOR_LOG;
  const repo = await mkdtemp(path.join(tmpdir(), 'yg-b3merge-'));
  dirs.push(repo);
  const r = (cmd: string) => execSync(cmd, { cwd: repo, stdio: 'pipe' });
  r('git init -q -b main');
  r('git config user.email t@t.test');
  r('git config user.name Test');
  const nodeDir = path.join(repo, '.yggdrasil', 'model', 'billing');
  await mkdir(nodeDir, { recursive: true });
  await writeFile(path.join(nodeDir, 'yg-node.yaml'), 'name: billing\ntype: module\ndescription: x\n');
  await writeFile(path.join(nodeDir, 'log.md'), ancestor);
  r('git add -A && git commit -qm ancestor');

  // --allow-empty so a branch that leaves the log unchanged still produces a
  // distinct commit (needed for the no-op / one-sided merge scenarios).
  r('git checkout -qb feat1');
  await writeFile(path.join(nodeDir, 'log.md'), ancestor + (opts.parent1Add ?? ''));
  r('git add -A && git commit -q --allow-empty -m feat1');

  r('git checkout -q main && git checkout -qb feat2 main');
  await writeFile(path.join(nodeDir, 'log.md'), ancestor + (opts.parent2Add ?? ''));
  r('git add -A && git commit -q --allow-empty -m feat2');

  r('git merge --no-commit --no-ff feat1 -q || true');
  await writeFile(path.join(nodeDir, 'log.md'), opts.resolved);
  r('git add -A');
  r('git commit -q --allow-empty -m "merge feat1 into feat2"');

  return { projectRoot: repo, nodePath: 'billing' };
}

describe('logMergeResolve — convergent / no-op / baseline invariants', () => {
  it('INVARIANT: accepts a CONVERGENT entry added IDENTICALLY on both branches (deduped union)', async () => {
    // Both feat1 and feat2 add the exact same entry (same datetime + body). The
    // resolved log should contain it ONCE. Content-hash dedupe must accept this:
    // every parent-new entry is present, and the single result entry originates
    // from a parent. A naive count-based union check would reject this.
    const same = '## [2026-05-11T11:00:00.000Z]\nidentical decision on both branches.\n';
    const { projectRoot, nodePath } = await setupMergeRepo({
      parent1Add: same,
      parent2Add: same,
      resolved: ANCESTOR_LOG + same,
    });
    const graph = await loadGraph(projectRoot, { tolerateInvalidConfig: true });
    const result = await logMergeResolve({ graph, nodePath, repoRoot: projectRoot });
    expect(result.ok).toBe(true);
  });

  it('INVARIANT: a NO-OP merge (neither branch added entries) resolving to the ancestor is accepted', async () => {
    // Both branches leave the log untouched. The "new" slice on every side is
    // empty; resolved == ancestor. Nothing to union → ok, and a baseline is
    // written.
    const { projectRoot, nodePath } = await setupMergeRepo({
      parent1Add: '',
      parent2Add: '',
      resolved: ANCESTOR_LOG,
    });
    const graph = await loadGraph(projectRoot, { tolerateInvalidConfig: true });
    const result = await logMergeResolve({ graph, nodePath, repoRoot: projectRoot });
    expect(result.ok).toBe(true);
  });

  it('INVARIANT: one-sided merge (only feat1 added an entry) is accepted', async () => {
    const { projectRoot, nodePath } = await setupMergeRepo({
      parent1Add: P1_NEW,
      parent2Add: '',
      resolved: ANCESTOR_LOG + P1_NEW,
    });
    const graph = await loadGraph(projectRoot, { tolerateInvalidConfig: true });
    const result = await logMergeResolve({ graph, nodePath, repoRoot: projectRoot });
    expect(result.ok).toBe(true);
  });

  it('INVARIANT: a successful merge-resolve writes a baseline whose prefix_hash covers the WHOLE file', async () => {
    const resolved = ANCESTOR_LOG + P1_NEW + P2_NEW;
    const { projectRoot, nodePath } = await setupMergeRepo({
      parent1Add: P1_NEW,
      parent2Add: P2_NEW,
      resolved,
    });
    const graph = await loadGraph(projectRoot, { tolerateInvalidConfig: true });
    const result = await logMergeResolve({ graph, nodePath, repoRoot: projectRoot });
    expect(result.ok).toBe(true);

    const yggRoot = path.join(projectRoot, '.yggdrasil');
    const state = await readNodeDriftState(yggRoot, nodePath);
    expect(state).not.toBeNull();
    // Baseline must equal a hash over the entire resolved file and name the last
    // entry. This is what makes a SUBSEQUENT validateAppendOnly call green over
    // the merged history without re-approval.
    expect(state!.log).toEqual({
      last_entry_datetime: '2026-05-11T12:00:00.000Z',
      prefix_hash: sha256(resolved),
    });

    // Cross-check: the written baseline validates against the resolved content.
    const integrity = validateAppendOnly(resolved, '2026-05-11T12:00:00.000Z', state!.log!.prefix_hash);
    expect(integrity).toEqual({ ok: true });
  });

  it('INVARIANT: merge-resolve preserves a prior baseline\'s non-log fields (spreads stored state)', async () => {
    const resolved = ANCESTOR_LOG + P1_NEW + P2_NEW;
    const { projectRoot, nodePath } = await setupMergeRepo({
      parent1Add: P1_NEW,
      parent2Add: P2_NEW,
      resolved,
    });
    const yggRoot = path.join(projectRoot, '.yggdrasil');
    await writeNodeDriftState(yggRoot, nodePath, {
      schemaVersion: DRIFT_STATE_SCHEMA_VERSION,
      hash: 'preserve-me',
      files: { 'src/x.ts': 'deadbeef' },
      identity: { ownSubset: 'os', ports: {}, aspects: {} },
      aspectVerdicts: {},
      log: { last_entry_datetime: '2026-05-11T10:00:00.000Z', prefix_hash: sha256(ANCESTOR_LOG) },
    });
    const graph = await loadGraph(projectRoot, { tolerateInvalidConfig: true });
    const result = await logMergeResolve({ graph, nodePath, repoRoot: projectRoot });
    expect(result.ok).toBe(true);

    const state = await readNodeDriftState(yggRoot, nodePath);
    expect(state!.hash).toBe('preserve-me');
    expect(state!.files).toEqual({ 'src/x.ts': 'deadbeef' });
    // log baseline advanced to the merged file.
    expect(state!.log).toEqual({
      last_entry_datetime: '2026-05-11T12:00:00.000Z',
      prefix_hash: sha256(resolved),
    });
  });

  it('rejects a SWAP of the two new entries (out of chronological order) even though both are present', async () => {
    // Both feat1 and feat2 are present and unaltered, but placed newest-first in
    // the new section. Union matching passes; the chronological-order guard must
    // still reject.
    const swapped = ANCESTOR_LOG + P2_NEW + P1_NEW;
    const { projectRoot, nodePath } = await setupMergeRepo({
      parent1Add: P1_NEW,
      parent2Add: P2_NEW,
      resolved: swapped,
    });
    const graph = await loadGraph(projectRoot, { tolerateInvalidConfig: true });
    const result = await logMergeResolve({ graph, nodePath, repoRoot: projectRoot });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.what).toContain('chronological');
  });

  it('rejects when an ancestor entry was DROPPED (prefix shorter than ancestor)', async () => {
    // The resolved log loses the ancestor entry entirely. Since currentBytes is
    // shorter than ancestorBytes (or the prefix differs) this is the
    // ancestor-prefix guard, not the union guard.
    const { projectRoot, nodePath } = await setupMergeRepo({
      parent1Add: P1_NEW,
      parent2Add: P2_NEW,
      resolved: P1_NEW + P2_NEW, // ancestor entry removed from the front
    });
    const graph = await loadGraph(projectRoot, { tolerateInvalidConfig: true });
    const result = await logMergeResolve({ graph, nodePath, repoRoot: projectRoot });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.what).toContain('ancestor prefix');
  });
});

// ===========================================================================
// E2E — spawn the real binary against a copy of the e2e-lifecycle fixture and
// verify a hand-concatenated log fails merge-resolve integrity, plus a clean
// union passes. Exercises ONLY `yg log` (no reviewer).
// ===========================================================================

describe.skipIf(!distExists)('E2E — yg log merge-resolve via real binary', () => {
  const ordersLog = (dir: string) =>
    path.join(dir, '.yggdrasil', 'model', 'services', 'orders', 'log.md');

  function git(repo: string, cmd: string): void {
    execSync(`git ${cmd}`, { cwd: repo, stdio: 'pipe' });
  }

  /** Build a merge repo seeded with the fixture graph; resolve with `resolved`. */
  async function buildE2EMergeRepo(label: string, resolved: string): Promise<string> {
    const repo = await mkdtemp(path.join(tmpdir(), `yg-b3e2e-${label}-`));
    dirs.push(repo);
    execSync(`cp -R "${FIXTURE}/." "${repo}"`, { stdio: 'pipe' });
    const logPath = ordersLog(repo);
    await mkdir(path.dirname(logPath), { recursive: true });

    git(repo, 'init -q -b main');
    git(repo, 'config user.email t@t.test');
    git(repo, 'config user.name Test');

    await writeFile(logPath, ANCESTOR_LOG, 'utf-8');
    git(repo, 'add -A');
    git(repo, 'commit -qm ancestor');

    git(repo, 'checkout -qb feat1');
    await writeFile(logPath, ANCESTOR_LOG + P1_NEW, 'utf-8');
    git(repo, 'add -A');
    git(repo, 'commit -qm feat1');

    git(repo, 'checkout -q main');
    git(repo, 'checkout -qb feat2 main');
    await writeFile(logPath, ANCESTOR_LOG + P2_NEW, 'utf-8');
    git(repo, 'add -A');
    git(repo, 'commit -qm feat2');

    try {
      git(repo, 'merge --no-commit --no-ff feat1 -q');
    } catch {
      /* expected conflict — resolved by hand below */
    }
    await writeFile(logPath, resolved, 'utf-8');
    git(repo, 'add -A');
    git(repo, 'commit -qm "merge feat1 into feat2"');
    return repo;
  }

  function run(args: string[], cwd: string) {
    const result = spawnSync('node', [BIN_PATH, ...args], { cwd, encoding: 'utf-8' });
    return {
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      status: result.status,
      all: (result.stdout ?? '') + (result.stderr ?? ''),
    };
  }

  it('accepts a clean union merge (exit 0) and reports the baseline update', async () => {
    const repo = await buildE2EMergeRepo('union', ANCESTOR_LOG + P1_NEW + P2_NEW);
    const { status, all } = run(['log', 'merge-resolve', '--node', 'services/orders'], repo);
    expect(status).toBe(0);
    expect(all).toContain('Merge-resolve verified');
    expect(all).toContain('Log baseline updated');
  });

  it('INVARIANT: a HAND-CONCATENATED log (both full branch logs glued) fails integrity (exit 1)', async () => {
    // A naive resolver pastes parent1's full log then parent2's full log, which
    // DUPLICATES the ancestor entry in the body. That makes the byte prefix
    // diverge from the merge-base ancestor → ancestor-prefix rejection. This is
    // exactly the "do NOT manually concatenate the two log histories" hazard.
    const handConcatenated = (ANCESTOR_LOG + P1_NEW) + (ANCESTOR_LOG + P2_NEW);
    const repo = await buildE2EMergeRepo('concat', handConcatenated);
    const { status, all } = run(['log', 'merge-resolve', '--node', 'services/orders'], repo);
    expect(status).toBe(1);
    // The duplicated ancestor pushes a second `## [10:00:00]` into what should be
    // the new section; depending on where the prefix first diverges this is
    // surfaced as either the ancestor-prefix guard or the union guard. Both are
    // integrity failures; assert it is NOT silently accepted.
    expect(all.toLowerCase()).toMatch(/ancestor|missing|fabricat|not present|chronological/);
  });
});
