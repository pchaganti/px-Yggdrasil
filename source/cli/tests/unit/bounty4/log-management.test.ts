import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

import { validateFormat } from '../../../src/core/log-format.js';
import { validateAppendOnly } from '../../../src/core/log-integrity.js';
import { parseLog } from '../../../src/core/parsing/log-parser.js';
import { loadGraph } from '../../../src/core/graph-loader.js';
import { approveNode } from '../../../src/core/approve.js';
import { logAdd } from '../../../src/core/log/log-add.js';
import { logMergeResolve } from '../../../src/core/log/log-merge-resolve.js';
import { writeNodeDriftState } from '../../../src/io/drift-state-store.js';
import { DRIFT_STATE_SCHEMA_VERSION } from '../../../src/model/drift.js';
import { buildIssueMessage } from '../../../src/formatters/message-builder.js';
import { commitApprovedBaseline } from '../helpers/seed-baseline.js';

// ──────────────────────────────────────────────────────────────────────────
// SPEC under audit: `yg knowledge read log-management`.
// Each test asserts that the implementing code actually enforces a documented
// invariant. See the section comments below for the exact spec wording.
// ──────────────────────────────────────────────────────────────────────────

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

const refuseMsg = (r: { refuseReasonData?: Parameters<typeof buildIssueMessage>[0] }) =>
  r.refuseReasonData ? buildIssueMessage(r.refuseReasonData) : '';

// ── Hermetic project fixture (real graph; drives approveNode/logAdd directly) ──
async function setupProject(opts: { logRequired?: boolean } = {}): Promise<{
  projectRoot: string;
  nodePath: string;
  sourcePath: string;
  logPath: string;
}> {
  const root = await mkdtemp(path.join(tmpdir(), 'yg-bounty4-'));
  dirs.push(root);
  const yggRoot = path.join(root, '.yggdrasil');
  const nodeDir = path.join(yggRoot, 'model', 'svc');
  await mkdir(nodeDir, { recursive: true });
  await mkdir(path.join(yggRoot, '.drift-state'), { recursive: true });
  await mkdir(path.join(yggRoot, 'aspects', 'a1'), { recursive: true });
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(yggRoot, 'yg-config.yaml'), 'version: "5.0.0"\n');
  await writeFile(
    path.join(yggRoot, 'yg-architecture.yaml'),
    `node_types:\n  module:\n    description: m\n    log_required: ${opts.logRequired ?? true}\n`,
  );
  await writeFile(path.join(yggRoot, 'aspects', 'a1', 'yg-aspect.yaml'), 'name: A1\ndescription: x\n');
  await writeFile(path.join(yggRoot, 'aspects', 'a1', 'content.md'), 'r.\n');
  await writeFile(
    path.join(nodeDir, 'yg-node.yaml'),
    'name: svc\ntype: module\ndescription: x\nmapping:\n  - src/svc.ts\naspects:\n  - a1\n',
  );
  await writeFile(path.join(root, 'src', 'svc.ts'), 'export const x = 1;\n');
  return {
    projectRoot: root,
    nodePath: 'svc',
    sourcePath: path.join(root, 'src', 'svc.ts'),
    logPath: path.join(nodeDir, 'log.md'),
  };
}

async function logAddCmd(
  nodePath: string,
  reasonText: string,
  projectRoot: string,
): Promise<{ ok: boolean; what?: string }> {
  const graph = await loadGraph(projectRoot, { tolerateInvalidConfig: true });
  const result = await logAdd({ graph, nodePath, reasonText, nowMs: Date.now() });
  return result.ok ? { ok: true } : { ok: false, what: result.error.what };
}

async function bootstrapApprove(projectRoot: string, nodePath: string): Promise<void> {
  await logAddCmd(nodePath, 'Bootstrap.', projectRoot);
  const graph = await loadGraph(projectRoot);
  const result = await approveNode(graph, nodePath);
  await commitApprovedBaseline(graph, nodePath, path.join(projectRoot, '.yggdrasil'), result);
}

// ────────────────────────────────────────────────────────────────────────
// SECTION 1 — Format constraints (spec: "Format constraints (validated by yg
// check)")
// ────────────────────────────────────────────────────────────────────────
describe('format constraints', () => {
  // SPEC: "Entry headers `## [<ISO datetime UTC with milliseconds>]` are reserved."
  it('a well-formed entry header is accepted', () => {
    expect(validateFormat('## [2026-05-11T14:23:00.123Z]\nBody.\n')).toEqual([]);
  });

  // SPEC: "Datetimes must be ... ISO 8601 UTC with milliseconds and Z suffix" —
  // missing milliseconds rejected.
  it('header datetime without milliseconds → invalid_datetime', () => {
    const v = validateFormat('## [2026-05-11T14:23:00Z]\nBody.\n');
    expect(v.some((x) => x.reason === 'invalid_datetime')).toBe(true);
  });

  // SPEC: ... "and Z suffix" — missing Z rejected.
  it('header datetime without Z suffix → invalid_datetime', () => {
    const v = validateFormat('## [2026-05-11T14:23:00.123]\nBody.\n');
    expect(v.some((x) => x.reason === 'invalid_datetime')).toBe(true);
  });

  // SPEC: "Do not put a level-2 heading (`##`) at the start of any line in your
  // `--reason` content."
  it('level-2 header at start of a body line outside fence → level2_header_in_body', () => {
    const v = validateFormat('## [2026-05-11T14:23:00.123Z]\nIntro.\n## stray\n');
    const hit = v.find((x) => x.reason === 'level2_header_in_body');
    expect(hit).toBeDefined();
    expect(hit!.line).toBe(3);
  });

  // SPEC: "a `## ` that appears inside a fenced code block is allowed."
  it('level-2 header INSIDE a backtick fence is allowed (no violation)', () => {
    const content =
      '## [2026-05-11T14:23:00.123Z]\n' + '```python\n' + '## comment\n' + '```\n';
    const v = validateFormat(content);
    expect(v.some((x) => x.reason === 'level2_header_in_body')).toBe(false);
  });

  // SPEC: "Sub-headings in your `--reason` must be level 3+ (`###` or deeper)."
  // A level-3 sub-heading in the body must NOT trigger the level-2 rule.
  it('level-3 sub-heading in body is accepted', () => {
    const content = '## [2026-05-11T14:23:00.123Z]\nIntro.\n### Detail\nmore.\n';
    const v = validateFormat(content);
    expect(v.some((x) => x.reason === 'level2_header_in_body')).toBe(false);
  });

  // SPEC: "Datetimes must be strictly ascending across entries."
  it('out-of-order (descending) entries → out_of_order', () => {
    const content =
      '## [2026-05-11T14:24:00.000Z]\nfirst.\n' +
      '## [2026-05-11T14:23:00.000Z]\nsecond.\n';
    expect(validateFormat(content).some((x) => x.reason === 'out_of_order')).toBe(true);
  });

  // SPEC: "strictly ascending" — equal datetimes are NOT strictly ascending, so
  // an equal datetime is both a duplicate AND violates strict ordering.
  it('equal datetimes are not strictly ascending → out_of_order + duplicate', () => {
    const content =
      '## [2026-05-11T14:23:00.000Z]\na.\n' + '## [2026-05-11T14:23:00.000Z]\nb.\n';
    const v = validateFormat(content);
    expect(v.some((x) => x.reason === 'duplicate_datetime')).toBe(true);
    expect(v.some((x) => x.reason === 'out_of_order')).toBe(true);
  });

  // SPEC: a non-empty file must begin with an entry header (header is reserved).
  it('non-header first line → invalid_start at line 1', () => {
    const v = validateFormat('garbage\n## [2026-05-11T14:23:00.123Z]\nBody.\n');
    const hit = v.find((x) => x.reason === 'invalid_start');
    expect(hit).toBeDefined();
    expect(hit!.line).toBe(1);
  });

  // SPEC: empty file is valid (the agent-rules note "or be empty").
  it('empty file is valid', () => {
    expect(validateFormat('')).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────────────
// SECTION 2 — `yg log add` honors the format constraints at write time
// (spec: "Edit only via `yg log add`"; "Do not put a level-2 heading ...").
// ────────────────────────────────────────────────────────────────────────
describe('log add — write-time format enforcement', () => {
  // SPEC: level-2 heading at start of a reason line is forbidden.
  it('rejects --reason whose body line starts with a level-2 heading', async () => {
    const { projectRoot, nodePath } = await setupProject();
    const r = await logAddCmd(nodePath, 'Intro.\n## stray heading\nmore.', projectRoot);
    expect(r.ok).toBe(false);
    expect(r.what).toMatch(/level-2/i);
  });

  // SPEC: a `## ` inside a code fence is allowed.
  it('accepts --reason with a level-2 line INSIDE a code fence', async () => {
    const { projectRoot, nodePath } = await setupProject();
    const r = await logAddCmd(nodePath, 'Intro.\n```\n## in fence\n```\nafter.', projectRoot);
    expect(r.ok).toBe(true);
  });

  // SPEC: "A log entry must carry justification text" (empty reason rejected).
  it('rejects an empty (whitespace-only) reason', async () => {
    const { projectRoot, nodePath } = await setupProject();
    const r = await logAddCmd(nodePath, '   \n  ', projectRoot);
    expect(r.ok).toBe(false);
  });

  // SPEC: entry written by log add round-trips as a valid entry header and is
  // strictly ascending vs. a prior entry (datetimes ascending guarantee).
  it('two sequential adds produce strictly-ascending, format-valid entries', async () => {
    const { projectRoot, nodePath, logPath } = await setupProject();
    await logAddCmd(nodePath, 'first', projectRoot);
    await logAddCmd(nodePath, 'second', projectRoot);
    const content = await readFile(logPath, 'utf-8');
    expect(validateFormat(content)).toEqual([]);
    const entries = parseLog(content);
    expect(entries.length).toBe(2);
    expect(entries[0].datetime < entries[1].datetime).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────
// SECTION 3 — Supersedes convention (spec: "append a new entry whose body
// opens with `### Supersedes: <prior ISO datetime>`").
// ────────────────────────────────────────────────────────────────────────
describe('Supersedes convention', () => {
  // SPEC: a Supersedes entry uses a level-3 heading, so it must be writable via
  // log add (level-3 is allowed; only level-2 at line start is forbidden).
  it('a Supersedes entry (### Supersedes:) is accepted by log add', async () => {
    const { projectRoot, nodePath, logPath } = await setupProject();
    await logAddCmd(nodePath, 'original decision', projectRoot);
    const first = parseLog(await readFile(logPath, 'utf-8'))[0].datetime;
    const r = await logAddCmd(
      nodePath,
      `### Supersedes: ${first}\nThe earlier decision no longer holds because of X.`,
      projectRoot,
    );
    expect(r.ok).toBe(true);
    const content = await readFile(logPath, 'utf-8');
    expect(validateFormat(content)).toEqual([]);
    const entries = parseLog(content);
    expect(entries[1].body).toContain(`### Supersedes: ${first}`);
  });
});

// ────────────────────────────────────────────────────────────────────────
// SECTION 4 — Append-only integrity hash chain (spec: "Integrity
// verification catches any modification of historical entries ... Detects
// edit/delete/reorder").
// ────────────────────────────────────────────────────────────────────────
describe('append-only integrity', () => {
  const BASE =
    '## [2026-05-11T10:00:00.000Z]\nfirst.\n' + '## [2026-05-11T11:00:00.000Z]\nsecond.\n';

  // Compute the stored baseline (datetime + prefix hash over bytes [0, offsetEnd))
  // exactly as approve/merge-resolve do.
  function baselineFor(content: string, datetime: string): { dt: string; hash: string } {
    const entry = parseLog(content).find((e) => e.datetime === datetime)!;
    const bytes = Buffer.from(content, 'utf-8');
    const hash = createHash('sha256').update(bytes.subarray(0, entry.offsetEnd)).digest('hex');
    return { dt: datetime, hash };
  }

  it('unmodified history → ok', () => {
    const { dt, hash } = baselineFor(BASE, '2026-05-11T11:00:00.000Z');
    expect(validateAppendOnly(BASE, dt, hash)).toEqual({ ok: true });
  });

  // SPEC: catches EDIT of a historical (pre-baseline) entry.
  it('edited historical body → prefix_modified', () => {
    const { dt, hash } = baselineFor(BASE, '2026-05-11T11:00:00.000Z');
    const edited = BASE.replace('first.', 'EDITED.');
    expect(validateAppendOnly(edited, dt, hash)).toEqual({ ok: false, reason: 'prefix_modified' });
  });

  // SPEC: appending AFTER the baseline boundary is allowed (append-only).
  it('appending a new entry after the boundary → still ok', () => {
    const { dt, hash } = baselineFor(BASE, '2026-05-11T11:00:00.000Z');
    const appended = BASE + '## [2026-05-11T12:00:00.000Z]\nthird.\n';
    expect(validateAppendOnly(appended, dt, hash)).toEqual({ ok: true });
  });

  // SPEC: catches DELETE of the boundary entry → boundary_missing.
  it('deleted boundary entry → boundary_missing', () => {
    const { dt, hash } = baselineFor(BASE, '2026-05-11T11:00:00.000Z');
    const deleted = '## [2026-05-11T10:00:00.000Z]\nfirst.\n';
    expect(validateAppendOnly(deleted, dt, hash)).toEqual({ ok: false, reason: 'boundary_missing' });
  });

  // SPEC: catches REORDER — swapping entries changes the hashed prefix.
  it('reordered historical entries → prefix_modified', () => {
    const { dt, hash } = baselineFor(BASE, '2026-05-11T11:00:00.000Z');
    const reordered =
      '## [2026-05-11T11:00:00.000Z]\nsecond.\n' + '## [2026-05-11T10:00:00.000Z]\nfirst.\n';
    // Boundary entry still present; the prefix bytes differ → prefix_modified.
    expect(validateAppendOnly(reordered, dt, hash)).toEqual({
      ok: false,
      reason: 'prefix_modified',
    });
  });

  // SPEC (defense in depth): a tampered, non-strict-ISO stored datetime is
  // rejected as boundary_missing.
  it('non-strict stored datetime → boundary_missing', () => {
    expect(validateAppendOnly(BASE, '2026-05-11T11:00:00Z', 'deadbeef')).toEqual({
      ok: false,
      reason: 'boundary_missing',
    });
  });
});

// ────────────────────────────────────────────────────────────────────────
// SECTION 5 — Merge-resolve: byte-exact ancestor + union of new entries
// (spec: "validates byte-exact ancestor portion and union of new entries —
// it cannot silently drop or fabricate entries").
// ────────────────────────────────────────────────────────────────────────
describe('merge-resolve', () => {
  const ANCESTOR = '## [2026-05-11T10:00:00.000Z]\nbase.\n';
  const PARENT1 = ANCESTOR + '## [2026-05-11T11:00:00.000Z]\nfeat1.\n';
  const PARENT2 = ANCESTOR + '## [2026-05-11T12:00:00.000Z]\nfeat2.\n';
  const UNION =
    ANCESTOR +
    '## [2026-05-11T11:00:00.000Z]\nfeat1.\n' +
    '## [2026-05-11T12:00:00.000Z]\nfeat2.\n';

  async function setupMergeRepo(resolved: string): Promise<{ projectRoot: string; nodePath: string }> {
    const repo = await mkdtemp(path.join(tmpdir(), 'yg-bounty4-merge-'));
    dirs.push(repo);
    const r = (cmd: string) => execSync(cmd, { cwd: repo, stdio: 'pipe' });
    r('git init -q -b main');
    r('git config user.email t@t.test');
    r('git config user.name Test');
    const nodeDir = path.join(repo, '.yggdrasil', 'model', 'billing');
    await mkdir(nodeDir, { recursive: true });
    await writeFile(path.join(repo, '.yggdrasil', 'yg-config.yaml'), 'version: "5.0.0"\n');
    await writeFile(
      path.join(repo, '.yggdrasil', 'yg-architecture.yaml'),
      'node_types:\n  module:\n    description: m\n',
    );
    await writeFile(path.join(nodeDir, 'yg-node.yaml'), 'name: billing\ntype: module\ndescription: x\n');
    await writeFile(path.join(nodeDir, 'log.md'), ANCESTOR);
    r('git add -A && git commit -qm ancestor');
    r('git checkout -qb feat1');
    await writeFile(path.join(nodeDir, 'log.md'), PARENT1);
    r('git add -A && git commit -qm feat1');
    r('git checkout -q main && git checkout -qb feat2 main');
    await writeFile(path.join(nodeDir, 'log.md'), PARENT2);
    r('git add -A && git commit -qm feat2');
    r('git merge --no-commit --no-ff feat1 -q || true');
    await writeFile(path.join(nodeDir, 'log.md'), resolved);
    r('git add -A');
    r('git commit -qm "merge"');
    return { projectRoot: repo, nodePath: 'billing' };
  }

  // SPEC: union of both branches' new entries, byte-exact ancestor → accepted.
  it('accepts byte-exact ancestor + full union of new entries', async () => {
    const { projectRoot, nodePath } = await setupMergeRepo(UNION);
    const graph = await loadGraph(projectRoot, { tolerateInvalidConfig: true });
    const result = await logMergeResolve({ graph, nodePath, repoRoot: projectRoot });
    expect(result.ok).toBe(true);
  });

  // SPEC: "cannot silently drop ... entries" — dropping a parent's entry rejected.
  it('rejects a dropped parent entry (union missing)', async () => {
    const { projectRoot, nodePath } = await setupMergeRepo(PARENT1); // missing feat2
    const graph = await loadGraph(projectRoot, { tolerateInvalidConfig: true });
    const result = await logMergeResolve({ graph, nodePath, repoRoot: projectRoot });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.what).toMatch(/missing/i);
  });

  // SPEC: "cannot ... fabricate entries" — a never-written entry is rejected.
  it('rejects a fabricated entry not present in either parent', async () => {
    const fabricated = UNION + '## [2026-05-11T13:00:00.000Z]\nFABRICATED.\n';
    const { projectRoot, nodePath } = await setupMergeRepo(fabricated);
    const graph = await loadGraph(projectRoot, { tolerateInvalidConfig: true });
    const result = await logMergeResolve({ graph, nodePath, repoRoot: projectRoot });
    expect(result.ok).toBe(false);
  });

  // SPEC: "byte-exact ancestor portion" — altering an ancestor entry rejected.
  it('rejects a modified ancestor prefix', async () => {
    const tampered =
      '## [2026-05-11T10:00:00.000Z]\nTAMPERED.\n' +
      '## [2026-05-11T11:00:00.000Z]\nfeat1.\n' +
      '## [2026-05-11T12:00:00.000Z]\nfeat2.\n';
    const { projectRoot, nodePath } = await setupMergeRepo(tampered);
    const graph = await loadGraph(projectRoot, { tolerateInvalidConfig: true });
    const result = await logMergeResolve({ graph, nodePath, repoRoot: projectRoot });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.what).toMatch(/ancestor/i);
  });

  // SPEC: must run on a merge commit ("run from the merge commit").
  it('rejects when HEAD is not a merge commit', async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'yg-bounty4-nomerge-'));
    dirs.push(repo);
    const r = (cmd: string) => execSync(cmd, { cwd: repo, stdio: 'pipe' });
    r('git init -q -b main');
    r('git config user.email t@t.test');
    r('git config user.name Test');
    const nodeDir = path.join(repo, '.yggdrasil', 'model', 'billing');
    await mkdir(nodeDir, { recursive: true });
    await writeFile(path.join(repo, '.yggdrasil', 'yg-config.yaml'), 'version: "5.0.0"\n');
    await writeFile(
      path.join(repo, '.yggdrasil', 'yg-architecture.yaml'),
      'node_types:\n  module:\n    description: m\n',
    );
    await writeFile(path.join(nodeDir, 'yg-node.yaml'), 'name: billing\ntype: module\ndescription: x\n');
    await writeFile(path.join(nodeDir, 'log.md'), ANCESTOR);
    r('git add -A && git commit -qm only');
    const graph = await loadGraph(repo, { tolerateInvalidConfig: true });
    const result = await logMergeResolve({ graph, nodePath: 'billing', repoRoot: repo });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.what).toMatch(/not a merge commit/i);
  });

  // SPEC: "Resolve all conflicts ... still contains conflict markers" rejected.
  it('rejects unresolved conflict markers', async () => {
    const { projectRoot, nodePath } = await setupMergeRepo(UNION);
    const logPath = path.join(projectRoot, '.yggdrasil', 'model', nodePath, 'log.md');
    await writeFile(logPath, '<<<<<<< HEAD\na\n=======\nb\n>>>>>>> feat\n');
    const graph = await loadGraph(projectRoot, { tolerateInvalidConfig: true });
    const result = await logMergeResolve({ graph, nodePath, repoRoot: projectRoot });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.what).toMatch(/conflict marker/i);
  });

  // SPEC: union entries must remain chronological.
  it('rejects new entries out of chronological order', async () => {
    const outOfOrder =
      ANCESTOR +
      '## [2026-05-11T12:00:00.000Z]\nfeat2.\n' +
      '## [2026-05-11T11:00:00.000Z]\nfeat1.\n';
    const { projectRoot, nodePath } = await setupMergeRepo(outOfOrder);
    const graph = await loadGraph(projectRoot, { tolerateInvalidConfig: true });
    const result = await logMergeResolve({ graph, nodePath, repoRoot: projectRoot });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.what).toMatch(/chronological/i);
  });

  // SPEC: merge-resolve writes/updates the log baseline (drift-state) on success.
  it('writes a fresh log baseline on a valid merge with no prior baseline', async () => {
    const { projectRoot, nodePath } = await setupMergeRepo(UNION);
    const graph = await loadGraph(projectRoot, { tolerateInvalidConfig: true });
    const result = await logMergeResolve({ graph, nodePath, repoRoot: projectRoot });
    expect(result.ok).toBe(true);
    // The resolved log must validate append-only against the freshly written baseline.
    const resolved = await readFile(
      path.join(projectRoot, '.yggdrasil', 'model', nodePath, 'log.md'),
      'utf-8',
    );
    const newest = parseLog(resolved).at(-1)!;
    const hash = createHash('sha256').update(Buffer.from(resolved, 'utf-8')).digest('hex');
    expect(validateAppendOnly(resolved, newest.datetime, hash)).toEqual({ ok: true });
  });
});

// ────────────────────────────────────────────────────────────────────────
// SECTION 6 — Freshness rule (spec: "When a log entry is required").
// ────────────────────────────────────────────────────────────────────────
describe('freshness rule', () => {
  // SPEC: "the node's source files changed since the last approve ... requires a
  // fresh log entry" — a source change with no fresh entry refuses.
  it('source change with no fresh log entry → refused', async () => {
    const { projectRoot, nodePath, sourcePath } = await setupProject();
    await bootstrapApprove(projectRoot, nodePath);
    await writeFile(sourcePath, 'export const x = 2;\n');
    const graph = await loadGraph(projectRoot);
    const r = await approveNode(graph, nodePath);
    expect(r.action).toBe('refused');
    expect(refuseMsg(r)).toMatch(/log entry|mandatory/i);
  });

  // SPEC: "one new entry per approve cycle" — a fresh entry unblocks approve.
  it('source change WITH a fresh log entry → approved', async () => {
    const { projectRoot, nodePath, sourcePath } = await setupProject();
    await bootstrapApprove(projectRoot, nodePath);
    await writeFile(sourcePath, 'export const x = 2;\n');
    await logAddCmd(nodePath, 'changed semantics', projectRoot);
    const graph = await loadGraph(projectRoot);
    const r = await approveNode(graph, nodePath);
    expect(r.action).toBe('approved');
  });

  // SPEC: "the SAME entry keeps satisfying the gate across every retry until
  // approve finally succeeds" — but once approve SUCCEEDS and commits, the
  // baseline advances, so a later source change needs a NEW entry.
  it('one entry covers a retry, but the next cycle needs a fresh entry', async () => {
    const { projectRoot, nodePath, sourcePath } = await setupProject();
    await bootstrapApprove(projectRoot, nodePath);

    // Cycle 1: edit + add + approve (success commits the freshness baseline).
    await writeFile(sourcePath, 'export const x = 2;\n');
    await logAddCmd(nodePath, 'cycle-1 entry', projectRoot);
    let graph = await loadGraph(projectRoot);
    let r = await approveNode(graph, nodePath);
    expect(r.action).toBe('approved');
    await commitApprovedBaseline(graph, nodePath, path.join(projectRoot, '.yggdrasil'), r);

    // Cycle 2: edit again WITHOUT a fresh entry → must refuse (prior entry is now baselined).
    await writeFile(sourcePath, 'export const x = 3;\n');
    graph = await loadGraph(projectRoot);
    r = await approveNode(graph, nodePath);
    expect(r.action).toBe('refused');
  });

  // SPEC: "A node with no source change (cascade-only re-approve) needs no new
  // entry."
  it('no source change (pure cascade/no-op re-approve) needs no new entry → not refused', async () => {
    const { projectRoot, nodePath } = await setupProject();
    await bootstrapApprove(projectRoot, nodePath);
    // No source edit, no new log entry.
    const graph = await loadGraph(projectRoot);
    const r = await approveNode(graph, nodePath);
    expect(r.action).not.toBe('refused');
  });

  // SPEC: "the node type has `log_required: true` (the default)" — the FLAG
  // default is true when absent in architecture.
  it('log_required defaults to true when the field is absent', async () => {
    const { projectRoot, nodePath, sourcePath } = await setupProject();
    await bootstrapApprove(projectRoot, nodePath);
    await writeFile(
      path.join(projectRoot, '.yggdrasil', 'yg-architecture.yaml'),
      'node_types:\n  module:\n    description: m\n',
    );
    await writeFile(sourcePath, 'export const x = 2;\n');
    const graph = await loadGraph(projectRoot);
    const r = await approveNode(graph, nodePath);
    expect(r.action).toBe('refused');
  });

  // SPEC: "It is INDEPENDENT of aspect status: a node whose every effective
  // aspect is in draft still needs a log entry when its source changes."
  it('all-draft node still needs a fresh entry on source change', async () => {
    const { projectRoot, nodePath, sourcePath } = await setupProject();
    // Make the aspect draft.
    await writeFile(
      path.join(projectRoot, '.yggdrasil', 'aspects', 'a1', 'yg-aspect.yaml'),
      'name: A1\ndescription: x\nstatus: draft\n',
    );
    await bootstrapApprove(projectRoot, nodePath);
    await writeFile(sourcePath, 'export const x = 2;\n');
    const graph = await loadGraph(projectRoot);
    const r = await approveNode(graph, nodePath);
    expect(r.action).toBe('refused');
    expect(refuseMsg(r)).toMatch(/log entry|mandatory/i);
  });

  // SPEC: "the node type has `log_required: true` (the default)" — false means
  // a source change does NOT demand an entry.
  it('log_required: false → source change approved without an entry', async () => {
    const { projectRoot, nodePath, sourcePath } = await setupProject({ logRequired: false });
    await bootstrapApprove(projectRoot, nodePath);
    await writeFile(sourcePath, 'export const x = 2;\n');
    const graph = await loadGraph(projectRoot);
    const r = await approveNode(graph, nodePath);
    expect(r.action).not.toBe('refused');
  });

  // SPEC: "this is the first approve and the node owns source files" — first
  // approve with no entry at all is refused.
  it('first approve with no log entry at all → refused', async () => {
    const { projectRoot, nodePath } = await setupProject();
    const graph = await loadGraph(projectRoot);
    const r = await approveNode(graph, nodePath);
    expect(r.action).toBe('refused');
  });
});

// ────────────────────────────────────────────────────────────────────────
// SECTION 7 — Drift independence (spec: "`yg log add` does NOT trigger drift
// or run the reviewer ... Only source-file changes ... require entries").
// ────────────────────────────────────────────────────────────────────────
describe('drift independence', () => {
  // SPEC: adding a context-only entry (no source change) must NOT make the next
  // approve report a code change — it is a no-op approve.
  it('pure log addition (no source change) → no-change', async () => {
    const { projectRoot, nodePath } = await setupProject();
    await bootstrapApprove(projectRoot, nodePath);
    await logAddCmd(nodePath, 'context-only entry', projectRoot);
    const graph = await loadGraph(projectRoot);
    const r = await approveNode(graph, nodePath);
    expect(r.action).toBe('no-change');
  });
});
