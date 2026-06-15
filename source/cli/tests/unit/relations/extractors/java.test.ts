import { describe, it, expect } from 'vitest';
import { runExtractor } from './_harness.js';
import { javaExtractor } from '../../../../src/relations/extractors/java.js';

const run = (code: string) => runExtractor(javaExtractor, 'java', '.java', code);

const specs = (uses: Awaited<ReturnType<typeof run>>['uses']): string[] =>
  uses.flatMap((u) => (u.candidates[0].kind === 'path' ? [u.candidates[0].specifier] : []));

const hintFor = (
  uses: Awaited<ReturnType<typeof run>>['uses'],
  specifier: string,
): Extract<(typeof uses)[number]['candidates'][number], { kind: 'path' }> | undefined =>
  uses
    .map((u) => u.candidates[0])
    .find((h): h is Extract<typeof h, { kind: 'path' }> =>
      h.kind === 'path' && h.specifier === specifier,
    );

describe('java extractor — uses()', () => {
  it('emits the type FQN for a single-type import', async () => {
    const { uses } = await run('import com.acme.payments.PaymentService;\nclass C {}\n');
    expect(uses).toContainEqual(
      expect.objectContaining({
        candidates: [expect.objectContaining({ kind: 'path', specifier: 'com.acme.payments.PaymentService' })],
        kind: 'import',
      }),
    );
  });

  it('drops the trailing member of a static import (emits the type FQN)', async () => {
    const { uses } = await run('import static com.acme.util.Helpers.format;\nclass C {}\n');
    const s = specs(uses);
    expect(s).toContain('com.acme.util.Helpers');
    expect(s).not.toContain('com.acme.util.Helpers.format');
  });

  it('emits the PACKAGE FQN for a wildcard import', async () => {
    const { uses } = await run('import com.acme.audit.*;\nclass C {}\n');
    const s = specs(uses);
    expect(s).toContain('com.acme.audit');
    // The package is the dependency — no `*`, no individual class.
    expect(s.every((x) => !x.includes('*'))).toBe(true);
  });

  it('keeps the class FQN intact for a static-on-demand import', async () => {
    // `import static com.acme.util.Constants.*;` — the FQN IS the class.
    const { uses } = await run('import static com.acme.util.Constants.*;\nclass C {}\n');
    const s = specs(uses);
    expect(s).toContain('com.acme.util.Constants');
    expect(s.every((x) => !x.includes('*'))).toBe(true);
  });

  it('emits a stdlib import FQN unchanged (silencing is the resolver job)', async () => {
    const { uses } = await run('import java.util.List;\nclass C {}\n');
    expect(specs(uses)).toContain('java.util.List');
  });

  it('emits the FQN of a nested-type import verbatim', async () => {
    const { uses } = await run('import com.foo.Outer.Inner;\nclass C {}\n');
    expect(specs(uses)).toContain('com.foo.Outer.Inner');
  });

  it('emits the bare segment of a single-segment import (identifier child, not scoped_identifier)', async () => {
    // `import Foo;` parses with an `identifier` child (no dots) — exercises the
    // `identifier` arm of importFqn. The FQN is the bare segment itself.
    const { uses } = await run('import Foo;\nclass C {}\n');
    expect(specs(uses)).toContain('Foo');
  });

  it('emits NOTHING for a static import of a bare single segment (no type segment to keep)', async () => {
    // `import static Foo;` is a static import whose FQN is a single segment — dropping
    // the trailing member leaves nothing (dropLastSegment → undefined), so the emit
    // guard discards it. No dependency edge.
    const { uses } = await run('import static Foo;\nclass C {}\n');
    expect(uses).toHaveLength(0);
  });

  it('emits NOTHING for an import with an empty FQN (empty-specifier guard)', async () => {
    // `import ;` parses with an empty `identifier` (text ''), which the emit guard
    // discards as an empty specifier. No dependency edge.
    const { uses } = await run('import ;\nclass C {}\n');
    expect(uses).toHaveLength(0);
  });

  it('emits the class FQN for a static-on-demand wildcard (asterisk wins over static)', async () => {
    // `import static com.foo.*;` carries BOTH a `static` token and an `asterisk` child.
    // The wildcard branch is checked first, so the scoped_identifier `com.foo` is
    // emitted as-is — the trailing member is NOT dropped.
    const { uses } = await run('import static com.foo.*;\nclass C {}\n');
    const s = specs(uses);
    expect(s).toContain('com.foo');
    expect(s.every((x) => !x.includes('*'))).toBe(true);
  });

  it('deduplicates two identical imports that begin on the same line', async () => {
    // Two `import a.B;` declarations on ONE line collide on the `<specifier> <line>`
    // dedup key — only one edge is emitted (the seen-set true-arm).
    const { uses } = await run('import a.B; import a.B;\nclass C {}\n');
    const s = specs(uses);
    expect(s).toEqual(['a.B']);
  });

  it('collects every import in a multi-import file', async () => {
    const { uses } = await run(
      [
        'package com.acme.app;',
        'import com.acme.a.Alpha;',
        'import com.acme.b.Beta;',
        'class C {}',
        '',
      ].join('\n'),
    );
    const s = specs(uses);
    expect(s).toContain('com.acme.a.Alpha');
    expect(s).toContain('com.acme.b.Beta');
  });

  it('tags the wildcard package hint with isPackage: true', async () => {
    const { uses } = await run('import com.acme.audit.*;\nclass C {}\n');
    const h = hintFor(uses, 'com.acme.audit');
    expect(h).toBeDefined();
    expect(h?.isPackage).toBe(true);
  });

  it('does NOT tag a single-type import as a package', async () => {
    const { uses } = await run('import com.acme.payments.PaymentService;\nclass C {}\n');
    const h = hintFor(uses, 'com.acme.payments.PaymentService');
    expect(h).toBeDefined();
    expect(h?.isPackage).toBeFalsy();
  });

  it('does NOT tag a static-on-demand import as a package (the FQN is the class)', async () => {
    // `import static com.acme.util.Constants.*;` — the scoped_identifier IS the
    // class; the asterisk is static-on-demand, not a package wildcard.
    const { uses } = await run('import static com.acme.util.Constants.*;\nclass C {}\n');
    const h = hintFor(uses, 'com.acme.util.Constants');
    expect(h).toBeDefined();
    expect(h?.isPackage).toBeFalsy();
  });

  it('emits NOTHING for a module import declaration `import module M;` (JEP 511)', async () => {
    // A module import names a MODULE, not a type/package; its imported set lives in
    // unreadable module-path metadata. The extractor recognizes the `module` soft keyword
    // (or, in the pre-JEP-511 grammar, the malformed leading-`module` scoped_identifier)
    // and emits no hint — and the whitespace-validity backstop drops the malformed
    // `"module …"` pseudo-FQN even if recognition were bypassed.
    const { uses } = await run('package com.app;\nimport module java.base;\nimport module com.acme.lib;\nclass C {}\n');
    expect(uses).toHaveLength(0);
  });

  it('emits the service + provider TYPE FQNs of module-info uses / provides directives', async () => {
    // `module-info.java`: `uses TypeName` and `provides TypeName with TypeName…` carry
    // genuine shadow-free service-type FQNs → TYPE hints. `requires`/`exports`/`opens`
    // carry module/package names and MUST be excluded.
    const { uses } = await run(
      [
        'module com.example.foo {',
        '  requires com.acme.req.ReqType;',
        '  exports com.acme.exp.ExpType;',
        '  opens com.acme.opn.OpnType;',
        '  uses com.acme.spi.Intf;',
        '  provides com.acme.spi.Intf with com.acme.impl.Impl, com.acme.impl.Impl2;',
        '}',
        '',
      ].join('\n'),
    );
    const s = specs(uses);
    // uses + provides operands (service + both providers) are emitted as TYPE hints.
    expect(s).toContain('com.acme.spi.Intf');
    expect(s).toContain('com.acme.impl.Impl');
    expect(s).toContain('com.acme.impl.Impl2');
    // requires / exports / opens operands are NEVER emitted (module/package names).
    expect(s).not.toContain('com.acme.req.ReqType');
    expect(s).not.toContain('com.acme.exp.ExpType');
    expect(s).not.toContain('com.acme.opn.OpnType');
    // All emitted hints are TYPE hints (not package wildcards).
    expect(uses.every((u) => u.candidates[0].kind === 'path' && u.candidates[0].isPackage !== true)).toBe(true);
  });

  it('emits a SYMBOL hint for an inline fully-qualified TYPE reference (extends), but NOT for expression-position dotted calls or same-package bare names', async () => {
    // The inline fully-qualified TYPE reference `extends com.acme.base.Base` is the
    // outermost `scoped_type_identifier` in a TYPE position. A fully-qualified name is
    // shadow-free (JLS §6.5.5.2), so it now emits a `symbol` hint that resolves through
    // the shared SymbolTable like an import. The EXPRESSION-position dotted static call
    // `com.acme.audit.AuditLog.record(...)` parses as a field_access/method_invocation
    // chain — never a `scoped_type_identifier` — so it emits NOTHING (the zero-FP boundary);
    // the bare same-package supertype `Other` is a simple name, also no hint.
    const { uses } = await run(
      [
        'package com.acme.app;',
        'class C extends com.acme.base.Base implements com.acme.flow.Flowable {',
        '  void m() {',
        '    Object o = new com.acme.metrics.Timer();',
        '    com.acme.audit.AuditLog.record("x");',
        '  }',
        '}',
        'class D extends Other {}',
        '',
      ].join('\n'),
    );
    const symbolKeys = uses.flatMap((u) =>
      u.candidates[0].kind === 'symbol' ? [u.candidates[0].symbolKey] : [],
    );
    // Inline fully-qualified TYPE references → symbol hints (the type-position forms).
    expect(symbolKeys).toContain('com.acme.base.Base'); // extends
    expect(symbolKeys).toContain('com.acme.flow.Flowable'); // implements
    expect(symbolKeys).toContain('com.acme.metrics.Timer'); // new type
    // EVERY emitted hint here is a TYPE-position symbol hint, none a path hint.
    expect(uses.every((u) => u.candidates[0].kind === 'symbol')).toBe(true);
    // Expression-position dotted static call → NO hint (field_access/method_invocation chain).
    expect(symbolKeys.some((k) => k.startsWith('com.acme.audit'))).toBe(false);
    // Same-package bare simple-name supertype `Other` → NO hint.
    expect(symbolKeys).not.toContain('Other');
  });
});

describe('java extractor — declarations()', () => {
  it('returns class / interface / enum / record names', async () => {
    const { declarations } = await run(
      [
        'class Foo {}',
        'interface Bar {}',
        'enum Baz { A, B }',
        'record Qux(int a) {}',
        '',
      ].join('\n'),
    );
    const keys = declarations.map((d) => d.symbolKey);
    expect(keys).toContain('Foo');
    expect(keys).toContain('Bar');
    expect(keys).toContain('Baz');
    expect(keys).toContain('Qux');
  });

  it('carries a 1-based line number for each declaration', async () => {
    const { declarations } = await run('\nclass OnLineTwo {}\n');
    const foo = declarations.find((d) => d.symbolKey === 'OnLineTwo');
    expect(foo?.line).toBe(2);
  });
});
