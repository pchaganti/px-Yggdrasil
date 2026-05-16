# Top-Level Error Handler

The entry-point file (`bin.ts`) must catch every uncaught error — both synchronous and asynchronous — and convert it to a consistent CLI message before exiting.

## Rules

- A `try-catch` block wraps the synchronous entry point (e.g., `program.parse()`). Any synchronous exception writes to `process.stderr` and calls `process.exit(1)`.
- A `process.on('unhandledRejection', ...)` handler catches any async error that escapes all inner handlers. It writes the error message to `process.stderr` and calls `process.exit(1)`.
- Both handlers produce the same output format: `Error: <message>\n` to stderr.
- Neither handler rethrows — they terminate the process cleanly.
- `process.exit(1)` is the only allowed exit code for errors at this level. Exit code 0 is used only for success (Commander sets this automatically).

## Rationale

Without a top-level handler, unhandled promise rejections or synchronous throws produce Node.js stack traces on stderr and may exit with an undefined code. The top-level handler ensures the user always sees a clean error message, not an unformatted stack trace.
