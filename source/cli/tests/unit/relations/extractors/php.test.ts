import { describe, it, expect } from 'vitest';
import { runExtractor } from './_harness.js';
import { phpExtractor } from '../../../../src/relations/extractors/php.js';

const run = (code: string) => runExtractor(phpExtractor, 'php', '.php', code);

const specs = (uses: Awaited<ReturnType<typeof run>>['uses']): string[] =>
  uses.flatMap((u) => (u.targetHint.kind === 'path' ? [u.targetHint.specifier] : []));

describe('php extractor — uses()', () => {
  it('emits the FQN for a simple use import', async () => {
    const { uses } = await run('<?php\nuse App\\Payment\\Gateway;\nclass C {}\n');
    expect(uses).toContainEqual(
      expect.objectContaining({
        targetHint: { kind: 'path', specifier: 'App\\Payment\\Gateway' },
        kind: 'import',
      }),
    );
  });

  it('expands a grouped use into one FQN per imported class', async () => {
    const { uses } = await run('<?php\nuse App\\Payment\\{Charge, Refund};\nclass C {}\n');
    const s = specs(uses);
    expect(s).toContain('App\\Payment\\Charge');
    expect(s).toContain('App\\Payment\\Refund');
  });

  it('records the real FQN, not the alias, for an aliased import', async () => {
    const { uses } = await run('<?php\nuse App\\Payment\\Gateway as G;\nclass C {}\n');
    const s = specs(uses);
    expect(s).toContain('App\\Payment\\Gateway');
    expect(s).not.toContain('G');
    expect(s).not.toContain('App\\Payment\\G');
  });

  it('records the real FQN, not the alias, for an aliased clause in a grouped use', async () => {
    const { uses } = await run('<?php\nuse App\\Payment\\{Charge, Refund as R};\nclass C {}\n');
    const s = specs(uses);
    expect(s).toContain('App\\Payment\\Charge');
    expect(s).toContain('App\\Payment\\Refund');
    expect(s).not.toContain('App\\Payment\\R');
  });

  it('strips a leading backslash from a fully-qualified use', async () => {
    const { uses } = await run('<?php\nuse \\App\\Payment\\Gateway;\nclass C {}\n');
    const s = specs(uses);
    expect(s).toContain('App\\Payment\\Gateway');
    expect(s.every((x) => !x.startsWith('\\'))).toBe(true);
  });

  it('skips function and const imports (not class dependencies)', async () => {
    const { uses } = await run(
      [
        '<?php',
        'use function App\\Util\\format;',
        'use const App\\Util\\MAX;',
        'class C {}',
        '',
      ].join('\n'),
    );
    expect(uses).toHaveLength(0);
  });

  it('emits a vendor/external import FQN unchanged (silencing is the resolver job)', async () => {
    const { uses } = await run('<?php\nuse Psr\\Log\\LoggerInterface;\nclass C {}\n');
    expect(specs(uses)).toContain('Psr\\Log\\LoggerInterface');
  });

  it('collects every import in a multi-import file', async () => {
    const { uses } = await run(
      [
        '<?php',
        'namespace App\\App;',
        'use App\\A\\Alpha;',
        'use App\\B\\Beta;',
        'class C {}',
        '',
      ].join('\n'),
    );
    const s = specs(uses);
    expect(s).toContain('App\\A\\Alpha');
    expect(s).toContain('App\\B\\Beta');
  });

  it('handles a multi-clause single use (`use A\\X as P, B\\Y as Q;`) — both FQNs, no aliases', async () => {
    const { uses } = await run('<?php\nuse App\\A\\Alpha as X, App\\B\\Beta as Y;\nclass C {}\n');
    const s = specs(uses);
    expect(s).toContain('App\\A\\Alpha');
    expect(s).toContain('App\\B\\Beta');
    expect(s).not.toContain('App\\A\\X');
    expect(s).not.toContain('App\\B\\Y');
  });

  it('resolves a nested qualified_name segment inside a grouped use (`{Inner\\Deep, Plain}`)', async () => {
    const { uses } = await run('<?php\nuse App\\Sub\\{Inner\\Deep, Plain};\nclass C {}\n');
    const s = specs(uses);
    expect(s).toContain('App\\Sub\\Inner\\Deep');
    expect(s).toContain('App\\Sub\\Plain');
  });

  it('skips a grouped function import (`use function Base\\{a, b};`)', async () => {
    // The `function` token sits as a DIRECT child of the declaration here, not on
    // the clause — the whole grouped declaration imports functions, not classes.
    const { uses } = await run('<?php\nuse function App\\Util\\{format, trim};\nclass C {}\n');
    expect(uses).toHaveLength(0);
  });

  it('drops only the function clause in a mixed grouped use, keeping the class (`{function format, Gateway}`)', async () => {
    // Per-clause `function` token: the group mixes a function import and a class
    // import. Only the class is a dependency edge; the function must be silenced
    // without taking the class down with it.
    const { uses } = await run('<?php\nuse App\\Pkg\\{function format, Gateway};\nclass C {}\n');
    const s = specs(uses);
    expect(s).toContain('App\\Pkg\\Gateway');
    expect(s).not.toContain('App\\Pkg\\format');
    expect(s).toHaveLength(1);
  });

  it('drops the function clause regardless of its position in the group (`{Gateway, function format}`)', async () => {
    // Class-first ordering — guard must be evaluated per clause, not by position.
    const { uses } = await run('<?php\nuse App\\Pkg\\{Gateway, function format};\nclass C {}\n');
    const s = specs(uses);
    expect(s).toContain('App\\Pkg\\Gateway');
    expect(s).not.toContain('App\\Pkg\\format');
    expect(s).toHaveLength(1);
  });

  it('drops only the const clause in a mixed grouped use, keeping the class (`{const MAX, Gateway}`)', async () => {
    // Per-clause `const` token — same rule as `function`.
    const { uses } = await run('<?php\nuse App\\Pkg\\{const MAX, Gateway};\nclass C {}\n');
    const s = specs(uses);
    expect(s).toContain('App\\Pkg\\Gateway');
    expect(s).not.toContain('App\\Pkg\\MAX');
    expect(s).toHaveLength(1);
  });

  it('keeps both classes in a per-clause-typed group with no function/const clause (positive guard)', async () => {
    // POSITIVE / anti-over-silencing: a perfectly ordinary grouped class import
    // must still emit BOTH class hints. The per-clause guard must not silence
    // clauses that carry no function/const token.
    const { uses } = await run('<?php\nuse App\\Payment\\{Charge, Refund};\nclass C {}\n');
    const s = specs(uses);
    expect(s).toContain('App\\Payment\\Charge');
    expect(s).toContain('App\\Payment\\Refund');
    expect(s).toHaveLength(2);
  });

  it('deduplicates a class repeated in one grouped use on the same line (`{Foo, Foo}`)', async () => {
    const { uses } = await run('<?php\nuse App\\Pkg\\{Foo, Foo};\nclass C {}\n');
    // Same FQN, same line → one hint, not two.
    expect(specs(uses).filter((x) => x === 'App\\Pkg\\Foo')).toHaveLength(1);
  });

  it('emits nothing for a use whose only name is a bare backslash (`use \\;`)', async () => {
    // qualified_name text is "\\"; stripping the single leading backslash leaves the
    // empty string, which the emit guard rejects.
    const { uses } = await run('<?php\nuse \\;\nclass C {}\n');
    expect(uses).toHaveLength(0);
  });

  it('skips a trailing-comma error clause in a grouped use, keeping the valid one', async () => {
    // `use App\\{Foo, };` parses the dangling comma as an ERROR node that appears as a
    // named child of the group alongside the real clause; the non-clause child is skipped.
    const { uses } = await run('<?php\nuse App\\Grp\\{Foo, };\nclass C {}\n');
    const s = specs(uses);
    expect(s).toContain('App\\Grp\\Foo');
    expect(s).toHaveLength(1);
  });

  it('does NOT treat extends/implements/trait-use/new/static calls as edges (v1 = use-import only)', async () => {
    // No top-level `use` imports. extends, implements, in-body trait use, `new`, a
    // fully-qualified static call: all usage-site refinement, DEFERRED in v1.
    const { uses } = await run(
      [
        '<?php',
        'namespace App\\App;',
        'class C extends \\App\\Base\\Base implements \\App\\Flow\\Flowable {',
        '  use \\App\\Mixin\\Timestamps;',
        '  function m() {',
        '    $o = new \\App\\Metrics\\Timer();',
        '    \\App\\Audit\\AuditLog::record("x");',
        '  }',
        '}',
        '',
      ].join('\n'),
    );
    expect(uses).toHaveLength(0);
  });
});

describe('php extractor — declarations()', () => {
  it('returns class / interface / trait / enum names', async () => {
    const { declarations } = await run(
      [
        '<?php',
        'class Foo {}',
        'interface Bar {}',
        'trait Baz {}',
        'enum Qux {}',
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
    const { declarations } = await run('<?php\n\nclass OnLineThree {}\n');
    const foo = declarations.find((d) => d.symbolKey === 'OnLineThree');
    expect(foo?.line).toBe(3);
  });
});
