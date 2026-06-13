/**
 * Exit after stdout has fully flushed. A large report written to a PIPE (an
 * agent capturing `yg check | grep`, `yg aspect-test` output, `yg impact`, or
 * CI) is buffered by the kernel; a bare `process.exit()` terminates the process
 * before that buffer drains and silently truncates the output — exactly when it
 * is longest. Waiting for the pending buffer to drain first preserves the
 * force-exit semantics (no hang on a lingering handle) while guaranteeing the
 * full report reaches the consumer.
 *
 * Shared by every command that does a large `process.stdout.write` immediately
 * followed by `process.exit()` (check, aspect-test, impact). Keep this the
 * single source of the drain-before-exit logic so the truncation fix cannot
 * regress in one command while staying correct in another.
 */
export async function exitAfterFlush(code: number): Promise<never> {
  if (process.stdout.writableLength > 0) {
    await new Promise<void>((resolve) => process.stdout.once('drain', resolve));
  }
  process.exit(code);
}
