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
