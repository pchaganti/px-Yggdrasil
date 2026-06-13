import { describe, it, expect } from 'vitest';
import { runExtractor } from './_harness.js';
import { cExtractor } from '../../../../src/relations/extractors/c.js';

const run = (code: string, ext = '.c') => runExtractor(cExtractor, 'c', ext, code);

const specs = (uses: Awaited<ReturnType<typeof run>>['uses']): string[] =>
  uses.flatMap((u) => (u.targetHint.kind === 'path' ? [u.targetHint.specifier] : []));

describe('C extractor — uses()', () => {
  it('emits a path hint for a quoted #include (the header path text, no quotes)', async () => {
    const { uses } = await run('#include "db/connection.h"\n');
    expect(uses).toContainEqual(
      expect.objectContaining({
        targetHint: { kind: 'path', specifier: 'db/connection.h' },
        kind: 'import',
      }),
    );
  });

  it('emits a path hint for a relative quoted include verbatim', async () => {
    const { uses } = await run('#include "../inc/foo.h"\n');
    expect(specs(uses)).toEqual(['../inc/foo.h']);
  });

  it('does NOT emit a hint for an angle-bracket (system) include', async () => {
    const { uses } = await run('#include <stdio.h>\n#include <stdlib.h>\n');
    expect(specs(uses)).toHaveLength(0);
  });

  it('does NOT emit a hint for a macro include (#include HDR — no literal path)', async () => {
    const { uses } = await run('#include HDR\n');
    expect(specs(uses)).toHaveLength(0);
  });

  it('emits only the quoted includes when quoted and angle are mixed', async () => {
    const { uses } = await run('#include <stdio.h>\n#include "a.h"\n#include <string.h>\n#include "b/c.h"\n');
    const s = specs(uses);
    expect(s).toEqual(expect.arrayContaining(['a.h', 'b/c.h']));
    expect(s).toHaveLength(2);
  });

  it('reports the line of each include', async () => {
    const { uses } = await run('\n\n#include "x.h"\n');
    expect(uses[0]?.line).toBe(3);
  });

  it('also extracts includes from a .h header (the .h grammar is C)', async () => {
    const { uses } = await run('#include "shared.h"\n', '.h');
    expect(specs(uses)).toEqual(['shared.h']);
  });
});

describe('C extractor — declarations()', () => {
  it('returns top-level function, struct, and typedef names', async () => {
    const { declarations } = await run(
      'int do_thing(void) { return 1; }\nchar *make(void) { return 0; }\nstruct Point { int x; };\ntypedef int my_int;\n',
    );
    const keys = declarations.map((d) => d.symbolKey);
    expect(keys).toContain('do_thing');
    expect(keys).toContain('make'); // pointer-return function: name behind pointer_declarator
    expect(keys).toContain('Point');
    expect(keys).toContain('my_int');
  });
});
