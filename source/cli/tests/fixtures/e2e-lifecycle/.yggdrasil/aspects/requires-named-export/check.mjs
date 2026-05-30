// Flags a source file that contains no `export ` statement. Advisory: a
// violation renders as a non-blocking warning. Operates on raw file content
// so it is language-agnostic for the export keyword used by JS/TS sources.
export function check(ctx) {
  const violations = [];
  for (const file of ctx.files) {
    if (!file.content.includes('export ')) {
      violations.push({
        file: file.path,
        line: 1,
        column: 0,
        message: 'File has no named export — add an `export` so the module can be consumed.',
      });
    }
  }
  return violations;
}
