import { describe, it, expect } from 'vitest';
import { collectSuppressions, isLineSuppressed, SuppressMarkerError } from '../../../src/ast/suppress.js';
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

  it('unknown extension returns empty suppressions (no throw)', async () => {
    // We cannot parse an unknown extension with parseFile (it would throw),
    // so we use a TypeScript tree but pass an unknown file path — simulating
    // what happens when collectSuppressions receives a tree for an unrecognised file.
    const code = `const x = 1;\n// yg-suppress(my-aspect) reason\nconst y = 2;`;
    const tree = await parseFile('x.ts', code);
    // Pass a file path with an unknown extension
    const ranges = collectSuppressions(tree, 'file.unknownext', 3);
    expect(ranges).toEqual([]);
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
