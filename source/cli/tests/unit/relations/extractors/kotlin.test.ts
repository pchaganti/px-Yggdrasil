import { describe, it, expect } from 'vitest';
import { runExtractor } from './_harness.js';
import { kotlinExtractor } from '../../../../src/relations/extractors/kotlin.js';
import { SymbolTable } from '../../../../src/relations/symbol-table.js';
import { makeResolver } from '../../../../src/relations/resolver.js';
import type { ParsedFile } from '../../../../src/relations/extractors/types.js';
import { ensureLoaderRegistered } from '../../../../src/ast/loader-hook.js';
import { parseFile } from '../../../../src/ast/parser.js';

const run = (code: string) => runExtractor(kotlinExtractor, 'kotlin', '.kt', code);

const symbolKeys = (uses: Awaited<ReturnType<typeof run>>['uses']): string[] =>
  uses.flatMap((u) => (u.targetHint.kind === 'symbol' ? [u.targetHint.symbolKey] : []));

/** Parse a Kotlin source string into a ParsedFile under a chosen repo-rel path. */
async function parse(repoRel: string, code: string): Promise<ParsedFile> {
  ensureLoaderRegistered();
  const tree = await parseFile(repoRel, code);
  return { path: repoRel, content: code, tree, language: 'kotlin' };
}

describe('kotlin extractor — uses() emits SYMBOL hints (not path hints)', () => {
  it('emits the imported FQN as a symbol hint for a single-type import', async () => {
    const { uses } = await run('package com.acme.app\nimport com.acme.payments.PaymentService\nclass C\n');
    expect(uses).toContainEqual(
      expect.objectContaining({
        targetHint: { kind: 'symbol', symbolKey: 'com.acme.payments.PaymentService' },
        kind: 'import',
      }),
    );
    // It must NOT be a path hint — Kotlin resolves through the SymbolTable.
    expect(uses.every((u) => u.targetHint.kind === 'symbol')).toBe(true);
  });

  it('IGNORES the alias of `import ... as B` — the hint is the real FQN', async () => {
    const { uses } = await run('import com.acme.util.Helpers as H\nclass C\n');
    const keys = symbolKeys(uses);
    expect(keys).toContain('com.acme.util.Helpers');
    // The alias `H` is a local binding only — never the dependency target.
    expect(keys).not.toContain('H');
    expect(keys.every((k) => !k.includes(' as '))).toBe(true);
  });

  it('emits the PACKAGE FQN for a wildcard import (documented v1: star → package, * dropped)', async () => {
    const { uses } = await run('import com.acme.audit.*\nclass C\n');
    const keys = symbolKeys(uses);
    // The `*` is a separate token; the qualified_identifier is already the package.
    expect(keys).toContain('com.acme.audit');
    expect(keys.every((k) => !k.includes('*'))).toBe(true);
  });

  it('emits a stdlib/external import FQN unchanged (silencing is the SymbolTable job)', async () => {
    const { uses } = await run('import kotlin.collections.List\nimport java.util.ArrayList\nclass C\n');
    const keys = symbolKeys(uses);
    expect(keys).toContain('kotlin.collections.List');
    expect(keys).toContain('java.util.ArrayList');
  });

  it('collects every import in a multi-import file', async () => {
    const { uses } = await run(
      ['package com.acme.app', 'import com.acme.a.Alpha', 'import com.acme.b.Beta', 'class C', ''].join('\n'),
    );
    const keys = symbolKeys(uses);
    expect(keys).toContain('com.acme.a.Alpha');
    expect(keys).toContain('com.acme.b.Beta');
  });

  it('does NOT treat supertypes / by-delegation / qualified calls / type refs as edges (v1 = import only)', async () => {
    const { uses } = await run(
      [
        'package com.acme.app',
        'class C : com.acme.base.Base(), com.acme.flow.Flowable by delegate {',
        '  fun m() {',
        '    val t = com.acme.metrics.Timer()',
        '    com.acme.audit.AuditLog.record("x")',
        '    val ref = com.acme.util.Helpers::format',
        '  }',
        '}',
        '',
      ].join('\n'),
    );
    expect(uses).toHaveLength(0);
  });
});

describe('kotlin extractor — declarations() produce <package>.<Name> FQN keys', () => {
  it('prefixes class / interface / object / function / property / typealias with the package', async () => {
    const { declarations } = await run(
      [
        'package com.acme.app',
        'class Foo',
        'interface Bar',
        'object Baz',
        'fun qux() {}',
        'val quux = 1',
        'typealias Money = Long',
        '',
      ].join('\n'),
    );
    const keys = declarations.map((d) => d.symbolKey);
    expect(keys).toContain('com.acme.app.Foo');
    expect(keys).toContain('com.acme.app.Bar'); // interface parses as class_declaration
    expect(keys).toContain('com.acme.app.Baz');
    expect(keys).toContain('com.acme.app.qux');
    expect(keys).toContain('com.acme.app.quux');
    expect(keys).toContain('com.acme.app.Money');
  });

  it('uses the BARE name when the file has no package_header (root package / .kts)', async () => {
    const { declarations } = await run('class Foo\nfun bar() {}\n');
    const keys = declarations.map((d) => d.symbolKey);
    expect(keys).toContain('Foo');
    expect(keys).toContain('bar');
    expect(keys.every((k) => !k.startsWith('.'))).toBe(true);
  });

  it('carries a 1-based line number for each declaration', async () => {
    const { declarations } = await run('package p\n\nclass OnLineThree\n');
    const foo = declarations.find((d) => d.symbolKey === 'p.OnLineThree');
    expect(foo?.line).toBe(3);
  });
});

describe('kotlin SYMBOL-TABLE resolution — the half this language validates', () => {
  it("builds a SymbolTable from two files' declarations() and resolves a third file's import hint to the right file", async () => {
    // Two declaring files in different packages, plus a consumer that imports one of them.
    const fileA = await parse('src/a/PaymentService.kt', 'package com.acme.payments\nclass PaymentService\n');
    const fileB = await parse('src/b/AuditLog.kt', 'package com.acme.audit\nobject AuditLog\n');
    const consumer = await parse('src/c/Order.kt', 'package com.acme.orders\nimport com.acme.payments.PaymentService\nclass Order\n');

    // Build the shared SymbolTable exactly as pass.ts step 4 does.
    const st = new SymbolTable();
    for (const f of [fileA, fileB]) {
      for (const d of kotlinExtractor.declarations(f)) st.declare(d.symbolKey, f.path);
    }

    // The consumer's import hint must resolve to fileA via resolveUnique.
    const uses = kotlinExtractor.uses(consumer);
    const importHint = uses.find((u) => u.targetHint.kind === 'symbol');
    expect(importHint?.targetHint).toEqual({ kind: 'symbol', symbolKey: 'com.acme.payments.PaymentService' });
    expect(st.resolveUnique('com.acme.payments.PaymentService')).toBe('src/a/PaymentService.kt');

    // And the full resolver wires symbol → owner node (mirrors resolver.ts).
    const ownerIndex = { ownerOf: (f: string) => (f === 'src/a/PaymentService.kt' ? 'a' : f === 'src/b/AuditLog.kt' ? 'b' : undefined) };
    const resolver = makeResolver({ ownerIndex: ownerIndex as never, symbolTable: st, resolvePathToFile: () => undefined });
    expect(resolver.resolve(importHint!.targetHint, consumer.path, 'kotlin')).toEqual({
      ownerNode: 'a',
      resolvedFile: 'src/a/PaymentService.kt',
    });
  });

  it('AMBIGUITY: two files declaring the SAME FQN → a use of it resolves to undefined (silence, no flag)', async () => {
    // Two files both declare com.acme.dup.Thing — the FQN is ambiguous.
    const fileX = await parse('src/x/Thing.kt', 'package com.acme.dup\nclass Thing\n');
    const fileY = await parse('src/y/Thing.kt', 'package com.acme.dup\nclass Thing\n');
    const consumer = await parse('src/z/Use.kt', 'package com.acme.z\nimport com.acme.dup.Thing\nclass Use\n');

    const st = new SymbolTable();
    for (const f of [fileX, fileY]) {
      for (const d of kotlinExtractor.declarations(f)) st.declare(d.symbolKey, f.path);
    }

    // resolveUnique returns undefined for the ambiguous FQN.
    expect(st.resolveUnique('com.acme.dup.Thing')).toBeUndefined();

    // Through the resolver the use also resolves to undefined — silence, never a flag.
    const ownerIndex = { ownerOf: () => 'someNode' };
    const resolver = makeResolver({ ownerIndex: ownerIndex as never, symbolTable: st, resolvePathToFile: () => undefined });
    const importHint = kotlinExtractor.uses(consumer).find((u) => u.targetHint.kind === 'symbol')!;
    expect(resolver.resolve(importHint.targetHint, consumer.path, 'kotlin')).toBeUndefined();
  });
});

describe('kotlin extractor — registry wiring', () => {
  it('declares the kotlin language', () => {
    expect(kotlinExtractor.languages.has('kotlin')).toBe(true);
  });
});
