import { describe, it, expect, afterEach } from 'vitest';
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parseAspectResponse } from '../../../src/llm/cli-base.js';
import { initDebugLog, _resetForTesting } from '../../../src/utils/debug-log.js';

describe('parseAspectResponse', () => {
  it('parses clean JSON', () => {
    const result = parseAspectResponse('{"satisfied": true, "reason": "ok"}');
    expect(result).toEqual({ satisfied: true, reason: 'ok', errorSource: 'codeViolation' });
  });

  it('parses JSON in markdown fence', () => {
    const result = parseAspectResponse('```json\n{"satisfied": false, "reason": "fail"}\n```');
    expect(result).toEqual({ satisfied: false, reason: 'fail', errorSource: 'codeViolation' });
  });

  it('extracts embedded JSON from text', () => {
    const result = parseAspectResponse('Here is my analysis: {"satisfied": true, "reason": "pass"} done.');
    expect(result).toEqual({ satisfied: true, reason: 'pass', errorSource: 'codeViolation' });
  });

  it('extracts the verdict when prose BEFORE it contains brace characters', () => {
    // A verbose reviewer emits markdown analysis (with code snippets and the
    // literal `{ what, why, next }`) and then the JSON verdict. A greedy
    // outermost-brace match would span the prose braces and fail; the verdict
    // scanner must still recover the trailing `{"satisfied": ...}` object.
    const prose = [
      'Looking at the source against each rule:',
      '',
      '**Output routing** — all results use `process.stdout.write()`.',
      'Messages follow `{ what, why, next }` via buildIssueMessage.',
      '',
      '{"satisfied": true, "reason": "all rules met"}',
    ].join('\n');
    const result = parseAspectResponse(prose);
    expect(result).toEqual({ satisfied: true, reason: 'all rules met', errorSource: 'codeViolation' });
  });

  it('picks the LAST satisfied-bearing object when several braces appear', () => {
    const prose = 'Consider {"foo": 1} and a snippet { a: b }, final verdict: {"satisfied": false, "reason": "rule 3 violated"}';
    const result = parseAspectResponse(prose);
    expect(result).toEqual({ satisfied: false, reason: 'rule 3 violated', errorSource: 'codeViolation' });
  });

  it('brace-laden prose WITHOUT a satisfied verdict still fails closed (provider error)', () => {
    // Braces everywhere, but no JSON object with a boolean `satisfied` — must not
    // be coerced into a code PASS; it is an infrastructure (provider) error.
    const prose = 'The function returns `{ ok: true }` and logs `{ level: "info" }` but I could not finish.';
    const result = parseAspectResponse(prose);
    expect(result?.satisfied).toBe(false);
    expect(result?.errorSource).toBe('provider');
  });

  it('returns undefined for empty string', () => {
    expect(parseAspectResponse('')).toBeUndefined();
  });

  // A3b: an unparseable (non-JSON) response is NOT heuristically guessed as a code
  // verdict — a junk reply containing "satisfied" must not become a code-PASS. It is
  // classified as a provider (infrastructure) error so the fail-closed gate refuses.
  it('unparseable response that mentions "satisfied" is a provider error, not a code PASS', () => {
    const result = parseAspectResponse('The code is satisfied with all requirements.');
    expect(result?.satisfied).toBe(false);
    expect(result?.errorSource).toBe('provider');
  });

  it('unparseable response that mentions "not satisfied" is a provider error', () => {
    const result = parseAspectResponse('The code is not satisfied with requirement X.');
    expect(result?.satisfied).toBe(false);
    expect(result?.errorSource).toBe('provider');
  });

  it('unparseable ambiguous text is a provider error', () => {
    const result = parseAspectResponse('I cannot determine if the code is satisfied.');
    expect(result?.satisfied).toBe(false);
    expect(result?.errorSource).toBe('provider');
  });
});

// Raw-response debug logging — when debug:true and a reviewer reply cannot be
// parsed into a verdict, the raw reply is written to .debug.log so the failure can
// be diagnosed (it is otherwise invisible). The success path stays silent (only on
// parse failure, per the agreed contract). These are private, opt-in local logs.
describe('parseAspectResponse — raw-output debug logging', () => {
  let tmpDir: string;

  function appendFn(filePath: string, text: string): void {
    appendFileSync(filePath, text, 'utf-8');
  }
  function logContent(): string {
    return readFileSync(path.join(tmpDir, '.debug.log'), 'utf-8');
  }

  afterEach(() => {
    _resetForTesting();
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes the raw reply to the debug log when the reply cannot be parsed', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'yg-parse-fail-'));
    initDebugLog(tmpDir, true, appendFn);
    const garbage = 'GARBAGE-NO-VERDICT thinking blah blah no json here at all';
    const result = parseAspectResponse(garbage);
    expect(result?.errorSource).toBe('provider');
    expect(logContent()).toContain(garbage);
  });

  it('notes an empty reply in the debug log', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'yg-parse-empty-'));
    initDebugLog(tmpDir, true, appendFn);
    expect(parseAspectResponse('   ')).toBeUndefined();
    expect(logContent()).toContain('empty');
  });

  it('does NOT write the raw reply when the reply parses successfully', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'yg-parse-ok-'));
    initDebugLog(tmpDir, true, appendFn);
    const result = parseAspectResponse('{"satisfied": true, "reason": "UNIQUE-SUCCESS-MARKER"}');
    expect(result?.satisfied).toBe(true);
    expect(logContent()).not.toContain('UNIQUE-SUCCESS-MARKER');
  });
});
