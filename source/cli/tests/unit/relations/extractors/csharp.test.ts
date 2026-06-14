import { describe, it, expect } from 'vitest';
import { runExtractor } from './_harness.js';
import { csharpExtractor } from '../../../../src/relations/extractors/csharp.js';
import { SymbolTable } from '../../../../src/relations/symbol-table.js';
import { makeResolver } from '../../../../src/relations/resolver.js';
import type { ParsedFile } from '../../../../src/relations/extractors/types.js';
import { ensureLoaderRegistered } from '../../../../src/ast/loader-hook.js';
import { parseFile } from '../../../../src/ast/parser.js';

const run = (code: string) => runExtractor(csharpExtractor, 'csharp', '.cs', code);

const symbolKeys = (uses: Awaited<ReturnType<typeof run>>['uses']): string[] =>
  uses.flatMap((u) => (u.targetHint.kind === 'symbol' ? [u.targetHint.symbolKey] : []));

/** Parse a C# source string into a ParsedFile under a chosen repo-rel path. */
async function parse(repoRel: string, code: string): Promise<ParsedFile> {
  ensureLoaderRegistered();
  const tree = await parseFile(repoRel, code);
  return { path: repoRel, content: code, tree, language: 'csharp' };
}

describe('csharp extractor — declarations() produce <Namespace>.<Type> FQN keys', () => {
  it('qualifies every type kind with a FILE-SCOPED namespace (namespace Foo.Bar;)', async () => {
    const { declarations } = await run(
      [
        'namespace Foo.Bar;',
        'public class C { }',
        'public interface IThing { }',
        'public struct S { }',
        'public record Money(decimal A);',
        'public enum E { X }',
        '',
      ].join('\n'),
    );
    const keys = declarations.map((d) => d.symbolKey);
    expect(keys).toContain('Foo.Bar.C');
    expect(keys).toContain('Foo.Bar.IThing');
    expect(keys).toContain('Foo.Bar.S');
    expect(keys).toContain('Foo.Bar.Money');
    expect(keys).toContain('Foo.Bar.E');
  });

  it('qualifies with a BLOCK namespace and concatenates NESTED namespaces', async () => {
    const { declarations } = await run(
      ['namespace Outer {', '  namespace Inner {', '    class C { }', '  }', '}', ''].join('\n'),
    );
    const keys = declarations.map((d) => d.symbolKey);
    expect(keys).toContain('Outer.Inner.C');
  });

  it('uses the BARE type name when the type is at FILE SCOPE (no namespace)', async () => {
    const { declarations } = await run('class Loose { }\n');
    const keys = declarations.map((d) => d.symbolKey);
    expect(keys).toContain('Loose');
    expect(keys.every((k) => !k.startsWith('.'))).toBe(true);
  });

  it('carries a 1-based line number for each declaration', async () => {
    const { declarations } = await run('namespace N;\n\npublic class OnLineThree { }\n');
    const found = declarations.find((d) => d.symbolKey === 'N.OnLineThree');
    expect(found?.line).toBe(3);
  });
});

describe('csharp extractor — uses() emits SYMBOL hints (never path hints)', () => {
  it('emits a FULLY-QUALIFIED `new Foo.Bar.Baz()` as the FQN candidate', async () => {
    const { uses } = await run(
      ['class C { void M() { var o = new Foo.Bar.Baz(); } }', ''].join('\n'),
    );
    expect(symbolKeys(uses)).toContain('Foo.Bar.Baz');
    expect(uses.every((u) => u.targetHint.kind === 'symbol')).toBe(true);
  });

  it('emits a FULLY-QUALIFIED base type (`: Foo.Bar.Base`) as the FQN candidate', async () => {
    const { uses } = await run(['namespace App;', 'class C : Foo.Bar.Base { }', ''].join('\n'));
    expect(symbolKeys(uses)).toContain('Foo.Bar.Base');
  });

  it('emits a FULLY-QUALIFIED field type as the FQN candidate', async () => {
    const { uses } = await run(['class C { Foo.Bar.Dep _d; }', ''].join('\n'));
    expect(symbolKeys(uses)).toContain('Foo.Bar.Dep');
  });

  it('qualifies a BARE base type via the using scope (`using Foo.Bar; ... : Baz`)', async () => {
    const { uses } = await run(['using Foo.Bar;', 'class C : Baz { }', ''].join('\n'));
    // Candidate FQN = <using prefix>.<bare name>.
    expect(symbolKeys(uses)).toContain('Foo.Bar.Baz');
  });

  it('qualifies a BARE `new Baz()` against EVERY using prefix (multiple candidates are safe)', async () => {
    const { uses } = await run(
      ['using Foo.Bar;', 'using Other.Ns;', 'class C { void M() { var x = new Baz(); } }', ''].join('\n'),
    );
    const keys = symbolKeys(uses);
    // Both candidates emitted — resolveUnique keeps only the one that actually resolves.
    expect(keys).toContain('Foo.Bar.Baz');
    expect(keys).toContain('Other.Ns.Baz');
  });

  it('resolves a BARE name through an ALIAS (`using Gw = Foo.Bar.IGateway;`)', async () => {
    const { uses } = await run(
      ['using Gw = Foo.Bar.IGateway;', 'class C { void M() { var x = new Gw(); } }', ''].join('\n'),
    );
    const keys = symbolKeys(uses);
    // The aliased FQN is the dependency; the local alias name `Gw` is never a target.
    expect(keys).toContain('Foo.Bar.IGateway');
    expect(keys).not.toContain('Gw');
  });

  it('SKIPS `using static X;` — it imports a TYPE\'s members, not a namespace prefix', async () => {
    const { uses } = await run(
      ['using static Foo.Bar.Calc;', 'class C : Baz { }', ''].join('\n'),
    );
    const keys = symbolKeys(uses);
    // No plain namespace prefix recorded → the bare base `Baz` yields NO candidate.
    expect(keys).not.toContain('Foo.Bar.Baz');
    expect(keys.some((k) => k.endsWith('.Baz'))).toBe(false);
  });

  it('does NOT honor `global using` from another file: a bare name with no in-file using is SILENT', async () => {
    // No `using` directive in THIS file → a bare base type cannot be qualified.
    const { uses } = await run(['class C : SomeGlobalType { }', ''].join('\n'));
    expect(symbolKeys(uses)).toHaveLength(0);
  });

  it('every hint is a SYMBOL hint (csharp resolves through the SymbolTable, never a path)', async () => {
    const { uses } = await run(
      ['using Foo.Bar;', 'class C : Baz { Foo.Bar.Dep _d; }', ''].join('\n'),
    );
    expect(uses.length).toBeGreaterThan(0);
    expect(uses.every((u) => u.targetHint.kind === 'symbol')).toBe(true);
  });

  it('honors `global using Foo.Bar;` as a plain namespace prefix for a bare base type', async () => {
    // `global using` declared in THIS file is treated as a namespace import for this
    // file's scope, so a bare base type qualifies via the prefix.
    const { uses } = await run(['global using Foo.Bar;', 'class C : Baz { }', ''].join('\n'));
    expect(symbolKeys(uses)).toContain('Foo.Bar.Baz');
  });

  it('honors `global using Foo.Bar;` as a prefix for a bare `new Baz()` too', async () => {
    const { uses } = await run(
      ['global using Foo.Bar;', 'class C { void M() { var x = new Baz(); } }', ''].join('\n'),
    );
    expect(symbolKeys(uses)).toContain('Foo.Bar.Baz');
  });

  it('resolves a bare name through a `global using Alias = Foo.Bar.IGateway;` alias', async () => {
    const { uses } = await run(
      ['global using Gw = Foo.Bar.IGateway;', 'class C { void M() { var x = new Gw(); } }', ''].join('\n'),
    );
    const keys = symbolKeys(uses);
    expect(keys).toContain('Foo.Bar.IGateway');
    expect(keys).not.toContain('Gw');
  });

  it('emits a QUALIFIED base type (`: Foo.Bar.Base`) even with NO using directive', async () => {
    // A qualified_name in a base_list is emitted as-is (not via the bare prefix path).
    const { uses } = await run(['class C : Foo.Bar.Base { }', ''].join('\n'));
    expect(symbolKeys(uses)).toContain('Foo.Bar.Base');
  });

  it('SKIPS a GENERIC base type (`: List<int>`) — not a bare identifier, no candidate', async () => {
    // A `generic_name` is neither a bare identifier nor a qualified_name, so bareTypeName
    // returns undefined and emitBare is skipped.
    const { uses } = await run(['using Foo.Bar;', 'class C : List<int> { }', ''].join('\n'));
    expect(symbolKeys(uses)).toHaveLength(0);
  });

  it('handles a base_list with MULTIPLE entries (qualified bare base + bare interface)', async () => {
    // Two base entries on one line: a bare base and a bare interface, each qualified by
    // the using prefix; a third generic entry is skipped.
    const { uses } = await run(
      ['using N;', 'class C : MyBase, IFoo<int> { }', ''].join('\n'),
    );
    const keys = symbolKeys(uses);
    expect(keys).toContain('N.MyBase'); // bare base qualified
    expect(keys.every((k) => !k.includes('IFoo'))).toBe(true); // generic skipped
  });

  it('does NOT emit the namespace HEADER of a block `namespace Foo.Bar { }` as a use', async () => {
    // The qualified_name `Foo.Bar` is the namespace declaration name, not a dependency.
    const { uses, declarations } = await run(['namespace Foo.Bar { class C { } }', ''].join('\n'));
    expect(symbolKeys(uses)).not.toContain('Foo.Bar');
    expect(symbolKeys(uses)).toHaveLength(0);
    // The type is still declared with the namespace prefix.
    expect(declarations.map((d) => d.symbolKey)).toContain('Foo.Bar.C');
  });

  it('does NOT emit NESTED block namespace headers as uses (namespace A.B { namespace C.D { } })', async () => {
    const { uses, declarations } = await run(
      ['namespace A.B { namespace C.D { class X { } } }', ''].join('\n'),
    );
    expect(symbolKeys(uses)).toHaveLength(0);
    expect(declarations.map((d) => d.symbolKey)).toContain('A.B.C.D.X');
  });

  it('DEDUPES the SAME qualified base type listed twice on one line (`: Foo.Bar, Foo.Bar`)', async () => {
    // The same candidate FQN on the same line is emitted once — the second hit is
    // suppressed by the symbol+line dedup key.
    const { uses } = await run(['class C : Foo.Bar, Foo.Bar { }', ''].join('\n'));
    expect(symbolKeys(uses).filter((k) => k === 'Foo.Bar')).toHaveLength(1);
  });

  it('DEDUPES a bare base type qualified by a DUPLICATE using prefix (one candidate, not two)', async () => {
    // Two identical `using A;` directives yield the same prefix; the bare base `Baz`
    // would produce `A.Baz` twice, but the dedup collapses it to one.
    const { uses } = await run(['using A;', 'using A;', 'class C : Baz { }', ''].join('\n'));
    expect(symbolKeys(uses).filter((k) => k === 'A.Baz')).toHaveLength(1);
  });
});

describe('csharp SYMBOL-TABLE resolution — the half this language validates', () => {
  it("builds a SymbolTable from two files' declarations() and resolves a third file's qualified use to the right file", async () => {
    const fileA = await parse(
      'src/a/Gateway.cs',
      'namespace MyApp.Payments;\npublic class Gateway { }\n',
    );
    const fileB = await parse('src/b/Audit.cs', 'namespace MyApp.Audit;\npublic class AuditLog { }\n');
    const consumer = await parse(
      'src/c/Order.cs',
      'namespace MyApp.Orders;\nclass Order { void M() { var g = new MyApp.Payments.Gateway(); } }\n',
    );

    // Build the shared SymbolTable exactly as pass.ts step 4 does.
    const st = new SymbolTable();
    for (const f of [fileA, fileB]) {
      for (const d of csharpExtractor.declarations(f)) st.declare(d.symbolKey, f.path);
    }

    // The consumer's qualified `new` resolves to fileA via resolveUnique.
    const uses = csharpExtractor.uses(consumer);
    const hint = uses.find(
      (u) => u.targetHint.kind === 'symbol' && u.targetHint.symbolKey === 'MyApp.Payments.Gateway',
    );
    expect(hint?.targetHint).toEqual({ kind: 'symbol', symbolKey: 'MyApp.Payments.Gateway' });
    expect(st.resolveUnique('MyApp.Payments.Gateway')).toBe('src/a/Gateway.cs');

    // And the full resolver wires symbol → owner node (mirrors resolver.ts).
    const ownerIndex = {
      ownerOf: (f: string) =>
        f === 'src/a/Gateway.cs' ? 'a' : f === 'src/b/Audit.cs' ? 'b' : undefined,
    };
    const resolver = makeResolver({
      ownerIndex: ownerIndex as never,
      symbolTable: st,
      resolvePathToFile: () => undefined,
    });
    expect(resolver.resolve(hint!.targetHint, consumer.path, 'csharp')).toEqual({
      ownerNode: 'a',
      resolvedFile: 'src/a/Gateway.cs',
    });
  });

  it('BARE name resolves through the using scope to the right file', async () => {
    const fileA = await parse('src/a/Gateway.cs', 'namespace MyApp.Payments;\npublic class Gateway { }\n');
    const consumer = await parse(
      'src/c/Order.cs',
      'using MyApp.Payments;\nnamespace MyApp.Orders;\nclass Order { void M() { var g = new Gateway(); } }\n',
    );

    const st = new SymbolTable();
    for (const d of csharpExtractor.declarations(fileA)) st.declare(d.symbolKey, fileA.path);

    const hint = csharpExtractor
      .uses(consumer)
      .find((u) => u.targetHint.kind === 'symbol' && u.targetHint.symbolKey === 'MyApp.Payments.Gateway');
    expect(hint).toBeDefined();
    expect(st.resolveUnique('MyApp.Payments.Gateway')).toBe('src/a/Gateway.cs');
  });

  it('AMBIGUITY: two files declaring the SAME FQN → a use of it resolves to undefined (silence, no flag)', async () => {
    const fileX = await parse('src/x/Thing.cs', 'namespace MyApp.Dup;\npublic class Thing { }\n');
    const fileY = await parse('src/y/Thing.cs', 'namespace MyApp.Dup;\npublic class Thing { }\n');
    const consumer = await parse(
      'src/z/Use.cs',
      'namespace MyApp.Z;\nclass Use { void M() { var t = new MyApp.Dup.Thing(); } }\n',
    );

    const st = new SymbolTable();
    for (const f of [fileX, fileY]) {
      for (const d of csharpExtractor.declarations(f)) st.declare(d.symbolKey, f.path);
    }

    // resolveUnique returns undefined for the ambiguous FQN.
    expect(st.resolveUnique('MyApp.Dup.Thing')).toBeUndefined();

    // Through the resolver the use also resolves to undefined — silence, never a flag.
    const ownerIndex = { ownerOf: () => 'someNode' };
    const resolver = makeResolver({
      ownerIndex: ownerIndex as never,
      symbolTable: st,
      resolvePathToFile: () => undefined,
    });
    const hint = csharpExtractor
      .uses(consumer)
      .find((u) => u.targetHint.kind === 'symbol' && u.targetHint.symbolKey === 'MyApp.Dup.Thing')!;
    expect(resolver.resolve(hint.targetHint, consumer.path, 'csharp')).toBeUndefined();
  });
});

describe('csharp anti-FALSE-POSITIVE — the silence list (D8 gate)', () => {
  // Each case must resolve to nothing flaggable. We assert at the resolution layer:
  // every emitted hint resolves to undefined (no in-graph owner) given a SymbolTable
  // that knows only the consumer's own/family types.
  const resolveAll = (
    uses: Awaited<ReturnType<typeof run>>['uses'],
    st: SymbolTable,
    ownerOf: (f: string) => string | undefined,
  ): Array<string | undefined> => {
    const resolver = makeResolver({
      ownerIndex: { ownerOf } as never,
      symbolTable: st,
      resolvePathToFile: () => undefined,
    });
    return uses.map((u) => {
      const r = resolver.resolve(u.targetHint, 'src/c/Use.cs', 'csharp');
      return r?.ownerNode;
    });
  };

  it('DI-container registration emits NO cross-node flag (services.AddScoped<IFoo, Foo>())', async () => {
    const { uses } = await run(
      [
        'using Microsoft.Extensions.DependencyInjection;',
        'class Startup {',
        '  void Configure(IServiceCollection services) {',
        '    services.AddScoped<IFoo, Foo>();',
        '  }',
        '}',
        '',
      ].join('\n'),
    );
    // IFoo / Foo are bare type args → candidates Microsoft.Extensions.DependencyInjection.IFoo etc.
    // None is declared in a symbol table that maps to a node → all undefined.
    const owners = resolveAll(uses, new SymbolTable(), () => undefined);
    expect(owners.every((o) => o === undefined)).toBe(true);
  });

  it('REFLECTION emits NO flag (Type.GetType / Activator.CreateInstance with string names)', async () => {
    const { uses } = await run(
      [
        'using System;',
        'class R {',
        '  void M() {',
        '    var t = Type.GetType("MyApp.Payments.Gateway");',
        '    var o = Activator.CreateInstance(t);',
        '  }',
        '}',
        '',
      ].join('\n'),
    );
    // The FQN is a STRING literal — never a qualified_name node. No symbol hint can
    // resolve to MyApp.Payments.Gateway even if that type is in the table.
    const st = new SymbolTable();
    st.declare('MyApp.Payments.Gateway', 'src/pay/Gateway.cs');
    const owners = resolveAll(uses, st, (f) => (f === 'src/pay/Gateway.cs' ? 'pay' : undefined));
    expect(owners.every((o) => o === undefined)).toBe(true);
  });

  it('EXTENSION METHOD call emits NO flag (order.Validate() — receiver type unknown)', async () => {
    const { uses } = await run(
      ['class C { void M(object order) { order.Validate(); } }', ''].join('\n'),
    );
    // No qualified_name, no base_list, no `new` of a named type → no hints at all.
    expect(symbolKeys(uses)).toHaveLength(0);
  });

  it('SOURCE-GENERATED / partial type emits NO flag (partial class, no base/new)', async () => {
    const { uses } = await run(['namespace App;', 'partial class Gen { }', ''].join('\n'));
    expect(symbolKeys(uses)).toHaveLength(0);
  });

  it('`using static X;` emits NO namespace-prefix candidate', async () => {
    const { uses } = await run(
      ['using static MyApp.Math.Calc;', 'class C { void M() { var r = Compute(); } }', ''].join('\n'),
    );
    // `Compute()` is a bare invocation, not a `new`/base/qualified_name → no hints.
    // And `using static` added no prefix, so even a bare base type would not qualify.
    expect(symbolKeys(uses).some((k) => k.startsWith('MyApp.Math'))).toBe(false);
  });

  it('`global using` from ANOTHER file is invisible: a bare type stays SILENT', async () => {
    // No using in this file; the bare base type cannot be qualified to any candidate.
    const { uses } = await run(['class C : RepositoryBase { }', ''].join('\n'));
    expect(symbolKeys(uses)).toHaveLength(0);
  });

  it('EXTERNAL/BCL type resolves to NO node (System.* → external, never a violation)', async () => {
    const { uses } = await run(
      ['class C { System.Text.StringBuilder _sb; void M() { var x = new System.Collections.Generic.List<int>(); } }', ''].join('\n'),
    );
    // Candidates like System.Text.StringBuilder are emitted, but the symbol table /
    // owner index never map them to a node → undefined.
    const owners = resolveAll(uses, new SymbolTable(), () => undefined);
    expect(owners.every((o) => o === undefined)).toBe(true);
  });

  it('dependency onto an UNMAPPED type (declared in table, file owned by NO node) → undefined', async () => {
    const { uses } = await run(
      ['class C { void M() { var x = new Foo.Bar.Baz(); } }', ''].join('\n'),
    );
    const st = new SymbolTable();
    st.declare('Foo.Bar.Baz', 'src/unmapped/Baz.cs');
    // ownerOf returns undefined for the unmapped file → resolver yields undefined (D7).
    const owners = resolveAll(uses, st, () => undefined);
    expect(owners.every((o) => o === undefined)).toBe(true);
  });

  it('INTRA-NODE / family reference: resolves to a file, but to the consumer\'s OWN node (no flag at verify layer)', async () => {
    // This case shows the hint DOES resolve — the self/ancestor filtering is the
    // verifier's job (computeBasis), proven by the e2e round-trip. Here we only assert
    // the resolution points to the consumer's own node, which the verifier never flags.
    const { uses } = await run(
      ['namespace App;', 'class C { void M() { var x = new App.Sibling(); } }', ''].join('\n'),
    );
    const st = new SymbolTable();
    st.declare('App.Sibling', 'src/c/Sibling.cs'); // same node as the consumer
    const owners = resolveAll(uses, st, (f) => (f === 'src/c/Sibling.cs' ? 'c' : undefined));
    // It resolves to node 'c' — the consumer's own node — which is never an undeclared
    // cross-node dependency (the verifier's self/family filter handles it).
    expect(owners).toContain('c');
  });
});

describe('csharp extractor — registry wiring', () => {
  it('declares the csharp language', () => {
    expect(csharpExtractor.languages.has('csharp')).toBe(true);
  });
});
