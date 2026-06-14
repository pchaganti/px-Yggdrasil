import { describe, it, expect } from 'vitest';
import { runExtractor } from './_harness.js';
import { phpExtractor } from '../../../../src/relations/extractors/php.js';
import { resolvePhpFqn, type PhpResolveDeps } from '../../../../src/relations/extractors/php-resolve.js';

/**
 * PHP NAME-RESOLUTION IDENTIFICATION MATRIX — characterization, one `it()` per distinct
 * PHP identification form. Each test realizes the concrete PHP source for that exact case
 * and asserts the SPEC-CORRECT, zero-FP outcome.
 *
 * The governing decision (.plans/2026-06-14-import-only-languages-decision.md): the PHP
 * extractor is and stays IMPORT-ONLY. A dependency edge is established ONLY by a `use`
 * class import, whose operand is a fully-qualified name resolved to a file via composer
 * PSR-4. Usage-site forms (`new`, `extends`, type hints, `Foo::class`, attributes, …) are
 * a DELIBERATE tolerated false-negative — silence, not a bug. The one-directional check
 * tolerates recall gaps; it never tolerates a false positive.
 *
 * The zero-FP policy realized here (.plans/2026-06-14-php-name-resolution-research.md):
 *   P1  the import names ONE fully-qualified type; the FQN IS the per-type edge.
 *   P2  the alias is the LOCAL binding, NEVER the target — record the imported FQN.
 *   P3  leading-backslash FQN: strip exactly one `\`; never affected by ns/use.
 *   P4  grouped / nested-group base: leading base + segment is the imported FQN.
 *   P5  `use function` / `use const` import a function/constant, not a class → NO edge.
 *   P6  every usage-site form is SILENT (import-only) — tolerated false-negative.
 *   P7  every dynamic form is SILENT — false-positive source, never emit.
 *   P8  resolution: longest PSR-4 prefix; file under EXACTLY one root → resolved; under
 *       2+ roots → ambiguous → SILENCE (never guess a root); vendor / absent → SILENCE.
 *
 * PASS    → the extractor / resolver already does the spec-correct zero-FP thing (live `it`).
 * GAP     → a deliberate tolerated false-NEGATIVE (silence) per the decision doc (live `it`,
 *           asserting the silence; the suite stays green and documents the boundary).
 * SEALED  → a genuine current false-positive this matrix exposed and fixed (see the PSR-4
 *           2-root ambiguity block).
 */

const run = (code: string) => runExtractor(phpExtractor, 'php', '.php', code);

/** The path specifiers emitted for a file — each `use` import's FQN. */
const specs = (uses: Awaited<ReturnType<typeof run>>['uses']): string[] =>
  uses.flatMap((u) => (u.candidates[0].kind === 'path' ? [u.candidates[0].specifier] : []));

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — import forms that resolve (FQN edge; alias is local, never the target)', () => {
  it('PASS P1: plain `use App\\Foo;` → emits the FQN `App\\Foo`', async () => {
    const s = specs((await run('<?php\nuse App\\Payment\\Gateway;\nclass C {}\n')).uses);
    expect(s).toContain('App\\Payment\\Gateway');
  });

  it('PASS P2: aliased `use App\\Foo as Bar;` → records the FQN, NEVER the alias `Bar`', async () => {
    const s = specs((await run('<?php\nuse App\\Payment\\Gateway as G;\nclass C {}\n')).uses);
    expect(s).toContain('App\\Payment\\Gateway');
    expect(s).not.toContain('G');
    expect(s).not.toContain('App\\Payment\\G');
  });

  it('PASS P3: leading-backslash `use \\App\\Foo;` → strips one backslash → `App\\Foo`', async () => {
    const s = specs((await run('<?php\nuse \\App\\Payment\\Gateway;\nclass C {}\n')).uses);
    expect(s).toContain('App\\Payment\\Gateway');
    expect(s.every((x) => !x.startsWith('\\'))).toBe(true);
  });

  it('PASS P4: grouped `use App\\{A, B};` → one FQN per imported class', async () => {
    const s = specs((await run('<?php\nuse App\\Payment\\{Charge, Refund};\nclass C {}\n')).uses);
    expect(s).toContain('App\\Payment\\Charge');
    expect(s).toContain('App\\Payment\\Refund');
  });

  it('PASS P4: grouped aliased clause `use App\\{Charge, Refund as R};` → FQNs, not the alias', async () => {
    const s = specs((await run('<?php\nuse App\\Payment\\{Charge, Refund as R};\nclass C {}\n')).uses);
    expect(s).toContain('App\\Payment\\Charge');
    expect(s).toContain('App\\Payment\\Refund');
    expect(s).not.toContain('App\\Payment\\R');
  });

  it('PASS P4: nested-group base `use App\\Sub\\{Inner\\Deep, Plain};` → base prepended to each segment', async () => {
    const s = specs((await run('<?php\nuse App\\Sub\\{Inner\\Deep, Plain};\nclass C {}\n')).uses);
    expect(s).toContain('App\\Sub\\Inner\\Deep');
    expect(s).toContain('App\\Sub\\Plain');
  });

  it('PASS P1: namespace alias `use App\\Models;` → emits the imported FQN `App\\Models`', async () => {
    // `use App\Models;` binds the local name `Models`. The extractor emits the imported
    // FQN `App\Models` (a class import shape). The downstream usage `new Models\User()`
    // — where `Models` is a NAMESPACE alias whose member is `App\Models\User` — is a
    // usage-site form and is SILENT (covered by the namespace-alias-usage GAP below); the
    // import itself is the only edge, and it is the FQN, never the local name `Models`.
    const s = specs((await run('<?php\nuse App\\Models;\nclass C {}\n')).uses);
    expect(s).toContain('App\\Models');
    expect(s).not.toContain('Models');
  });

  it('PASS: multi-clause `use A\\X as P, B\\Y as Q;` → both FQNs, no aliases', async () => {
    const s = specs((await run('<?php\nuse App\\A\\Alpha as X, App\\B\\Beta as Y;\nclass C {}\n')).uses);
    expect(s).toContain('App\\A\\Alpha');
    expect(s).toContain('App\\B\\Beta');
    expect(s).not.toContain('App\\A\\X');
    expect(s).not.toContain('App\\B\\Y');
  });

  it('PASS T3 (sibling same-name): the import binds its OWN FQN, never a sibling namespace`s same-name type', async () => {
    // `use App\Http\Request;` in a file whose namespace is `App\Auth` (which could itself
    // hold an `App\Auth\Request`). The import edge is the imported FQN `App\Http\Request`,
    // verbatim — there is no current-namespace prepend, no sibling binding. A same-name
    // `App\Auth\Request` (the bare usage `Request`) is NOT emitted (usage-site, silent),
    // so the import can never mis-bind to the sibling.
    const s = specs(
      (await run('<?php\nnamespace App\\Auth;\nuse App\\Http\\Request;\nclass C {}\n')).uses,
    );
    expect(s).toEqual(['App\\Http\\Request']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — function / const imports (no class edge; sibling class clause still emits)', () => {
  it('PASS P5: `use function App\\f;` → NO edge', async () => {
    const { uses } = await run('<?php\nuse function App\\Util\\format;\nclass C {}\n');
    expect(uses).toHaveLength(0);
  });

  it('PASS P5: `use const App\\C;` → NO edge', async () => {
    const { uses } = await run('<?php\nuse const App\\Util\\MAX;\nclass C {}\n');
    expect(uses).toHaveLength(0);
  });

  it('PASS P5: declaration-level grouped `use function App\\{a, b};` → NO edge', async () => {
    const { uses } = await run('<?php\nuse function App\\Util\\{format, trim};\nclass C {}\n');
    expect(uses).toHaveLength(0);
  });

  it('PASS P5: per-clause `use App\\{function f, Gateway};` → function clause silent, class clause emits', async () => {
    const s = specs((await run('<?php\nuse App\\Pkg\\{function format, Gateway};\nclass C {}\n')).uses);
    expect(s).toEqual(['App\\Pkg\\Gateway']);
  });

  it('PASS P5: per-clause `use App\\{const MAX, Gateway};` → const clause silent, class clause emits', async () => {
    const s = specs((await run('<?php\nuse App\\Pkg\\{const MAX, Gateway};\nclass C {}\n')).uses);
    expect(s).toEqual(['App\\Pkg\\Gateway']);
  });

  it('PASS P5: per-clause guard is position-independent `use App\\{Gateway, function format};`', async () => {
    const s = specs((await run('<?php\nuse App\\Pkg\\{Gateway, function format};\nclass C {}\n')).uses);
    expect(s).toEqual(['App\\Pkg\\Gateway']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — usage-site forms (deliberate tolerated false-NEGATIVE: SILENT, not a bug)', () => {
  // Per .plans/2026-06-14-import-only-languages-decision.md: PHP stays import-only.
  // Every usage-site construct is a tolerated recall gap (silence), explicitly allowed by
  // the one-directional check. Adding usage-site simple-name resolution would reintroduce
  // FP risk (no-global-fallback / sibling same-name traps) and is FORBIDDEN by the decision.

  it('GAP (deliberate recall): `new Foo()` — SILENT (decision doc: import-only)', async () => {
    const { uses } = await run('<?php\nnamespace App;\nclass C { function m() { $o = new Foo(); } }\n');
    expect(uses).toHaveLength(0);
  });

  it('GAP (deliberate recall): `extends` / `implements` — SILENT (decision doc: import-only)', async () => {
    const { uses } = await run(
      '<?php\nnamespace App;\nclass C extends Base implements Flowable, Other {}\n',
    );
    expect(uses).toHaveLength(0);
  });

  it('GAP (deliberate recall): in-class trait `use Timestamps;` — SILENT (decision doc: import-only)', async () => {
    // T6: trait use is namespace-RELATIVE; even so the extractor never reads it (import-only).
    const { uses } = await run('<?php\nnamespace App;\nclass C { use Timestamps; use Ns\\Other; }\n');
    expect(uses).toHaveLength(0);
  });

  it('GAP (deliberate recall): param / return / property types — SILENT (decision doc: import-only)', async () => {
    const { uses } = await run(
      '<?php\nnamespace App;\nclass C { private Repo $r; function m(Logger $l): Result {} }\n',
    );
    expect(uses).toHaveLength(0);
  });

  it('GAP (deliberate recall): `instanceof Foo` — SILENT (decision doc: import-only)', async () => {
    const { uses } = await run(
      '<?php\nnamespace App;\nclass C { function m($x) { return $x instanceof Timer; } }\n',
    );
    expect(uses).toHaveLength(0);
  });

  it('GAP (deliberate recall): `Foo::class` — SILENT (decision doc: import-only)', async () => {
    const { uses } = await run(
      '<?php\nnamespace App;\nclass C { function m() { return Gateway::class; } }\n',
    );
    expect(uses).toHaveLength(0);
  });

  it('GAP (deliberate recall): `Foo::method()` static call — SILENT (decision doc: import-only)', async () => {
    const { uses } = await run(
      '<?php\nnamespace App;\nclass C { function m() { AuditLog::record("x"); } }\n',
    );
    expect(uses).toHaveLength(0);
  });

  it('GAP (deliberate recall): `catch (Foo $e)` / multi `catch (A|B $e)` — SILENT (decision doc: import-only)', async () => {
    const { uses } = await run(
      '<?php\nnamespace App;\nclass C { function m() { try {} catch (DomainError | OtherError $e) {} } }\n',
    );
    expect(uses).toHaveLength(0);
  });

  it('GAP (deliberate recall): attribute `#[Attr]` — SILENT (decision doc: import-only)', async () => {
    const { uses } = await run('<?php\nnamespace App;\n#[Route("/x")]\nclass C {}\n');
    expect(uses).toHaveLength(0);
  });

  it('GAP (deliberate recall): namespace-relative `namespace\\Foo` — SILENT (decision doc: import-only)', async () => {
    const { uses } = await run(
      '<?php\nnamespace App;\nclass C { function m(): namespace\\Foo {} }\n',
    );
    expect(uses).toHaveLength(0);
  });

  it('GAP (deliberate recall): qualified usage via namespace alias `Models\\User` — SILENT (decision doc: import-only)', async () => {
    // The import `use App\Models;` IS emitted (asserted in the import block). Here the bare
    // USAGE `new Models\User()` — whose resolved FQN is `App\Models\User` — is the recall gap.
    const { uses } = await run(
      '<?php\nnamespace App;\nuse App\\Models;\nclass C { function m() { $u = new Models\\User(); } }\n',
    );
    // Only the import edge survives; the usage-site `Models\User` is not separately emitted.
    expect(specs(uses)).toEqual(['App\\Models']);
  });

  it('GAP (deliberate recall): leading-backslash INLINE `new \\App\\X()` — SILENT (decision doc: import-only)', async () => {
    // A fully-qualified inline reference is the one provably-safe recall extension the
    // decision doc flags for OWNER review — NOT auto-implemented. Current behavior: silence.
    const { uses } = await run(
      '<?php\nnamespace App;\nclass C { function m() { $o = new \\App\\Metrics\\Timer(); } }\n',
    );
    expect(uses).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — the 6 trap cases T1–T6 (prove no mis-binding: SILENCE or import-bound target)', () => {
  it('PASS T1 (no global fallback): bare `Logger` with no `use` — SILENT, never `\\Logger` / `Psr\\Log\\Logger`', async () => {
    // `namespace App; class S { function f(Logger $l){} }` with no import. The spec resolves
    // `Logger` to `App\Logger` (no global fallback for classes). Emitting to ANY other Logger
    // node is an FP. The extractor is import-only → SILENT → no possible mis-binding.
    const { uses } = await run(
      '<?php\nnamespace App;\nclass S { function f(Logger $l) {} }\n',
    );
    expect(uses).toHaveLength(0);
  });

  it('PASS T2 (ArrayObject trap): `new ArrayObject` in a namespace — SILENT, never `\\ArrayObject`', async () => {
    // `namespace A\B\C; new ArrayObject;` resolves to `A\B\C\ArrayObject` (no global fallback)
    // — binding to the stdlib `\ArrayObject` would be an FP. Import-only → SILENT.
    const { uses } = await run(
      '<?php\nnamespace A\\B\\C;\nclass S { function f() { return new ArrayObject(); } }\n',
    );
    expect(uses).toHaveLength(0);
  });

  it('PASS T3 (sibling same-name): import binds its own FQN; bare usage is SILENT — no sibling mis-bind', async () => {
    // `use App\Http\Request;` in `namespace App\Auth`. The import edge is `App\Http\Request`.
    // The bare `Request` usage (which would resolve to the IMPORT, not the sibling
    // `App\Auth\Request`) is usage-site → SILENT. No path leads to the sibling.
    const s = specs(
      (
        await run(
          '<?php\nnamespace App\\Auth;\nuse App\\Http\\Request;\nclass C { function m(Request $r) {} }\n',
        )
      ).uses,
    );
    expect(s).toEqual(['App\\Http\\Request']);
  });

  it('PASS T4 (alias matching current ns): `use blah\\blah as foo;` import edge is `blah\\blah`; usages SILENT', async () => {
    // `namespace foo; use blah\blah as foo;` — the import resolves to the FQN `blah\blah`,
    // never the local alias `foo`. The per-token usage duality (`new foo()` → `foo\name`
    // current-ns; `foo::name()` → `blah\blah` import-wins) is usage-site → SILENT. No mis-bind.
    const s = specs(
      (await run('<?php\nnamespace foo;\nuse blah\\blah as foo;\nclass C {}\n')).uses,
    );
    expect(s).toEqual(['blah\\blah']);
  });

  it('PASS T5 (qualified first-segment clash): namespace-alias import edge is its FQN; qualified usage SILENT', async () => {
    // `namespace App\Http; use App\Database as DB;` — the import edge is `App\Database`.
    // The qualified usages `new DB\QueryBuilder()` (→ App\Database\QueryBuilder, import-wins
    // on first segment) and `new Http\Request()` (→ App\Http\Http\Request, current-ns prepend)
    // are usage-site → SILENT. The import never mis-binds; usages emit nothing.
    const s = specs(
      (
        await run('<?php\nnamespace App\\Http;\nuse App\\Database as DB;\nclass C {}\n')
      ).uses,
    );
    expect(s).toEqual(['App\\Database']);
  });

  it('PASS T6 (trait-use relative): top-level `use Baz\\Trait1;` import edge emits; in-class trait `use` SILENT', async () => {
    // `namespace Foo\Bar; use Baz\Trait1; class C { use Trait1; use Foo\Trait2; }`. The
    // top-level `use Baz\Trait1;` is a class/trait IMPORT → edge `Baz\Trait1`. The in-class
    // trait `use Trait1;` (→ Foo\Bar\Trait1) and `use Foo\Trait2;` (→ Foo\Bar\Foo\Trait2,
    // current-ns RELATIVE, never `\Foo\Trait2`) are usage-site → SILENT. No relative mis-bind.
    const s = specs(
      (
        await run(
          '<?php\nnamespace Foo\\Bar;\nuse Baz\\Trait1;\nclass C { use Trait1; use Foo\\Trait2; }\n',
        )
      ).uses,
    );
    expect(s).toEqual(['Baz\\Trait1']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — dynamic forms (false-positive sources: MUST be SILENT)', () => {
  it('PASS P7: `new $var()` — SILENT', async () => {
    const { uses } = await run('<?php\nclass C { function m($var) { return new $var(); } }\n');
    expect(uses).toHaveLength(0);
  });

  it('PASS P7: `$var::method()` — SILENT', async () => {
    const { uses } = await run('<?php\nclass C { function m($var) { return $var::go(); } }\n');
    expect(uses).toHaveLength(0);
  });

  it('PASS P7: `new (expr)()` (8.0+) — SILENT', async () => {
    const { uses } = await run(
      '<?php\nclass C { function m($f) { return new ($f())(); } }\n',
    );
    expect(uses).toHaveLength(0);
  });

  it('PASS P7: `$obj::class` — SILENT', async () => {
    const { uses } = await run('<?php\nclass C { function m($obj) { return $obj::class; } }\n');
    expect(uses).toHaveLength(0);
  });

  it('PASS P7: `class_alias(...)` runtime call — SILENT', async () => {
    const { uses } = await run(
      '<?php\nclass C { function m() { class_alias("App\\\\Foo", "F"); } }\n',
    );
    expect(uses).toHaveLength(0);
  });

  it('PASS P7: `__NAMESPACE__ . "\\X"` string concat — SILENT', async () => {
    const { uses } = await run(
      '<?php\nnamespace App;\nclass C { function m() { $c = __NAMESPACE__ . "\\\\Foo"; return new $c(); } }\n',
    );
    expect(uses).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — PSR-4 resolution (longest prefix; unique-root → resolved; multi-root → SILENCE)', () => {
  const filesUnder = (set: Set<string>): PhpResolveDeps['exists'] => (p) => set.has(p);
  const FROM = 'src/Order/Handler.php';

  it('PASS P8: FQN under the App\\ prefix resolves to its single root file', () => {
    const deps: PhpResolveDeps = {
      psr4For: () => new Map([['App\\', ['src']]]),
      exists: filesUnder(new Set(['src/Payment/Gateway.php'])),
    };
    expect(resolvePhpFqn('App\\Payment\\Gateway', FROM, deps)).toBe('src/Payment/Gateway.php');
  });

  it('PASS P8: longest matching prefix wins (App\\Tests\\ over App\\)', () => {
    const deps: PhpResolveDeps = {
      psr4For: () => new Map([['App\\', ['src']], ['App\\Tests\\', ['tests']]]),
      exists: filesUnder(new Set(['tests/Unit/GatewayTest.php'])),
    };
    expect(resolvePhpFqn('App\\Tests\\Unit\\GatewayTest', FROM, deps)).toBe('tests/Unit/GatewayTest.php');
  });

  it('PASS P8: vendor FQN with no matching prefix → SILENCE', () => {
    const deps: PhpResolveDeps = {
      psr4For: () => new Map([['App\\', ['src']]]),
      exists: filesUnder(new Set(['src/Payment/Gateway.php'])),
    };
    expect(resolvePhpFqn('Psr\\Log\\LoggerInterface', FROM, deps)).toBeUndefined();
  });

  it('PASS P8: one prefix, two roots, file under EXACTLY ONE root → resolved (no false ambiguity)', () => {
    // The common multi-root case: `App\` → ['src','lib'] but the class exists only in src.
    // Exactly one existing file → unambiguous → resolve it. (Anti-over-silencing guard.)
    const deps: PhpResolveDeps = {
      psr4For: () => new Map([['App\\', ['src', 'lib']]]),
      exists: filesUnder(new Set(['src/Pay/G.php'])),
    };
    expect(resolvePhpFqn('App\\Pay\\G', FROM, deps)).toBe('src/Pay/G.php');
  });

  it('SEALED P8 (genuine FP): one prefix, two roots, file exists under BOTH → AMBIGUOUS → SILENCE', () => {
    // GENUINE CURRENT FALSE-POSITIVE this matrix exposed. `App\` → ['src','lib'] and the
    // class file is present under BOTH roots: the FQN genuinely maps to two distinct files
    // (two candidate owner nodes). The pre-fix resolver returned the FIRST hit (src/Pay/G.php),
    // mis-binding to an arbitrary node — an FP, since PSR-4 resolves such a clash arbitrarily
    // at runtime and a static tool must NOT guess a root. Sealed: 2+ distinct hits → SILENCE,
    // mirroring the Java/Go multi-target rule.
    const deps: PhpResolveDeps = {
      psr4For: () => new Map([['App\\', ['src', 'lib']]]),
      exists: filesUnder(new Set(['src/Pay/G.php', 'lib/Pay/G.php'])),
    };
    expect(resolvePhpFqn('App\\Pay\\G', FROM, deps)).toBeUndefined();
  });

  it('PASS P8: catch-all `""` prefix + `App\\` — only one root holds the file → resolves uniquely (no FP)', () => {
    // A `""`-keyed prefix is skipped by parsePsr4 (PSR-4 forbids it), but even if such a map
    // reached the resolver, longest-prefix `App\` is unique and only its root holds the file;
    // the catch-all does not manufacture a second hit. Single hit → resolved, not ambiguous.
    const deps: PhpResolveDeps = {
      psr4For: () => new Map([['App\\', ['src']], ['Legacy\\', ['legacy']]]),
      exists: filesUnder(new Set(['src/Pay/G.php'])),
    };
    expect(resolvePhpFqn('App\\Pay\\G', FROM, deps)).toBe('src/Pay/G.php');
  });
});
