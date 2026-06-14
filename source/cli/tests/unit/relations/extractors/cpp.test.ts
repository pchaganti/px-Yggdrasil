import { describe, it, expect } from 'vitest';
import { runExtractor } from './_harness.js';
import { cppExtractor } from '../../../../src/relations/extractors/cpp.js';

const run = (code: string, ext = '.cpp') => runExtractor(cppExtractor, 'cpp', ext, code);

const specs = (uses: Awaited<ReturnType<typeof run>>['uses']): string[] =>
  uses.flatMap((u) => (u.targetHint.kind === 'path' ? [u.targetHint.specifier] : []));

describe('C++ extractor — uses()', () => {
  it('emits a path hint for a quoted #include (the header path text, no quotes)', async () => {
    const { uses } = await run('#include "orders/Order.hpp"\n');
    expect(uses).toContainEqual(
      expect.objectContaining({
        targetHint: { kind: 'path', specifier: 'orders/Order.hpp' },
        kind: 'import',
      }),
    );
  });

  it('emits a path hint for a relative quoted include verbatim', async () => {
    const { uses } = await run('#include "../util/Helper.hpp"\n');
    expect(specs(uses)).toEqual(['../util/Helper.hpp']);
  });

  it('does NOT emit a hint for an angle-bracket (system / stdlib) include', async () => {
    const { uses } = await run('#include <vector>\n#include <memory>\n');
    expect(specs(uses)).toHaveLength(0);
  });

  it('does NOT emit a hint for a macro include (#include MYHDR — no literal path)', async () => {
    const { uses } = await run('#include MYHDR\n');
    expect(specs(uses)).toHaveLength(0);
  });

  it('emits only the quoted includes when quoted and angle are mixed', async () => {
    const { uses } = await run('#include <vector>\n#include "A.hpp"\n#include <string>\n#include "b/C.hpp"\n');
    const s = specs(uses);
    expect(s).toEqual(expect.arrayContaining(['A.hpp', 'b/C.hpp']));
    expect(s).toHaveLength(2);
  });

  it('reports the line of each include', async () => {
    const { uses } = await run('\n#include "X.hpp"\n');
    expect(uses[0]?.line).toBe(2);
  });
});

describe('C++ extractor — declarations()', () => {
  it('returns function, class, struct, namespace, and typedef names', async () => {
    const { declarations } = await run(
      'namespace orders { class Order : public Base { int x; }; }\nstruct S {};\ntypedef int my_int;\nvoid run() {}\n',
    );
    const keys = declarations.map((d) => d.symbolKey);
    expect(keys).toContain('orders');
    expect(keys).toContain('Order');
    expect(keys).toContain('S');
    expect(keys).toContain('my_int');
    expect(keys).toContain('run');
  });

  it('emits no symbol for a reference-return function whose declarator drills to null', async () => {
    // `int& r(int& x) { ... }` parses with a reference_declarator that drills to null
    // before any function_declarator is reached → functionName() returns undefined.
    // A plainly-named neighbour is still captured. Exercises the declarator===null
    // branch in the cpp functionName helper.
    const { declarations } = await run('int& r(int& x) { return x; }\nvoid plain() {}\n');
    const keys = declarations.map((d) => d.symbolKey);
    expect(keys).toContain('plain');
    expect(keys).not.toContain('r');
  });
});
