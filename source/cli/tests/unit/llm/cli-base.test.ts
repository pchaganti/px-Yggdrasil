import { describe, it, expect } from 'vitest';
import { parseAspectResponse } from '../../../src/llm/cli-base.js';

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
