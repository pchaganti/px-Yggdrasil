import { describe, it, expect } from 'vitest';
import { resolveJavaFqn, type JavaResolveDeps } from '../../../../src/relations/extractors/java-resolve.js';

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
});

describe('resolveJavaFqn — wildcard package FQN → directory', () => {
  it('resolves a package FQN to a representative .java in that package directory', () => {
    // com.acme.audit → src/main/java/com/acme/audit/ → lexically-first .java.
    expect(resolveJavaFqn('com.acme.audit', FROM, deps)).toBe(
      'src/main/java/com/acme/audit/AuditLog.java',
    );
  });

  it('returns undefined for a package with no source files anywhere', () => {
    expect(resolveJavaFqn('com.acme.empty', FROM, deps)).toBeUndefined();
  });
});
