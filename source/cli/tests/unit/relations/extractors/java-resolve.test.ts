import { describe, it, expect } from 'vitest';
import {
  resolveJavaFqn,
  resolveJavaPackageFiles,
  type JavaResolveDeps,
} from '../../../../src/relations/extractors/java-resolve.js';

// Fixed resolution universe (repo-relative POSIX). Two source roots are present —
// a flat `src/main/java/...` Maven layout and a sibling `lib/...` root — to prove
// the ancestor-source-root search works regardless of layout.
const files = new Set([
  'src/main/java/com/acme/payments/PaymentService.java',
  'src/main/java/com/acme/audit/AuditLog.java',
  'src/main/java/com/acme/audit/AuditWriter.java',
  'src/main/java/com/foo/Outer.java',
  'src/main/java/com/acme/app/OrderHandler.java',
]);

const deps: JavaResolveDeps = {
  exists: (p) => files.has(p),
  javaFilesIn: (dir) => {
    const prefix = dir === '' ? '' : dir + '/';
    return [...files].filter(
      (f) => f.startsWith(prefix) && !f.slice(prefix.length).includes('/'),
    );
  },
};

const FROM = 'src/main/java/com/acme/app/OrderHandler.java';

describe('resolveJavaFqn — type FQN → file', () => {
  it('resolves a type FQN via an ancestor source root', () => {
    expect(resolveJavaFqn('com.acme.payments.PaymentService', FROM, deps)).toBe(
      'src/main/java/com/acme/payments/PaymentService.java',
    );
  });

  it('resolves a nested-type FQN to the enclosing type file (longest-match parent)', () => {
    // com.foo.Outer.Inner → no Outer/Inner.java; falls back to Outer.java.
    expect(resolveJavaFqn('com.foo.Outer.Inner', FROM, deps)).toBe(
      'src/main/java/com/foo/Outer.java',
    );
  });

  it('returns undefined for a JDK stdlib type (no mapped file)', () => {
    expect(resolveJavaFqn('java.util.List', FROM, deps)).toBeUndefined();
    expect(resolveJavaFqn('javax.annotation.Nullable', FROM, deps)).toBeUndefined();
  });

  it('returns undefined for an external-library type (no mapped file)', () => {
    expect(resolveJavaFqn('com.google.common.collect.ImmutableList', FROM, deps)).toBeUndefined();
  });

  it('returns undefined for a single bare segment that maps to nothing', () => {
    expect(resolveJavaFqn('Nope', FROM, deps)).toBeUndefined();
  });

  it('returns undefined for an empty / dots-only specifier (no segments)', () => {
    // '' and '.' both reduce to zero non-empty segments → the segment-count guard
    // returns undefined without probing the filesystem.
    expect(resolveJavaFqn('', FROM, deps)).toBeUndefined();
    expect(resolveJavaFqn('.', FROM, deps)).toBeUndefined();
  });

  it('resolves from a file at the repo root (dirname is "." → root ancestor)', () => {
    // A fromFile with no directory yields dirname '.', which ancestorDirs maps to the
    // repo root ''. The type FQN resolves against a file directly under the root.
    const rootFiles = new Set(['com/foo/Bar.java']);
    const rootDeps: JavaResolveDeps = {
      exists: (p) => rootFiles.has(p),
      javaFilesIn: () => [],
    };
    expect(resolveJavaFqn('com.foo.Bar', 'Main.java', rootDeps)).toBe('com/foo/Bar.java');
  });
});

describe('resolveJavaPackageFiles — wildcard package FQN → candidate file set', () => {
  it('returns ALL .java files in the resolved package directory', () => {
    // com.acme.audit → src/main/java/com/acme/audit/ has TWO files.
    expect(resolveJavaPackageFiles('com.acme.audit', FROM, deps).sort()).toEqual([
      'src/main/java/com/acme/audit/AuditLog.java',
      'src/main/java/com/acme/audit/AuditWriter.java',
    ]);
  });

  it('returns an empty set for a package with no source files anywhere', () => {
    expect(resolveJavaPackageFiles('com.acme.empty', FROM, deps)).toEqual([]);
  });

  it('returns the single file for a one-file package', () => {
    // com.acme.payments has exactly one .java.
    expect(resolveJavaPackageFiles('com.acme.payments', FROM, deps)).toEqual([
      'src/main/java/com/acme/payments/PaymentService.java',
    ]);
  });
});

describe('resolveJavaFqn — single-type import does NOT fall through to a package', () => {
  it('returns undefined for a type FQN whose path is a DIRECTORY of .java files', () => {
    // com.acme.audit is a package directory, NOT a type. A single-type hint
    // (isPackage absent) must not resolve it as a package — the old fall-through
    // would have returned a representative .java; the guard returns undefined.
    expect(resolveJavaFqn('com.acme.audit', FROM, deps)).toBeUndefined();
  });

  it('still resolves a real type FQN to its file', () => {
    expect(resolveJavaFqn('com.acme.payments.PaymentService', FROM, deps)).toBe(
      'src/main/java/com/acme/payments/PaymentService.java',
    );
  });
});
