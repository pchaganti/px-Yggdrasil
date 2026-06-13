import { describe, it, expect } from 'vitest';
import { runExtractor } from './_harness.js';
import { javaExtractor } from '../../../../src/relations/extractors/java.js';

const run = (code: string) => runExtractor(javaExtractor, 'java', '.java', code);

const specs = (uses: Awaited<ReturnType<typeof run>>['uses']): string[] =>
  uses.flatMap((u) => (u.targetHint.kind === 'path' ? [u.targetHint.specifier] : []));

describe('java extractor — uses()', () => {
  it('emits the type FQN for a single-type import', async () => {
    const { uses } = await run('import com.acme.payments.PaymentService;\nclass C {}\n');
    expect(uses).toContainEqual(
      expect.objectContaining({
        targetHint: { kind: 'path', specifier: 'com.acme.payments.PaymentService' },
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

  it('does NOT treat extends/implements/new/method calls as edges (v1 = import only)', async () => {
    // No import lines. extends, implements, FQ construction, FQ static call: all
    // usage-site refinement, DEFERRED in v1. Zero detected deps.
    const { uses } = await run(
      [
        'package com.acme.app;',
        'class C extends com.acme.base.Base implements com.acme.flow.Flowable {',
        '  void m() {',
        '    Object o = new com.acme.metrics.Timer();',
        '    com.acme.audit.AuditLog.record("x");',
        '  }',
        '}',
        '',
      ].join('\n'),
    );
    expect(uses).toHaveLength(0);
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
