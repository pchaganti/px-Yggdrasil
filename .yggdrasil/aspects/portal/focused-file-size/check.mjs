// Invariant 5: every portal backend file is a focused unit. A hard physical-line
// cap keeps one file from accreting unrelated responsibilities — a file nearing the
// cap is split into a derivation child, not grown. Pure content check (no AST), so it
// runs over every subject file including non-parseable ones.

const MAX_LINES = 400;

export function check(ctx) {
  const violations = [];
  for (const file of ctx.files) {
    // Count physical lines. A trailing newline does not add a phantom line.
    const text = file.content;
    const lineCount = text.length === 0 ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
    if (lineCount > MAX_LINES) {
      violations.push({
        file: file.path,
        line: MAX_LINES + 1,
        column: 0,
        message:
          `Portal backend file has ${lineCount} lines (cap ${MAX_LINES}). Split it into a focused ` +
          `derivation child rather than growing one file past its boundary.`,
      });
    }
  }
  return violations;
}
