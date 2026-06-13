import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { makeResolvePathToFile } from '../../../../src/relations/resolve-path.js';

// The Rust resolver maps a `::`-path → a `.rs` file through the crate module tree.
// The crate root is the nearest ancestor of the importing file containing a
// Cargo.toml; its `src/` is the module-tree root. These tests build a real temp
// crate and clean it up in `afterEach`, driven through the production
// makeResolvePathToFile (disk-backed Cargo.toml + existence).

describe('resolveRustPath via makeResolvePathToFile (disk-backed)', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'rust-resolve-'));
    // A crate named `mycrate` with src/ as the module-tree root.
    writeFileSync(
      path.join(root, 'Cargo.toml'),
      '[package]\nname = "mycrate"\nversion = "0.1.0"\nedition = "2021"\n',
      'utf-8',
    );
    mkdirSync(path.join(root, 'src', 'a'), { recursive: true });
    // crate::a::b → src/a/b.rs
    writeFileSync(path.join(root, 'src', 'a', 'b.rs'), '// b\n', 'utf-8');
    // crate::a (module via file) → src/a.rs
    writeFileSync(path.join(root, 'src', 'a.rs'), 'pub mod b;\n', 'utf-8');
    // crate::orders → src/orders/mod.rs (mod.rs form)
    mkdirSync(path.join(root, 'src', 'orders'), { recursive: true });
    writeFileSync(path.join(root, 'src', 'orders', 'mod.rs'), '// orders\n', 'utf-8');
    // crate root entry
    writeFileSync(path.join(root, 'src', 'lib.rs'), 'pub mod a;\npub mod orders;\n', 'utf-8');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('resolves crate::a::b to src/a/b.rs (item path → file)', () => {
    const resolve = makeResolvePathToFile(root);
    expect(resolve('crate::a::b', 'src/lib.rs', 'rust')).toBe('src/a/b.rs');
  });

  it('resolves crate::a::b::Sym to src/a/b.rs via the longest-match item fallback', () => {
    // Sym is a TYPE inside module a::b — the module file is src/a/b.rs.
    const resolve = makeResolvePathToFile(root);
    expect(resolve('crate::a::b::Sym', 'src/lib.rs', 'rust')).toBe('src/a/b.rs');
  });

  it('resolves crate::a::Type to src/a.rs (last segment is an item in module a)', () => {
    const resolve = makeResolvePathToFile(root);
    expect(resolve('crate::a::Type', 'src/lib.rs', 'rust')).toBe('src/a.rs');
  });

  it('resolves crate::orders to src/orders/mod.rs (mod.rs form)', () => {
    const resolve = makeResolvePathToFile(root);
    expect(resolve('crate::orders::Order', 'src/lib.rs', 'rust')).toBe('src/orders/mod.rs');
  });

  it('treats the crate own name like `crate` (2018+ path clarity)', () => {
    const resolve = makeResolvePathToFile(root);
    expect(resolve('mycrate::a::b', 'src/lib.rs', 'rust')).toBe('src/a/b.rs');
  });

  it('resolves super:: relative to the importing file module', () => {
    // From src/a/b.rs (module crate::a::b), `super::` is module crate::a → src/a.rs.
    const resolve = makeResolvePathToFile(root);
    expect(resolve('super::Type', 'src/a/b.rs', 'rust')).toBe('src/a.rs');
  });

  it('resolves self:: against the importing file own module', () => {
    // From src/a.rs (module crate::a), `self::b` is crate::a::b → src/a/b.rs.
    const resolve = makeResolvePathToFile(root);
    expect(resolve('self::b', 'src/a.rs', 'rust')).toBe('src/a/b.rs');
  });

  it('returns undefined for a stdlib import (external crate root)', () => {
    const resolve = makeResolvePathToFile(root);
    expect(resolve('std::collections::HashMap', 'src/lib.rs', 'rust')).toBeUndefined();
  });

  it('returns undefined for a third-party crate (serde) — not the crate own name', () => {
    const resolve = makeResolvePathToFile(root);
    expect(resolve('serde::Serialize', 'src/lib.rs', 'rust')).toBeUndefined();
  });

  it('returns undefined for a crate path whose module file is absent', () => {
    const resolve = makeResolvePathToFile(root);
    expect(resolve('crate::nope::Thing', 'src/lib.rs', 'rust')).toBeUndefined();
  });

  it('returns undefined when there is no Cargo.toml ancestor', () => {
    const noCrate = mkdtempSync(path.join(tmpdir(), 'rust-nocrate-'));
    try {
      mkdirSync(path.join(noCrate, 'src'), { recursive: true });
      writeFileSync(path.join(noCrate, 'src', 'a.rs'), '// a\n', 'utf-8');
      const resolve = makeResolvePathToFile(noCrate);
      expect(resolve('crate::a', 'src/lib.rs', 'rust')).toBeUndefined();
    } finally {
      rmSync(noCrate, { recursive: true, force: true });
    }
  });

  it('returns undefined when super:: climbs above the crate root', () => {
    const resolve = makeResolvePathToFile(root);
    // From src/lib.rs (crate root module), super:: climbs above src → silence.
    expect(resolve('super::super::Thing', 'src/lib.rs', 'rust')).toBeUndefined();
  });
});
