# Test Determinism

Test suites must produce identical results on repeated runs. Non-determinism in tests hides real bugs, makes CI unreliable, and forces re-runs that waste time.

## Rules

- Tests must not call `Math.random()` directly. Any randomly generated test data must use fixed values in fixtures or a seeded generator with a fixed seed.
- Tests must not assert on real wall-clock time. `Date.now()` and `new Date()` may appear in test setup (writing a file the test needs), but not in assertions that must hold invariantly across runs.
- Each test that writes to the filesystem must use a fresh temporary directory (e.g. `mkdtempSync` or `mkdtemp`) created in `beforeEach` and cleaned up in `afterEach`. Tests must not share filesystem state across runs or between test cases.
- Tests must not depend on ambient environment state that differs across machines: specific port numbers, absolute paths outside `os.tmpdir()`, or environment variables that are not explicitly set within the test setup.
- When asserting on ordered collections, use `.toEqual([...])` only when order is part of the tested invariant. Use `expect.arrayContaining(...)` when the order of results is not guaranteed by the implementation.

## Rationale

A non-deterministic test that sometimes fails forces developers to re-run CI, misattribute failures, or suppress the test entirely. Deterministic tests catch regressions reliably and complete in a predictable time. These rules apply to all test types: unit, integration, and e2e.
