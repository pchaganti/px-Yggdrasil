import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { makeResolvePathToFile } from '../../../../src/relations/resolve-path.js';
import { resolveGoImport, type GoResolveDeps } from '../../../../src/relations/extractors/go-resolve.js';

// The Go resolver maps an import PATH → a package directory → a representative
// `.go` file. It reads go.mod for the module path and lists the package directory
// on disk, so these tests build a real temp repo and clean it up in `finally`.
// Driven through the production makeResolvePathToFile (disk-backed go.mod + readdir).

describe('resolveGoImport via makeResolvePathToFile (disk-backed)', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'go-resolve-'));
    // module example.com/m, with a package at foo/bar containing baz.go.
    writeFileSync(path.join(root, 'go.mod'), 'module example.com/m\n\ngo 1.22\n', 'utf-8');
    mkdirSync(path.join(root, 'foo', 'bar'), { recursive: true });
    writeFileSync(path.join(root, 'foo', 'bar', 'baz.go'), 'package bar\n', 'utf-8');
    // An empty package directory (exists but no .go file).
    mkdirSync(path.join(root, 'foo', 'empty'), { recursive: true });
    // A package directory with ONLY a test file.
    mkdirSync(path.join(root, 'foo', 'onlytest'), { recursive: true });
    writeFileSync(path.join(root, 'foo', 'onlytest', 'x_test.go'), 'package onlytest\n', 'utf-8');
    // A package directory with a production + test file — production must win.
    mkdirSync(path.join(root, 'foo', 'mixed'), { recursive: true });
    writeFileSync(path.join(root, 'foo', 'mixed', 'a.go'), 'package mixed\n', 'utf-8');
    writeFileSync(path.join(root, 'foo', 'mixed', 'a_test.go'), 'package mixed\n', 'utf-8');
    // The module root itself holds a .go file (for the module-root import case).
    writeFileSync(path.join(root, 'main.go'), 'package main\n', 'utf-8');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('resolves an in-module import path to a representative .go file in its directory', () => {
    const resolve = makeResolvePathToFile(root);
    expect(resolve('example.com/m/foo/bar', 'foo/app/main.go', 'go')).toBe('foo/bar/baz.go');
  });

  it('resolves the module path itself to a .go file at the module root', () => {
    const resolve = makeResolvePathToFile(root);
    expect(resolve('example.com/m', 'foo/app/main.go', 'go')).toBe('main.go');
  });

  it('prefers a production file over a *_test.go file', () => {
    const resolve = makeResolvePathToFile(root);
    expect(resolve('example.com/m/foo/mixed', 'foo/app/main.go', 'go')).toBe('foo/mixed/a.go');
  });

  it('falls back to a *_test.go file when the directory has only tests', () => {
    const resolve = makeResolvePathToFile(root);
    expect(resolve('example.com/m/foo/onlytest', 'foo/app/main.go', 'go')).toBe(
      'foo/onlytest/x_test.go',
    );
  });

  it('returns undefined for a stdlib import (not under the module path)', () => {
    const resolve = makeResolvePathToFile(root);
    expect(resolve('fmt', 'foo/app/main.go', 'go')).toBeUndefined();
    expect(resolve('os', 'foo/app/main.go', 'go')).toBeUndefined();
  });

  it('returns undefined for an external module import (not under the module path)', () => {
    const resolve = makeResolvePathToFile(root);
    expect(resolve('github.com/gorilla/mux', 'foo/app/main.go', 'go')).toBeUndefined();
  });

  it('returns undefined for an in-module path whose directory has no .go file', () => {
    const resolve = makeResolvePathToFile(root);
    expect(resolve('example.com/m/foo/empty', 'foo/app/main.go', 'go')).toBeUndefined();
  });

  it('returns undefined for an in-module path whose directory does not exist', () => {
    const resolve = makeResolvePathToFile(root);
    expect(resolve('example.com/m/foo/nope', 'foo/app/main.go', 'go')).toBeUndefined();
  });

  it('returns undefined when there is no go.mod (module path unknown)', () => {
    const noMod = mkdtempSync(path.join(tmpdir(), 'go-nomod-'));
    try {
      mkdirSync(path.join(noMod, 'foo', 'bar'), { recursive: true });
      writeFileSync(path.join(noMod, 'foo', 'bar', 'baz.go'), 'package bar\n', 'utf-8');
      const resolve = makeResolvePathToFile(noMod);
      expect(resolve('example.com/m/foo/bar', 'foo/app/main.go', 'go')).toBeUndefined();
    } finally {
      rmSync(noMod, { recursive: true, force: true });
    }
  });

  it('does not confuse a prefix that is not a path boundary (modulePath + non-slash)', () => {
    // import path `example.com/main` shares the textual prefix `example.com/m`
    // but is NOT under module `example.com/m` (next char is not `/`) → silence.
    const resolve = makeResolvePathToFile(root);
    expect(resolve('example.com/main', 'foo/app/main.go', 'go')).toBeUndefined();
  });
});

describe('resolveGoImport — pure unit (injected deps)', () => {
  const deps: GoResolveDeps = {
    modulePathFor: () => 'example.com/m',
    dirExists: (d) => d === 'foo/bar' || d === '',
    goFilesIn: (d) =>
      d === 'foo/bar' ? ['foo/bar/baz.go', 'foo/bar/aux.go'] : d === '' ? ['main.go'] : [],
  };

  it('picks the lexicographically-first .go file deterministically', () => {
    // aux.go sorts before baz.go → stable representative choice.
    expect(resolveGoImport('example.com/m/foo/bar', 'foo/x.go', deps)).toBe('foo/bar/aux.go');
  });

  it('returns undefined when modulePathFor yields nothing', () => {
    const noMod: GoResolveDeps = { ...deps, modulePathFor: () => undefined };
    expect(resolveGoImport('example.com/m/foo/bar', 'foo/x.go', noMod)).toBeUndefined();
  });

  it('silences a package directory split across 2+ owners (F20 package granularity)', () => {
    // foo/bar holds aux.go (owned by node "y") and baz.go (owned by node "x").
    // With an ownerOf that reports a SPLIT package, the import must resolve to
    // nothing — no representative file, no edge — rather than attributing the
    // whole package to whoever owns the lexicographically-first file.
    const split: GoResolveDeps = {
      ...deps,
      goFilesIn: (d) => (d === 'foo/bar' ? ['foo/bar/baz.go', 'foo/bar/aux.go'] : []),
      ownerOf: (f) => (f === 'foo/bar/aux.go' ? 'y' : f === 'foo/bar/baz.go' ? 'x' : undefined),
    };
    expect(resolveGoImport('example.com/m/foo/bar', 'foo/x.go', split)).toBeUndefined();
  });

  it('resolves a single-owner package even when ownerOf is supplied (positive)', () => {
    // Both files in foo/bar belong to node "x" → one owner → attribute the
    // representative (lexicographically-first production file, aux.go).
    const oneOwner: GoResolveDeps = {
      ...deps,
      goFilesIn: (d) => (d === 'foo/bar' ? ['foo/bar/baz.go', 'foo/bar/aux.go'] : []),
      ownerOf: () => 'x',
    };
    expect(resolveGoImport('example.com/m/foo/bar', 'foo/x.go', oneOwner)).toBe('foo/bar/aux.go');
  });
});
