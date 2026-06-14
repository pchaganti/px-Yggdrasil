import { describe, it, expect } from 'vitest';
import { runExtractor } from './_harness.js';
import { cExtractor } from '../../../../src/relations/extractors/c.js';
import { cppExtractor } from '../../../../src/relations/extractors/cpp.js';
import { resolveIncludePath } from '../../../../src/relations/extractors/include-resolve.js';

/**
 * C / C++ #include-PATH IDENTIFICATION MATRIX — characterization, one `it()` per distinct
 * include identification form. Each test realizes the CONCRETE source for that exact case
 * and asserts the SPEC-CORRECT, zero-FP outcome. Two layers are exercised, ONE matrix
 * covering BOTH C and C++ (they share the same include mechanism end to end):
 *   - the EXTRACTOR — `includeUses` is SHARED verbatim by `cExtractor` (`.c`/`.h`) and
 *     `cppExtractor` (`.cpp`/`.cc`/`.cxx`/`.hpp`/`.hh`/`.hxx`); it emits one path SPECIFIER
 *     per QUOTED `#include "header"` and nothing for angle/macro includes; and
 *   - the RESOLVER — `resolveIncludePath` (shared by both grammar branches) canonical-joins
 *     a quoted specifier against the including file's directory and returns the repo-relative
 *     header FILE, or undefined (silence). For every resolving PATH form the same-basename
 *     FP-trap variant (a header with the SAME final name in a DIFFERENT directory that must
 *     NOT be chosen) sits beside the positive.
 *
 * THE GROUP B (path-based) DECISION (.plans/2026-06-14-import-only-languages-decision.md):
 * C/C++ has NO namespace-based module resolution for dependencies — a translation unit
 * depends on another file PURELY by `#include` PATH. Resolution is the canonical
 * quoted-include semantics ONLY: join the header text to the including file's directory and
 * normalize; a MISS is SILENCE. It does NOT resolve by name binding and does NOT probe
 * speculative include roots, so there is no §-precedence simple-name trap and no
 * ancestor-walk decoy. The FP risks are path-resolution-specific and C/C++-shaped:
 *   - a SAME-BASENAME header in the WRONG directory chosen (the headline C/C++ trap —
 *     `a/util.h` vs `b/util.h`, an includer in `a/` doing `#include "util.h"`),
 *   - an ANGLE/system include (`<stdio.h>`, `<vector>`, `<foo/bar.h>`) mapped to an in-repo
 *     file that happens to share the name,
 *   - a speculative include-ROOT walk re-introduced (the ae3403b6 seal — an ancestor /
 *     `include/` probe that grabs a same-basename decoy the compiler would not pick),
 *   - a NON-EXISTENT quoted include (reachable only via an unseen -I flag) resolved to
 *     something rather than silenced,
 *   - an UP-PATH that over-climbs ABOVE the repo root mapped to an out-of-tree file.
 * The cardinal invariant — ZERO false positives, a hard wall with no adopter waiver —
 * outranks recall; a missed edge is a tolerated false-NEGATIVE.
 *
 * The zero-FP policy realized here:
 *   CC1  Only a QUOTED `#include "header"` is an edge. The emitted SPECIFIER is the header
 *        path text exactly as written (quotes stripped). ANGLE includes (`<...>`,
 *        system_lib_string) and MACRO includes (`#include HDR`, identifier path) emit
 *        NOTHING — they never reach the resolver, so a system/third-party header can never
 *        become a violation. An `#include` that is not a real `preproc_include` directive
 *        (inside a `#define` macro body, inside a string literal) emits nothing.
 *   CC2  Resolution is the canonical quoted-include join ONLY: `<dir-of-includer>/<header>`,
 *        normalized. The FULL relative path pins the directory, so a same-basename header in
 *        ANOTHER directory is structurally unreachable — it can only be reached by its OWN
 *        relative path, never mis-chosen. A path that normalizes to escape the repo root
 *        (a `..`-prefixed result) → undefined.
 *   CC3  A MISS → undefined (SILENCE), the single most important false-positive guard:
 *        a non-existent header, an angle/macro include (never reaches here), and a header
 *        reachable only through an unseen compiler -I root ALL silence. No speculative root
 *        walk re-probes ancestor / `include/` dirs (sealed by ae3403b6).
 *   CC4  The C extractor (`.c`/`.h`) and C++ extractor (`.cpp`/`.cc`/…/`.hpp`/`.hh`/…) emit
 *        IDENTICAL specifiers for the same include text, and the SHARED resolver canonical-
 *        joins identically regardless of extension — the `.h`→`.h`, `.cpp`→`.hpp`/`.hh`/`.h`
 *        family distinction is irrelevant to path resolution (it is pure path arithmetic).
 *   CC5  candidate-parity invariant: every emitted reference is a ONE-ELEMENT candidate group
 *        (path languages never widen). Asserted at the end so the matrix can't break parity.
 *
 * PASS    → the extractor / resolver already does the spec-correct zero-FP thing (live `it`).
 * GAP     → a deliberate tolerated false-NEGATIVE (silence), OR a benign textual
 *           over-emission that is NOT one of the defined FP categories (a conditionally-
 *           compiled `#if 0` include is still a real path-correct textual `#include`; the
 *           extractor cannot run the preprocessor, so it emits the literal hint — it can only
 *           ever resolve to the correctly-located, mapped header, never a decoy). Live `it`
 *           asserting the current behavior; the suite stays green and documents the boundary.
 * SEALED   → a genuine current false-positive a matrix exposed and FIXED. The speculative
 *           include-root walk was already sealed on this branch by ae3403b6; this matrix
 *           RE-ASSERTS that seal (the CC3 ancestor-decoy and the same-basename-decoy rows)
 *           so it cannot regress. This matrix itself exposed NO new genuine FP — the
 *           canonical-join-only resolver + the angle/macro emission gate are already zero-FP
 *           across every include form, so every other live row is PASS / GAP and no further
 *           seal was required.
 */

const runC = (code: string, ext = '.c') => runExtractor(cExtractor, 'c', ext, code);
const runCpp = (code: string, ext = '.cpp') => runExtractor(cppExtractor, 'cpp', ext, code);

/** The header-path specifiers emitted for a file — each quoted `#include`'s path text. */
const specs = (uses: Awaited<ReturnType<typeof runC>>['uses']): string[] =>
  uses.flatMap((u) => (u.candidates[0].kind === 'path' ? [u.candidates[0].specifier] : []));

// A reusable resolver known-set keyed by repo-relative POSIX path. The SAME-BASENAME traps
// are baked in:
//   util.h lives in BOTH src/a and src/b (the headline C/C++ trap twin).
//   foo.h  lives in BOTH src/a and src/b (relative-include trap twin).
//   vector / stdio.h / foo/bar.h exist in-repo ON PURPOSE so the angle-include guard is
//   proven NOT to be a file probe (the extractor never emits them, so they never resolve).
const KNOWN = new Set<string>([
  'src/a/foo.h', // relative include target
  'src/b/foo.h', // same-basename TRAP twin in another dir
  'src/a/sub/foo.h', // sub-path target
  'src/inc/foo.h', // up-path target (sibling-of-parent dir)
  'src/a/util.h', // headline same-basename target (a side)
  'src/b/util.h', // headline same-basename TRAP twin (b side)
  'root.h', // up-path-to-root target
  'top.h', // ancestor-decoy header (only at repo root)
  'src/a/Order.hpp', // C++ relative include target
  'src/b/Order.hpp', // C++ same-basename TRAP twin
  // In-repo files NAMED like system headers — the angle-guard FP traps. The extractor never
  // emits an angle specifier, so these are unreachable; included to prove the guard is at
  // emission, not a same-name file probe.
  'src/a/stdio.h',
  'src/a/vector',
  'src/a/foo/bar.h',
]);
const exists = (p: string) => KNOWN.has(p);
const R = (header: string, fromFile: string) => resolveIncludePath(header, fromFile, exists);

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — quoted relative include (the header path IS the edge; canonical dir-join)', () => {
  it('PASS CC1 (C): `#include "foo.h"` → emits the bare path `foo.h` (quotes stripped)', async () => {
    expect(specs((await runC('#include "foo.h"\n')).uses)).toEqual(['foo.h']);
  });

  it('PASS CC2 (C): `foo.h` from `src/a/main.c` → `src/a/foo.h` (same-directory canonical join)', () => {
    expect(R('foo.h', 'src/a/main.c')).toBe('src/a/foo.h');
  });

  it('PASS CC2 (same-basename trap): `foo.h` from `src/a/main.c` → `src/a/foo.h`, NEVER `src/b/foo.h`', () => {
    // `src/a/foo.h` and `src/b/foo.h` share the basename `foo.h` but are distinct files. The
    // canonical join pins the includer's directory (src/a), so the same-basename file in
    // src/b is structurally unreachable from src/a — it can only be reached by its own
    // relative path. The leaf collision can never mis-bind.
    expect(R('foo.h', 'src/a/main.c')).toBe('src/a/foo.h');
    // The flip side: the b-side includer reaches ONLY its own src/b/foo.h.
    expect(R('foo.h', 'src/b/main.c')).toBe('src/b/foo.h');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — quoted sub-path include (relative to the including file dir)', () => {
  it('PASS CC1 (C): `#include "sub/foo.h"` → emits `sub/foo.h`', async () => {
    expect(specs((await runC('#include "sub/foo.h"\n')).uses)).toEqual(['sub/foo.h']);
  });

  it('PASS CC2 (C): `sub/foo.h` from `src/a/main.c` → `src/a/sub/foo.h` (joined under the includer dir)', () => {
    expect(R('sub/foo.h', 'src/a/main.c')).toBe('src/a/sub/foo.h');
  });

  it('PASS CC2 (trap): `sub/foo.h` is NOT the same as the bare `foo.h` — distinct relative paths reach distinct files', () => {
    // The sub-path names a NESTED file; it must never collapse to the same-basename
    // `src/a/foo.h`. Each relative path reaches only its own joined file.
    expect(R('sub/foo.h', 'src/a/main.c')).toBe('src/a/sub/foo.h');
    expect(R('foo.h', 'src/a/main.c')).toBe('src/a/foo.h');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — quoted up-path include (canonical join climbing `../`; over-climb → SILENCE)', () => {
  it('PASS CC1 (C): `#include "../inc/foo.h"` → emits `../inc/foo.h` verbatim', async () => {
    expect(specs((await runC('#include "../inc/foo.h"\n')).uses)).toEqual(['../inc/foo.h']);
  });

  it('PASS CC2 (C): `../inc/foo.h` from `src/a/main.c` → `src/inc/foo.h` (climbs one level, then descends)', () => {
    expect(R('../inc/foo.h', 'src/a/main.c')).toBe('src/inc/foo.h');
  });

  it('PASS CC2: `../../root.h` from `src/a/main.c` → `root.h` (a legitimate climb to the repo root)', () => {
    // Two `../` from src/a lands at the repo root, where root.h lives. This is a valid in-repo
    // climb — distinct from an OVER-climb that escapes the root (below).
    expect(R('../../root.h', 'src/a/main.c')).toBe('root.h');
  });

  it('PASS CC2 (over-climb guard): `../../x.h` from `main.c` (a repo-root file) → SILENCE (escapes the repo)', () => {
    // The includer is at the repo root, so two `../` climbs ABOVE the root. The normalized
    // path is `..`-prefixed; normalizeRepoRel rejects any path that escapes the repo root →
    // undefined. Never an out-of-tree file. (`x.h` need not exist — the escape is rejected
    // before any existence probe.)
    expect(R('../../x.h', 'main.c')).toBeUndefined();
  });

  it('PASS CC3 (ancestor decoy — the ae3403b6 SEAL re-asserted): `top.h` from `src/a/main.c` → SILENCE even though `top.h` exists at the repo root', () => {
    // top.h exists ONLY at the repo root — reachable solely through the DROPPED speculative
    // include-root walk (an ancestor / `include/` probe). The canonical relative join
    // `src/a/top.h` misses; the walk is gone, so the same-basename decoy at the ancestor root
    // is never grabbed → silence. RE-ASSERTS the ae3403b6 seal so it cannot regress.
    expect(R('top.h', 'src/a/main.c')).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — angle / system include (SILENCE; emission gate, NOT a same-name file probe)', () => {
  it('PASS CC1 (C): `#include <stdio.h>` → emits NOTHING even though `src/a/stdio.h` exists in-repo', async () => {
    // An angle include is a system_lib_string path node; the extractor never emits it, so it
    // never reaches the resolver. The same-named in-repo `src/a/stdio.h` is therefore
    // unreachable through this directive — no edge can be fabricated. The guard is at
    // EMISSION (the `string_literal`-only gate), never a probe of a same-name file.
    expect(specs((await runC('#include <stdio.h>\n')).uses)).toEqual([]);
  });

  it('PASS CC1 (C++): `#include <vector>` → emits NOTHING even though `src/a/vector` exists in-repo', async () => {
    expect(specs((await runCpp('#include <vector>\n')).uses)).toEqual([]);
  });

  it('PASS CC1 (C): `#include <foo/bar.h>` (angle sub-path) → emits NOTHING even though `src/a/foo/bar.h` exists', async () => {
    // Even a multi-segment angle path that would canonical-join to a real in-repo file is
    // silenced at emission — angle includes are NEVER a repo dependency in this model.
    expect(specs((await runC('#include <foo/bar.h>\n')).uses)).toEqual([]);
  });

  it('PASS CC1 (C): mixed quoted + angle → ONLY the quoted specifiers emit', async () => {
    const s = specs(
      (await runC('#include <stdio.h>\n#include "foo.h"\n#include <string.h>\n#include "sub/foo.h"\n')).uses,
    );
    expect(s).toEqual(['foo.h', 'sub/foo.h']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — non-existent quoted include (no speculative search → SILENCE)', () => {
  it('PASS CC3 (C): `#include "nope.h"` with NO sibling nope.h → emits the specifier but resolves to SILENCE', async () => {
    // The extractor emits `nope.h` (it cannot know whether it exists); the resolver gates it:
    // the canonical join `src/a/nope.h` does not exist and there is NO speculative search →
    // undefined. A header reachable only through an unseen -I root stays silent.
    expect(specs((await runC('#include "nope.h"\n')).uses)).toEqual(['nope.h']);
    expect(R('nope.h', 'src/a/main.c')).toBeUndefined();
  });

  it('PASS CC3: a quoted sub-path that does not exist relative to the includer → SILENCE', () => {
    expect(R('missing/deep.h', 'src/a/main.c')).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — same-basename trap across directories (the HEADLINE C/C++ FP risk)', () => {
  it('PASS CC2: an includer in `src/a/` doing `#include "util.h"` binds `src/a/util.h`, NEVER `src/b/util.h`', () => {
    // The single most important C/C++ trap: `src/a/util.h` and `src/b/util.h` both exist. The
    // canonical join pins the includer's own directory, so an includer in src/a reaches ONLY
    // src/a/util.h. The b-side twin is structurally unreachable from src/a — there is no
    // directory walk, no basename search, no -I probe that could reach across to it.
    expect(R('util.h', 'src/a/main.c')).toBe('src/a/util.h');
  });

  it('PASS CC2 (the b side): the SAME `#include "util.h"` from `src/b/` binds `src/b/util.h`, NEVER `src/a/util.h`', () => {
    // The mirror: each includer's directory pins its own util.h. The identical include TEXT
    // resolves to a DIFFERENT file depending on the includer's location — exactly the
    // canonical quoted-include semantics, and exactly why the basename collision is safe.
    expect(R('util.h', 'src/b/main.c')).toBe('src/b/util.h');
  });

  it('PASS CC1: both includers emit the IDENTICAL specifier `util.h` (the dir disambiguation is the resolver, not the text)', async () => {
    // The extractor output is location-independent — it emits the literal `util.h` in both
    // files. The directory disambiguation happens entirely in the resolver via the includer's
    // own dir, never by guessing in the extractor.
    expect(specs((await runC('#include "util.h"\n')).uses)).toEqual(['util.h']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — C vs C++ extensions (shared extractor + shared resolver, identical behavior)', () => {
  it('PASS CC4: a `.h` header (C grammar) and a `.hpp` header (C++ grammar) emit the SAME specifier for the same include', async () => {
    // The `.h` extension binds the C grammar; `.hpp` binds the C++ grammar. Both route through
    // the SHARED `includeUses`, so the emitted specifier is byte-identical.
    expect(specs((await runC('#include "shared.h"\n', '.h')).uses)).toEqual(['shared.h']);
    expect(specs((await runCpp('#include "shared.h"\n', '.hpp')).uses)).toEqual(['shared.h']);
  });

  it('PASS CC4: the C++ extension family `.cpp`/`.cc`/`.cxx` all emit a quoted include identically', async () => {
    expect(specs((await runCpp('#include "A.hpp"\n', '.cpp')).uses)).toEqual(['A.hpp']);
    expect(specs((await runCpp('#include "A.hh"\n', '.cc')).uses)).toEqual(['A.hh']);
    expect(specs((await runCpp('#include "A.hxx"\n', '.cxx')).uses)).toEqual(['A.hxx']);
  });

  it('PASS CC4 (C++): `#include "Order.hpp"` from `src/a/main.cpp` → `src/a/Order.hpp`, NEVER `src/b/Order.hpp`', () => {
    // The shared resolver canonical-joins a C++ header exactly like a C header — pure path
    // arithmetic, extension-agnostic. The same-basename trap holds for `.hpp` just as for `.h`.
    expect(R('Order.hpp', 'src/a/main.cpp')).toBe('src/a/Order.hpp');
    expect(R('Order.hpp', 'src/b/main.cpp')).toBe('src/b/Order.hpp');
  });

  it('PASS CC4: the resolver gives byte-identical results for a C-extension and a C++-extension includer in the same dir', () => {
    // include-resolve.ts never reads the extension; `foo.h` from `src/a/main.c` and from
    // `src/a/main.cpp` resolve identically. The C/C++ split is irrelevant to path resolution.
    expect(R('foo.h', 'src/a/main.c')).toBe('src/a/foo.h');
    expect(R('foo.h', 'src/a/main.cpp')).toBe('src/a/foo.h');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — guards / pragma / macro-bodies (no include directive → no dependency)', () => {
  it('PASS CC1 (C): `#pragma once` → emits NOTHING (not an include directive)', async () => {
    expect(specs((await runC('#pragma once\nint x;\n')).uses)).toEqual([]);
  });

  it('PASS CC1 (C): a classic include guard `#ifndef/#define/#endif` → emits NOTHING (no `#include`)', async () => {
    expect(specs((await runC('#ifndef FOO_H\n#define FOO_H\nint x;\n#endif\n')).uses)).toEqual([]);
  });

  it('PASS CC1 (C): a quoted path that appears ONLY inside a `#define` macro BODY → emits NOTHING', async () => {
    // `#define INC #include "secret.h"` is a macro definition whose body contains include-like
    // tokens; it is NOT a `preproc_include` directive (it is a `preproc_def`), so the walk
    // never sees an include node → no specifier. A path inside macro tokens is unparsed by
    // design (cannot be a guess = no FP).
    expect(specs((await runC('#define INC #include "secret.h"\nint x;\n')).uses)).toEqual([]);
  });

  it('PASS CC1 (C): a path-looking string LITERAL in ordinary code (`const char *p = "fake.h";`) → emits NOTHING', async () => {
    // Only a `preproc_include` node is read; a string literal in an expression is never an
    // include directive. No edge can be fabricated from code text that merely looks like a path.
    expect(specs((await runC('const char *p = "fake.h";\n')).uses)).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — computed / macro include (no literal path → SILENCE)', () => {
  it('PASS CC1 (C): `#include HDR` (bare macro) → emits NOTHING (identifier path, no literal)', async () => {
    expect(specs((await runC('#include HDR\n')).uses)).toEqual([]);
  });

  it('PASS CC1 (C): a `#define HDR "real.h"` then `#include HDR` → still emits NOTHING (the include operand is a macro identifier, not a string)', async () => {
    // The resolver never runs the preprocessor; the include's path field is an `identifier`
    // (HDR), not a `string_literal`, so the emission gate skips it. The macro expansion that a
    // compiler would perform is invisible here → silence, never a guess at the expanded path.
    expect(specs((await runC('#define HDR "real.h"\n#include HDR\n')).uses)).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — empty / malformed quoted include', () => {
  it('PASS CC1 (C): an empty quoted include `#include ""` → emits NOTHING (the bare "" yields no path)', async () => {
    // The `string_literal` has no `string_content` child; the fallback strips the two quote
    // chars to '', which the emitter discards (headerPath === '').
    expect(specs((await runC('#include ""\n')).uses)).toEqual([]);
  });

  it('PASS CC3: an empty specifier at the resolver → SILENCE', () => {
    expect(R('', 'src/a/main.c')).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — conditionally-compiled include (`#if 0`) — benign textual over-emission, NEVER a decoy', () => {
  it('GAP: a `#if 0 … #include "dead.h" … #endif` → STILL emits `dead.h` (the extractor does not run the preprocessor)', async () => {
    // The extractor walks the AST and sees a real `preproc_include` directive inside an
    // `#if 0` block, so it emits the literal `dead.h`. It does NOT evaluate preprocessor
    // conditionals (that needs a full preprocessor this v1 layer deliberately does not run).
    // This is a tolerated textual OVER-emission, NOT one of the defined FP categories: the
    // emitted hint is the literal, correctly-spelled path, so it can only ever resolve to the
    // correctly-LOCATED, mapped `dead.h` next to the includer — never a same-basename decoy in
    // another directory, never an angle/system header, never a speculative-root grab. If
    // `dead.h` does not exist relative to the includer (the usual case for dead code), the
    // resolver silences it (CC3). Distinguishing live from dead `#include`s would require a
    // preprocessor and risks UNDER-emission; sealing this would be a recall change, not an FP
    // fix. Surfaced as a recall note, not auto-changed.
    expect(specs((await runC('#if 0\n#include "dead.h"\n#endif\n')).uses)).toEqual(['dead.h']);
  });

  it('PASS CC3: that same `dead.h` resolves to SILENCE when no `dead.h` exists relative to the includer', () => {
    // The benign-over-emission claim above, proven: with no `src/a/dead.h` in the known-set,
    // the literal hint canonical-joins to a miss → undefined. The over-emitted hint cannot
    // become an edge unless a real, correctly-located, mapped header backs it.
    expect(R('dead.h', 'src/a/main.c')).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — candidate-parity invariant (path languages emit ONE-ELEMENT groups, never widen)', () => {
  it('PASS CC5 (C): every emitted reference across mixed include forms is a one-element path group', async () => {
    const { uses } = await runC(
      [
        '#include <stdio.h>',
        '#include "foo.h"',
        '#include "sub/foo.h"',
        '#include "../inc/foo.h"',
        '#include HDR',
        '#include ""',
        '#include "util.h"',
      ].join('\n'),
    );
    expect(uses.length).toBeGreaterThan(0);
    for (const dep of uses) {
      expect(dep.candidates).toHaveLength(1);
      expect(dep.candidates[0].kind).toBe('path');
    }
  });

  it('PASS CC5 (C++): every emitted reference across mixed include forms is a one-element path group', async () => {
    const { uses } = await runCpp(
      ['#include <vector>', '#include "Order.hpp"', '#include "../util/Helper.hpp"', '#include MYHDR'].join(
        '\n',
      ),
    );
    expect(uses.length).toBeGreaterThan(0);
    for (const dep of uses) {
      expect(dep.candidates).toHaveLength(1);
      expect(dep.candidates[0].kind).toBe('path');
    }
  });
});
