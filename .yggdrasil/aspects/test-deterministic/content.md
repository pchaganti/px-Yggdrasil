# Test Determinism

Test suites must produce identical results on repeated runs. Non-determinism in tests hides real bugs, makes CI unreliable, and forces re-runs that waste time.

## Rules

- Tests must not call `Math.random()` directly. Any randomly generated test data must use fixed values in fixtures or a seeded generator with a fixed seed.
- Tests must not assert on real wall-clock time. `Date.now()` and `new Date()` may appear in test setup (writing a file the test needs), but not in assertions that must hold invariantly across runs.
- Each test that writes to the filesystem must ensure the temporary directory is cleaned up when the test completes. Acceptable cleanup mechanisms: `afterEach` hook, `try/finally` block within the test, or a `rm -rf` at the start of the next test run on the same path (clean-before-use). Tests must not leave leaked directories that accumulate across CI runs. `mkdtempSync` or `mkdtemp` with no corresponding cleanup is a violation.
- Temporary directories may be created in `os.tmpdir()` or in a deterministic project-relative path (e.g. `path.join(__dirname, 'fixtures/tmp-<name>')`). Both are acceptable; what matters is that cleanup happens.
- Tests must not depend on ambient environment state that differs across machines: specific port numbers, or environment variables that are not explicitly set within the test setup. Exception: files named `*.external.test.ts` are opt-in external-service tests that intentionally require pre-configured environment variables and remote endpoints — these are excluded from CI and exempt from this rule.
- When asserting on ordered collections, use `.toEqual([...])` only when order is part of the tested invariant. Use `expect.arrayContaining(...)` when the order of results is not guaranteed by the implementation.

## Rationale

A non-deterministic test that sometimes fails forces developers to re-run CI, misattribute failures, or suppress the test entirely. Deterministic tests catch regressions reliably and complete in a predictable time. These rules apply to all test types: unit, integration, and e2e.
