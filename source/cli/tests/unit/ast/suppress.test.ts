import { describe, it, expect } from 'vitest';
import { collectSuppressions, isLineSuppressed, formatSuppressedRangesForAspect, SuppressMarkerError } from '../../../src/ast/suppress.js';
import { parseFile } from '../../../src/ast/parser.js';

describe('suppress: language-aware comment resolution', () => {
  it('Rust: yg-suppress on line_comment is detected', async () => {
    const code = `fn foo() {}\n// yg-suppress(my-aspect) reason here\nfn bar() {}`;
    const tree = await parseFile('a.rs', code);
    const n = code.split('\n').length;
    const ranges = collectSuppressions(tree, 'a.rs', n);
    expect(isLineSuppressed(ranges, 'my-aspect', 3)).toBe(true);
    expect(isLineSuppressed(ranges, 'my-aspect', 1)).toBe(false);
  });

  it('Java: yg-suppress on line_comment is detected', async () => {
    const code = `class A {}\n// yg-suppress(my-aspect) reason here\nclass B {}`;
    const tree = await parseFile('A.java', code);
    const n = code.split('\n').length;
    const ranges = collectSuppressions(tree, 'A.java', n);
    expect(isLineSuppressed(ranges, 'my-aspect', 3)).toBe(true);
    expect(isLineSuppressed(ranges, 'my-aspect', 1)).toBe(false);
  });

  it('Kotlin: yg-suppress on line_comment is detected', async () => {
    const code = `fun foo() {}\n// yg-suppress(my-aspect) reason here\nfun bar() {}`;
    const tree = await parseFile('a.kt', code);
    const n = code.split('\n').length;
    const ranges = collectSuppressions(tree, 'a.kt', n);
    expect(isLineSuppressed(ranges, 'my-aspect', 3)).toBe(true);
    expect(isLineSuppressed(ranges, 'my-aspect', 1)).toBe(false);
  });

  it('unknown extension with no content arg returns empty suppressions (no throw)', async () => {
    // An unrecognised extension has no grammar, so there are no comment nodes to
    // walk. With no `content` supplied there is nothing to scan either, so the
    // result is empty (rather than throwing).
    const code = `const x = 1;\n// yg-suppress(my-aspect) reason\nconst y = 2;`;
    const tree = await parseFile('x.ts', code);
    // Pass a file path with an unknown extension and omit content.
    const ranges = collectSuppressions(tree, 'file.unknownext', 3);
    expect(ranges).toEqual([]);
  });
});

describe('suppress: non-AST languages (raw-line text scan)', () => {
  // A file whose extension has no registered grammar (.sql, .sh, …) cannot be
  // parsed, so markers are found by scanning the raw `content` lines. This is
  // what lets a content-only deterministic check waive a violation in such a file.
  it('SQL: single-line marker (-- comment) suppresses the following line', () => {
    const code = `SELECT 1;\n-- yg-suppress(no-select-star) legacy report, columns are stable\nSELECT * FROM t;`;
    const ranges = collectSuppressions(undefined, 'q.sql', code.split('\n').length, code);
    expect(isLineSuppressed(ranges, 'no-select-star', 3)).toBe(true);
    expect(isLineSuppressed(ranges, 'no-select-star', 1)).toBe(false);
  });

  it('Shell: # comment marker is recognised regardless of comment syntax', () => {
    const code = `echo start\n# yg-suppress(no-pipe-to-shell) vendored installer, reviewed\ncurl https://x | sh`;
    const ranges = collectSuppressions(undefined, 'install.sh', code.split('\n').length, code);
    expect(isLineSuppressed(ranges, 'no-pipe-to-shell', 3)).toBe(true);
  });

  it('SQL: disable/enable range scanned from raw lines', () => {
    const code = [
      '-- yg-suppress-disable(no-select-star) bulk migration block',
      'SELECT * FROM a;',
      'SELECT * FROM b;',
      '-- yg-suppress-enable(no-select-star)',
      'SELECT * FROM c;',
    ].join('\n');
    const ranges = collectSuppressions(undefined, 'm.sql', code.split('\n').length, code);
    expect(isLineSuppressed(ranges, 'no-select-star', 2)).toBe(true);
    expect(isLineSuppressed(ranges, 'no-select-star', 3)).toBe(true);
    // line 5 is past the enable marker — not suppressed.
    expect(isLineSuppressed(ranges, 'no-select-star', 5)).toBe(false);
  });

  it('multi-aspect marker in a non-AST file applies to every listed aspect', () => {
    const code = `SELECT 1;\n-- yg-suppress(rule-a, rule-b) shared waiver\nSELECT * FROM t;`;
    const ranges = collectSuppressions(undefined, 'q.sql', code.split('\n').length, code);
    expect(isLineSuppressed(ranges, 'rule-a', 3)).toBe(true);
    expect(isLineSuppressed(ranges, 'rule-b', 3)).toBe(true);
    expect(isLineSuppressed(ranges, 'rule-c', 3)).toBe(false);
  });

  it('a marker with no reason in a non-AST file still throws', () => {
    const code = `-- yg-suppress(no-select-star)\nSELECT * FROM t;`;
    expect(() => collectSuppressions(undefined, 'q.sql', 2, code)).toThrow(SuppressMarkerError);
  });
});

describe('suppress: single-line form', () => {
  it('yg-suppress applies to immediately following line', async () => {
    const code = `const x = 1;\n// yg-suppress(async-fs) refactor planned\nfs.readFileSync('a');\nfs.readFileSync('b');`;
    const tree = await parseFile('x.ts', code);
    const n = code.split('\n').length;
    const ranges = collectSuppressions(tree, 'x.ts', n);
    expect(isLineSuppressed(ranges, 'async-fs', 3)).toBe(true);
    expect(isLineSuppressed(ranges, 'async-fs', 4)).toBe(false);
  });

  it('rejects empty reason', async () => {
    const code = `// yg-suppress(async-fs)\nfs.readFileSync('a');`;
    const tree = await parseFile('x.ts', code);
    expect(() => collectSuppressions(tree, 'x.ts', 2)).toThrow(SuppressMarkerError);
  });

  it('does NOT match yg-suppress in string literal', async () => {
    const code = `const banner = "yg-suppress(async-fs) this is just a string";\nfs.readFileSync('a');`;
    const tree = await parseFile('x.ts', code);
    const ranges = collectSuppressions(tree, 'x.ts', 2);
    expect(isLineSuppressed(ranges, 'async-fs', 2)).toBe(false);
  });

  it('multi-aspect: yg-suppress(a, b) applies both', async () => {
    const code = `// yg-suppress(async-fs, posix-paths) cleanup\nfs.readFileSync('x');`;
    const tree = await parseFile('x.ts', code);
    const ranges = collectSuppressions(tree, 'x.ts', 2);
    expect(isLineSuppressed(ranges, 'async-fs', 2)).toBe(true);
    expect(isLineSuppressed(ranges, 'posix-paths', 2)).toBe(true);
    expect(isLineSuppressed(ranges, 'unrelated', 2)).toBe(false);
  });
});

describe('suppress: bracket form', () => {
  it('single disable/enable cycle', async () => {
    const code = `// yg-suppress-disable(async-fs) refactor planned\nfs.readFileSync('a');\nfs.readFileSync('b');\n// yg-suppress-enable(async-fs)\nfs.readFileSync('c');`;
    const tree = await parseFile('x.ts', code);
    const ranges = collectSuppressions(tree, 'x.ts', 5);
    expect(isLineSuppressed(ranges, 'async-fs', 2)).toBe(true);
    expect(isLineSuppressed(ranges, 'async-fs', 3)).toBe(true);
    expect(isLineSuppressed(ranges, 'async-fs', 5)).toBe(false);
  });

  it('disable without enable extends to EOF', async () => {
    const code = `// yg-suppress-disable(async-fs) until ticket-X\na(); b(); c();`;
    const tree = await parseFile('x.ts', code);
    const ranges = collectSuppressions(tree, 'x.ts', 2);
    expect(isLineSuppressed(ranges, 'async-fs', 2)).toBe(true);
  });

  it('multi-aspect disable/enable independently', async () => {
    const code = [
      `// yg-suppress-disable(async-fs, posix-paths) cleanup queued`,
      `a();`,
      `// yg-suppress-enable(async-fs)`,
      `b();`,
      `// yg-suppress-enable(posix-paths)`,
      `c();`,
    ].join('\n');
    const tree = await parseFile('x.ts', code);
    const ranges = collectSuppressions(tree, 'x.ts', 6);
    expect(isLineSuppressed(ranges, 'async-fs', 2)).toBe(true);
    expect(isLineSuppressed(ranges, 'async-fs', 4)).toBe(false);
    expect(isLineSuppressed(ranges, 'posix-paths', 4)).toBe(true);
    expect(isLineSuppressed(ranges, 'posix-paths', 6)).toBe(false);
  });

  it('empty reason on disable rejected', async () => {
    const code = `// yg-suppress-disable(async-fs)\nfs.readFileSync('a');`;
    const tree = await parseFile('x.ts', code);
    expect(() => collectSuppressions(tree, 'x.ts', 2)).toThrow(SuppressMarkerError);
  });

  it('block comment disable/enable', async () => {
    const code = `/* yg-suppress-disable(async-fs) refactor planned */\nfs.readFileSync('a');\n/* yg-suppress-enable(async-fs) */\nfs.readFileSync('b');`;
    const tree = await parseFile('x.ts', code);
    const ranges = collectSuppressions(tree, 'x.ts', 4);
    expect(isLineSuppressed(ranges, 'async-fs', 2)).toBe(true);
    expect(isLineSuppressed(ranges, 'async-fs', 4)).toBe(false);
  });
});

describe('suppress: wildcard semantics', () => {
  it('disable(*) suppresses all aspects', async () => {
    const code = `// yg-suppress-disable(*) cleanup\nfs.readFileSync('x');\nconsole.log('x');\n// yg-suppress-enable(*)\nconsole.log('y');`;
    const tree = await parseFile('x.ts', code);
    const ranges = collectSuppressions(tree, 'x.ts', 5);
    expect(isLineSuppressed(ranges, 'async-fs', 2)).toBe(true);
    expect(isLineSuppressed(ranges, 'no-console', 2)).toBe(true);
    expect(isLineSuppressed(ranges, 'async-fs', 5)).toBe(false);
  });

  it('specific enable does NOT punch through wildcard disable', async () => {
    const code = `// yg-suppress-disable(*) cleanup\nfs.readFileSync('x');\n// yg-suppress-enable(async-fs)\nfs.readFileSync('y');\nconsole.log('z');`;
    const tree = await parseFile('x.ts', code);
    const ranges = collectSuppressions(tree, 'x.ts', 5);
    expect(isLineSuppressed(ranges, 'async-fs', 4)).toBe(true);
    expect(isLineSuppressed(ranges, 'no-console', 5)).toBe(true);
  });

  it('enable(*) closes wildcard but leaves specific opens', async () => {
    const code = [
      `// yg-suppress-disable(async-fs) ticket-1`,
      `// yg-suppress-disable(*) ticket-2`,
      `a();`,
      `// yg-suppress-enable(*)`,
      `b();`,
    ].join('\n');
    const tree = await parseFile('x.ts', code);
    const ranges = collectSuppressions(tree, 'x.ts', 5);
    expect(isLineSuppressed(ranges, 'async-fs', 5)).toBe(true);
    expect(isLineSuppressed(ranges, 'no-console', 5)).toBe(false);
  });
});

describe('formatSuppressedRangesForAspect', () => {
  it('single-line marker → one 1-line span on the line below the marker', async () => {
    const code = [`a();`, `// yg-suppress(my-aspect) reason`, `b();`].join('\n');
    const tree = await parseFile('x.ts', code);
    const ranges = collectSuppressions(tree, 'x.ts', 3);
    expect(formatSuppressedRangesForAspect(ranges, 'my-aspect')).toEqual([{ startLine: 3, endLine: 3 }]);
  });

  it('bracket marker → the full disable..enable span', async () => {
    const code = [
      `// yg-suppress-disable(my-aspect) reason`,
      `a();`,
      `b();`,
      `// yg-suppress-enable(my-aspect)`,
      `c();`,
    ].join('\n');
    const tree = await parseFile('x.ts', code);
    const ranges = collectSuppressions(tree, 'x.ts', 5);
    // disable on line 1 opens at line 2; enable on line 4 closes at line 3.
    expect(formatSuppressedRangesForAspect(ranges, 'my-aspect')).toEqual([{ startLine: 2, endLine: 3 }]);
  });

  it('lone disable (no enable) → span runs to EOF (totalLines)', async () => {
    const code = [`// yg-suppress-disable(my-aspect) reason`, `a();`, `b();`].join('\n');
    const tree = await parseFile('x.ts', code);
    const ranges = collectSuppressions(tree, 'x.ts', 3);
    expect(formatSuppressedRangesForAspect(ranges, 'my-aspect')).toEqual([{ startLine: 2, endLine: 3 }]);
  });

  it('wildcard marker applies to ANY aspect id', async () => {
    const code = [`a();`, `// yg-suppress(*) reason`, `b();`].join('\n');
    const tree = await parseFile('x.ts', code);
    const ranges = collectSuppressions(tree, 'x.ts', 3);
    expect(formatSuppressedRangesForAspect(ranges, 'whatever-id')).toEqual([{ startLine: 3, endLine: 3 }]);
    expect(formatSuppressedRangesForAspect(ranges, 'another-id')).toEqual([{ startLine: 3, endLine: 3 }]);
  });

  it('returns [] when no range applies to the aspect', async () => {
    const code = [`a();`, `// yg-suppress(other-aspect) reason`, `b();`].join('\n');
    const tree = await parseFile('x.ts', code);
    const ranges = collectSuppressions(tree, 'x.ts', 3);
    expect(formatSuppressedRangesForAspect(ranges, 'my-aspect')).toEqual([]);
  });

  it('spans are sorted by startLine then endLine', async () => {
    const code = [
      `a();`,
      `// yg-suppress(my-aspect) reason A`,
      `b();`,
      `c();`,
      `// yg-suppress(my-aspect) reason B`,
      `d();`,
    ].join('\n');
    const tree = await parseFile('x.ts', code);
    const ranges = collectSuppressions(tree, 'x.ts', 6);
    expect(formatSuppressedRangesForAspect(ranges, 'my-aspect')).toEqual([
      { startLine: 3, endLine: 3 },
      { startLine: 6, endLine: 6 },
    ]);
  });
});
