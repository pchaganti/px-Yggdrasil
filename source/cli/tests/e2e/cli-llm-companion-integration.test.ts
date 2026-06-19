// =============================================================================
// PER-UNIT COMPANION FILES — integration E2E (plan §11.2 cli-llm-companion-integration).
//
// Real spawned binary + in-process Ollama-protocol mock reviewer (runAsync, never
// spawnSync while the mock serves). Exercises the companion feature's interaction
// with the surrounding machinery: the --dry-run diagnostic, consensus>1, the §4
// prompt-size gate, the built-in relation-conformance check, status channels
// (advisory / draft), the flow + implies attach channels, and the plain-LLM
// backward-compat guarantee.
//
// Covered (cases 20–24 + additions):
//   20 `yg aspect-test --dry-run` shows resolved companions + the assembled prompt;
//      ZERO reviewer calls (chatCount === 0); lock byte-UNCHANGED.
//   21 a companion aspect on a consensus: 3 tier → the companion hook resolves ONCE
//      per unit (the 3 chat prompts for a unit are byte-identical) and `touched` is
//      recorded once (single read: entry).
//   22 a companion pushing the prompt over max_prompt_chars → prompt-too-large
//      naming the pair (and the char count includes the companion bytes).
//   23 full scenario↔test happy path end-to-end; the built-in relation-conformance
//      check does NOT false-positive.
//   24 backward-compat regression: a PLAIN LLM aspect (no companion) → its lock
//      entry has NO `touched`/companionHash; editing an unrelated cross-node file
//      does not invalidate it.
//   +  advisory status: a refused companion pair renders as a WARNING (exit 0); an
//      unverified companion pair (after editing companion.mjs) renders as a warning
//      not an error.
//   +  draft status: a draft companion aspect produces NO pairs and the hook is
//      NEVER invoked (zero reviewer calls, no touched); a draft→enforced round-trip
//      after a clean fill keeps the verdict valid with ZERO reviewer calls.
//   +  flow channel: a companion aspect attached via a flow becomes effective on a
//      participant and the hook runs there. implies channel: a companion aspect
//      reached via an aggregating aspect's `implies` runs too.
//
// HERMETIC: fresh mkdtemp copy of the fixture per test, mutated in place, rmSync'd
// in finally. No fixed ports, no clock/random assertions.
// =============================================================================

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, cpSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockReviewer, runAsync, type ChatRequest } from './support/mock-reviewer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '..', '..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'e2e-companion');
const distExists = existsSync(BIN_PATH);

const cfgPath = (d: string) => path.join(d, '.yggdrasil', 'yg-config.yaml');
const nodeYaml = (d: string, n: string) => path.join(d, '.yggdrasil', 'model', ...n.split('/'), 'yg-node.yaml');
const aspectYaml = (d: string, a: string) => path.join(d, '.yggdrasil', 'aspects', a, 'yg-aspect.yaml');
const aspectDir = (d: string, a: string) => path.join(d, '.yggdrasil', 'aspects', a);
const lockPath = (d: string) => path.join(d, '.yggdrasil', 'yg-lock.json');
const readLockRaw = (d: string): string => readFileSync(lockPath(d), 'utf-8');
const readLock = (d: string): Record<string, unknown> => JSON.parse(readLockRaw(d));
const specTs = (d: string, name: string) => path.join(d, 'apps', 'e2e', 'tests', name);

const SCENARIOS = ['checkout', 'login', 'search'] as const;
const UNIT = (name: string) => `file:references/e2e-test-scenarios/${name}.md`;

function run(args: string[], cwd: string): { all: string; status: number | null } {
  const r = spawnSync('node', [BIN_PATH, ...args], { cwd, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });
  return { all: (r.stdout ?? '') + (r.stderr ?? ''), status: r.status };
}
/**
 * Point EVERY tier's endpoint at the mock (global replace). The fixture config has
 * two tiers (standard + consensus3), each with its own endpoint — a first-only
 * replace would leave consensus3 pointing at a dead host and silently fail the
 * consensus test, so the global form is mandatory here.
 */
function pointReviewer(dir: string, endpoint: string): void {
  const p = cfgPath(dir);
  writeFileSync(p, readFileSync(p, 'utf-8').replace(/endpoint:\s*["']?[^"'\n]+["']?/g, `endpoint: "${endpoint}"`), 'utf-8');
}
function copyFixture(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-companion-int-${label}-`));
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}
/** Swap the scenarios node's single attached aspect to a variant. */
function useAspect(dir: string, aspectId: string): void {
  const p = nodeYaml(dir, 'scenarios');
  writeFileSync(p, readFileSync(p, 'utf-8').replace(/- scenario-matches-test\b/, `- ${aspectId}`), 'utf-8');
}
function setStatus(dir: string, aspectId: string, status: string): void {
  const p = aspectYaml(dir, aspectId);
  writeFileSync(p, readFileSync(p, 'utf-8').replace(/status: \w+/, `status: ${status}`), 'utf-8');
}
/** Point the aspect at a named tier (inserts `tier:` under reviewer.type). */
function useTier(dir: string, aspectId: string, tier: string): void {
  const p = aspectYaml(dir, aspectId);
  writeFileSync(p, readFileSync(p, 'utf-8').replace('reviewer:\n  type: llm', `reviewer:\n  type: llm\n  tier: ${tier}`), 'utf-8');
}
/** Set max_prompt_chars on the standard tier (config edit, NOT a verdict input). */
function setStandardLimit(dir: string, chars: number): void {
  const p = cfgPath(dir);
  writeFileSync(
    p,
    readFileSync(p, 'utf-8').replace(/( {4}standard:\n {6}provider: ollama\n {6}consensus: 1\n)/, `$1      max_prompt_chars: ${chars}\n`),
    'utf-8',
  );
}

type Verdicts = Record<string, Record<string, { hash: string; touched?: Array<[string, string]>; verdict: string; reason?: string }>>;
const verdicts = (d: string, aspectId: string): Verdicts[string] => (readLock(d).verdicts as Verdicts)[aspectId] ?? {};
const touchedKeys = (entry: { touched?: Array<[string, string]> } | undefined): string[] => (entry?.touched ?? []).map(([k]) => k);

/** The <source-files> DATA region of a prompt (NOT the instruction mention near the top). */
function sourceFilesRegion(prompt: string): string {
  const start = prompt.lastIndexOf('<source-files>');
  const end = prompt.indexOf('</source-files>');
  return start >= 0 && end >= 0 ? prompt.slice(start, end) : '';
}
/** The scenario name a prompt reviews, keyed off its unique subject frontmatter. */
function promptScenario(prompt: string): string | undefined {
  const region = sourceFilesRegion(prompt);
  return SCENARIOS.find((s) => region.includes(`test: ${s}.spec.ts`));
}

describe.skipIf(!distExists)('CLI E2E — per-unit companion files (integration)', () => {
  // ===========================================================================
  // (20) `yg aspect-test --dry-run` resolves + shows companions and the assembled
  //   prompt, makes ZERO reviewer calls, and leaves the lock byte-unchanged.
  // ===========================================================================
  it('(20) aspect-test --dry-run shows companions + prompt, 0 reviewer calls, lock byte-unchanged', async () => {
    const dir = copyFixture('dryrun');
    const mock = await startMockReviewer({ respond: () => ({ satisfied: true, reason: 'ok' }) });
    try {
      pointReviewer(dir, mock.endpoint);
      // Seed a lock by filling first, then snapshot it — dry-run must not mutate it.
      expect((await runAsync(['check', '--approve'], dir)).status).toBe(0);
      const lockBefore = readLockRaw(dir);
      const callsBefore = mock.chatCount();

      const r = await runAsync(['aspect-test', '--aspect', 'scenario-matches-test', '--node', 'scenarios', '--dry-run'], dir);
      expect(r.status).toBe(0);

      // ZERO reviewer calls during dry-run.
      expect(mock.chatCount() - callsBefore).toBe(0);

      // Resolved companions are shown per unit, with the path and label.
      for (const s of SCENARIOS) {
        expect(r.all).toContain(`--- companions for ${UNIT(s)} ---`);
        expect(r.all).toContain(`apps/e2e/tests/${s}.spec.ts (paired test:`);
        // The assembled prompt is printed, carrying the <companions> block.
        expect(r.all).toContain(`=== prompt for ${UNIT(s)} ===`);
      }
      expect(r.all).toContain('<companions>');
      expect(r.all).toContain('<companion path="apps/e2e/tests/checkout.spec.ts"');

      // Lock byte-unchanged.
      expect(readLockRaw(dir)).toBe(lockBefore);
    } finally {
      await mock.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 40000);

  // ===========================================================================
  // (21) CONSENSUS 3: the companion hook resolves ONCE per unit even though the
  //   reviewer is called 3× per unit. Proof: the 3 captured prompts for a given
  //   unit are byte-identical (a re-resolved companion could differ), and the unit
  //   records `touched` exactly once (a single read: entry, not three).
  //   NOTE: consensus must be ODD; the fixture's consensus3 tier provides it.
  // ===========================================================================
  it('(21) consensus 3: companion resolves once per unit (prompts byte-identical), touched recorded once', async () => {
    const dir = copyFixture('consensus');
    const prompts: string[] = [];
    const mock = await startMockReviewer({
      respond: (req: ChatRequest) => {
        prompts.push(req.prompt);
        return { satisfied: true, reason: 'ok' };
      },
    });
    try {
      pointReviewer(dir, mock.endpoint);
      useTier(dir, 'scenario-matches-test', 'consensus3');

      const fill = await runAsync(['check', '--approve'], dir);
      expect(fill.status).toBe(0);
      expect(mock.chatCount()).toBe(9); // 3 units × consensus 3.

      // Group captured prompts by the scenario they review; each group is 3 prompts.
      for (const s of SCENARIOS) {
        const group = prompts.filter((p) => promptScenario(p) === s);
        expect(group.length).toBe(3);
        // All 3 are byte-identical — the companion was resolved ONCE and the same
        // assembled prompt was sent to each consensus call.
        for (const p of group) expect(p).toBe(group[0]);
        // The group's prompt carries this unit's single paired spec as a companion.
        expect(group[0]).toContain(`<companion path="apps/e2e/tests/${s}.spec.ts"`);
      }

      // touched recorded ONCE per unit (a single read: entry, not three duplicates).
      const v = verdicts(dir, 'scenario-matches-test');
      for (const s of SCENARIOS) {
        expect(touchedKeys(v[UNIT(s)])).toEqual([`read:apps/e2e/tests/${s}.spec.ts`]);
      }
    } finally {
      await mock.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60000);

  // ===========================================================================
  // (22) PROMPT-TOO-LARGE: a companion pushes the assembled prompt over the tier's
  //   max_prompt_chars. We fill cleanly under no limit, then LOWER max_prompt_chars
  //   on the same named tier (a config edit — NOT a verdict input, so the verdict
  //   stays valid). `yg check` re-measures the assembled prompt (which INCLUDES the
  //   companion bytes) and surfaces prompt-too-large naming the pair, with no new
  //   reviewer calls.
  // ===========================================================================
  it('(22) a companion over max_prompt_chars surfaces prompt-too-large naming the pair', async () => {
    const dir = copyFixture('toobig');
    const mock = await startMockReviewer({ respond: () => ({ satisfied: true, reason: 'ok' }) });
    try {
      pointReviewer(dir, mock.endpoint);
      // 1) Fill cleanly with no limit.
      expect((await runAsync(['check', '--approve'], dir)).status).toBe(0);
      const callsAfterFill = mock.chatCount();
      expect(callsAfterFill).toBe(3);

      // 2) Lower max_prompt_chars below every assembled prompt (each ~3.6k incl. its
      //    paired spec companion). 1500 is comfortably under the companion-bearing
      //    prompt yet the tier NAME is unchanged, so verdicts stay valid.
      setStandardLimit(dir, 1500);

      const after = run(['check'], dir);
      expect(after.status).toBe(1);
      // The gate names the pair and the over-limit char count (which includes the
      // companion spec — proving companion content counts toward the §4 gate).
      expect(after.all).toContain(`prompt-too-large`);
      expect(after.all).toContain(`for aspect 'scenario-matches-test' on ${UNIT('checkout')} is`);
      expect(after.all).toContain(`over the 'standard' tier limit of 1500`);
      // No reviewer calls during the read-only check.
      expect(mock.chatCount() - callsAfterFill).toBe(0);
    } finally {
      await mock.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 40000);

  // ===========================================================================
  // (23) FULL HAPPY PATH end-to-end + the built-in relation-conformance check does
  //   NOT false-positive. A clean fill goes green, a clean check stays green, and
  //   no relation-undeclared-dependency is reported (the .md → spec link is a
  //   declared `uses` relation, not a code import; the specs are self-contained).
  // ===========================================================================
  it('(23) full scenario↔test happy path; relation-conformance does not false-positive', async () => {
    const dir = copyFixture('happy');
    const mock = await startMockReviewer({ respond: () => ({ satisfied: true, reason: 'ok' }) });
    try {
      pointReviewer(dir, mock.endpoint);
      const fill = await runAsync(['check', '--approve'], dir);
      expect(fill.status).toBe(0);
      expect(mock.chatCount()).toBe(3);
      // No relation refusal anywhere in the fill output.
      expect(fill.all).not.toContain('relation-undeclared-dependency');

      const check = run(['check'], dir);
      expect(check.status).toBe(0);
      // The built-in relation check runs live on every `yg check`; it must stay
      // silent for this graph (declared `uses` needs no code backing; specs import
      // nothing cross-node).
      expect(check.all).not.toContain('relation-undeclared-dependency');

      // Every pair is verified.
      const v = verdicts(dir, 'scenario-matches-test');
      expect(Object.keys(v).sort()).toEqual(SCENARIOS.map((s) => UNIT(s)).sort());
      for (const s of SCENARIOS) expect(v[UNIT(s)].verdict).toBe('approved');
    } finally {
      await mock.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 40000);

  // ===========================================================================
  // (24) BACKWARD-COMPAT: a PLAIN LLM aspect (no companion.mjs) writes a lock entry
  //   with NO `touched` and NO companionHash — byte-identical to the pre-feature
  //   contract. Editing an unrelated cross-node file (a spec) does not invalidate
  //   it (the plain aspect never read it).
  // ===========================================================================
  it('(24) a plain LLM aspect has no touched/companionHash; a cross-node edit does not invalidate it', async () => {
    const dir = copyFixture('plain');
    const mock = await startMockReviewer({ respond: () => ({ satisfied: true, reason: 'ok' }) });
    try {
      pointReviewer(dir, mock.endpoint);
      useAspect(dir, 'plain-llm');

      expect((await runAsync(['check', '--approve'], dir)).status).toBe(0);
      expect(mock.chatCount()).toBe(3);

      const v = verdicts(dir, 'plain-llm');
      for (const s of SCENARIOS) {
        const entry = v[UNIT(s)];
        expect(entry.verdict).toBe('approved');
        // No touched key, and the serialized entry never carries companionHash.
        expect('touched' in entry).toBe(false);
        expect(JSON.stringify(entry)).not.toContain('companionHash');
        expect(Object.keys(entry).sort()).toEqual(['hash', 'verdict']);
      }

      // Edit a cross-node spec file — the plain aspect has no companion, so it never
      // read the spec and the pair stays verified.
      appendFileSync(specTs(dir, 'checkout.spec.ts'), '\n// unrelated cross-node edit\n');
      const after = run(['check'], dir);
      expect(after.status).toBe(0);
      expect(mock.chatCount()).toBe(3); // still no new reviewer calls.
      // The plain entry is byte-unchanged.
      const vAfter = verdicts(dir, 'plain-llm');
      for (const s of SCENARIOS) expect(JSON.stringify(vAfter[UNIT(s)])).toBe(JSON.stringify(v[UNIT(s)]));
    } finally {
      await mock.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 40000);

  // ===========================================================================
  // (+) ADVISORY status: a refused companion pair renders as a WARNING (exit 0); an
  //   unverified companion pair (after editing companion.mjs) ALSO renders as a
  //   warning, never an error.
  // ===========================================================================
  it('(+advisory) a refused advisory companion pair is a warning; an unverified one is a warning too', async () => {
    const dir = copyFixture('advisory');
    // Refuse every unit → with advisory status those refusals must be warnings.
    const mock = await startMockReviewer({ respond: () => ({ satisfied: false, reason: 'scenario drifted from spec' }) });
    try {
      pointReviewer(dir, mock.endpoint);
      setStatus(dir, 'scenario-matches-test', 'advisory');

      const fill = await runAsync(['check', '--approve'], dir);
      expect(fill.status).toBe(0); // advisory refusals do not block --approve's report.

      const check = run(['check'], dir);
      expect(check.status).toBe(0); // advisory never blocks.
      expect(check.all).toContain('Warnings');
      // Rendered as an advisory refusal warning, not an error block.
      expect(check.all).toContain(`Aspect 'scenario-matches-test' is refused on ${UNIT('checkout')}`);
      expect(check.all).toContain('(advisory — not blocking)');
      expect(check.all).not.toContain('Errors (');

      // Now make the pairs UNVERIFIED by editing companion.mjs (companionHash). An
      // advisory unverified pair must STILL be a warning, never an error.
      appendFileSync(path.join(aspectDir(dir, 'scenario-matches-test'), 'companion.mjs'), '\n// hook revision\n');
      const after = run(['check'], dir);
      expect(after.status).toBe(0); // advisory unverified does not block.
      expect(after.all).toContain('Warnings');
      expect(after.all).toContain(`No valid verdict for aspect 'scenario-matches-test' on ${UNIT('checkout')}.`);
      expect(after.all).not.toContain('Errors (');
    } finally {
      await mock.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 40000);

  // ===========================================================================
  // (+) DRAFT status: a draft companion aspect produces NO pairs and the hook is
  //   NEVER invoked (zero reviewer calls, no entries). A draft→enforced round-trip
  //   AFTER a clean enforced fill keeps the verdict valid with ZERO reviewer calls.
  // ===========================================================================
  it('(+draft) a draft companion aspect never runs the hook; a draft round-trip keeps the verdict', async () => {
    const dir = copyFixture('draft');
    const mock = await startMockReviewer({ respond: () => ({ satisfied: true, reason: 'ok' }) });
    try {
      pointReviewer(dir, mock.endpoint);

      // First: draft from the start → NO pairs, hook never invoked, zero calls.
      setStatus(dir, 'scenario-matches-test', 'draft');
      const draftFill = await runAsync(['check', '--approve'], dir);
      expect(draftFill.status).toBe(0);
      expect(mock.chatCount()).toBe(0); // hook + reviewer both never invoked.
      // No verdicts recorded for the draft aspect.
      expect(Object.keys(verdicts(dir, 'scenario-matches-test')).length).toBe(0);
      const draftCheck = run(['check'], dir);
      expect(draftCheck.status).toBe(0);
      expect(draftCheck.all).toContain('draft'); // summary tally shows the draft.

      // Now: flip to enforced + fill cleanly.
      setStatus(dir, 'scenario-matches-test', 'enforced');
      const enforcedFill = await runAsync(['check', '--approve'], dir);
      expect(enforcedFill.status).toBe(0);
      expect(mock.chatCount()).toBe(3);

      // Round-trip: enforced → draft → enforced. The verdict survives a draft
      // round-trip; the return to enforced needs ZERO new reviewer calls.
      setStatus(dir, 'scenario-matches-test', 'draft');
      expect(run(['check'], dir).status).toBe(0);
      expect(mock.chatCount()).toBe(3); // draft makes no calls.

      setStatus(dir, 'scenario-matches-test', 'enforced');
      const back = run(['check'], dir);
      expect(back.status).toBe(0); // verdict still valid.
      expect(mock.chatCount()).toBe(3);
      const reFill = await runAsync(['check', '--approve'], dir);
      expect(reFill.status).toBe(0);
      expect(mock.chatCount()).toBe(3); // nothing to re-verify.
      expect(reFill.all).toContain('0 reviewer calls made');
    } finally {
      await mock.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60000);

  // ===========================================================================
  // (+) FLOW CHANNEL: a companion aspect attached via a FLOW becomes effective on a
  //   participant node and the hook runs there (touched recorded).
  // ===========================================================================
  it('(+flow) a companion aspect attached via a flow runs the hook on the participant', async () => {
    const dir = copyFixture('flow');
    const mock = await startMockReviewer({ respond: () => ({ satisfied: true, reason: 'ok' }) });
    try {
      pointReviewer(dir, mock.endpoint);
      // Detach the own aspect; attach the SAME companion aspect via a flow instead.
      const np = nodeYaml(dir, 'scenarios');
      writeFileSync(np, readFileSync(np, 'utf-8').replace(/\naspects:\n {2}- scenario-matches-test\n?/, '\n'), 'utf-8');
      const fdir = path.join(dir, '.yggdrasil', 'flows', 'scenario-coverage');
      mkdirSync(fdir, { recursive: true });
      writeFileSync(
        path.join(fdir, 'yg-flow.yaml'),
        ['name: ScenarioCoverage', 'description: Scenario documents stay in sync with their paired specs.', 'nodes:', '  - scenarios', 'aspects:', '  - scenario-matches-test', ''].join('\n'),
        'utf-8',
      );

      const fill = await runAsync(['check', '--approve'], dir);
      expect(fill.status).toBe(0);
      expect(mock.chatCount()).toBe(3); // 3 per:file pairs via the flow attach.

      // The hook ran on every participant unit: each carries its paired-spec touched.
      const v = verdicts(dir, 'scenario-matches-test');
      expect(Object.keys(v).sort()).toEqual(SCENARIOS.map((s) => UNIT(s)).sort());
      for (const s of SCENARIOS) {
        expect(touchedKeys(v[UNIT(s)])).toEqual([`read:apps/e2e/tests/${s}.spec.ts`]);
      }
      expect(run(['check'], dir).status).toBe(0);
    } finally {
      await mock.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 40000);

  // ===========================================================================
  // (+) IMPLIES CHANNEL: a companion aspect reached via an aggregating aspect's
  //   `implies` runs the hook too. The aggregate has no own verdict; the implied
  //   companion aspect produces the verdicts (with touched).
  // ===========================================================================
  it('(+implies) a companion aspect reached via implies runs the hook (aggregate has no own verdict)', async () => {
    const dir = copyFixture('implies');
    const mock = await startMockReviewer({ respond: () => ({ satisfied: true, reason: 'ok' }) });
    try {
      pointReviewer(dir, mock.endpoint);
      // Create an aggregating aspect that implies the companion aspect, attach it.
      const agg = aspectDir(dir, 'scenario-bundle');
      mkdirSync(agg, { recursive: true });
      writeFileSync(
        path.join(agg, 'yg-aspect.yaml'),
        ['name: ScenarioBundle', 'description: Bundle pulling in the scenario-matches-test companion rule.', 'implies:', '  - scenario-matches-test', ''].join('\n'),
        'utf-8',
      );
      useAspect(dir, 'scenario-bundle');

      const fill = await runAsync(['check', '--approve'], dir);
      expect(fill.status).toBe(0);
      expect(mock.chatCount()).toBe(3); // the implied companion aspect's pairs.

      // The implied companion aspect produced the verdicts (with touched).
      const v = verdicts(dir, 'scenario-matches-test');
      expect(Object.keys(v).sort()).toEqual(SCENARIOS.map((s) => UNIT(s)).sort());
      for (const s of SCENARIOS) {
        expect(touchedKeys(v[UNIT(s)])).toEqual([`read:apps/e2e/tests/${s}.spec.ts`]);
      }
      // The aggregate itself has NO own verdict.
      expect((readLock(dir).verdicts as Verdicts)['scenario-bundle']).toBeUndefined();
      expect(run(['check'], dir).status).toBe(0);
    } finally {
      await mock.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 40000);
});
