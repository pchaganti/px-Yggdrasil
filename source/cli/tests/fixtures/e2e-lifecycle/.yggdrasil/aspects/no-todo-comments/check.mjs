// Flags any line in a source file that contains the literal token "TODO".
// Reliable, language-agnostic refuse/pass trigger: add a TODO to refuse,
// remove it to pass. Operates on raw file content (no AST needed) so it
// works on any source text the runner hands us.
export function check(ctx) {
  const violations = [];
  for (const file of ctx.files) {
    const lines = file.content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes('TODO')) {
        violations.push({
          file: file.path,
          line: i + 1,
          column: 0,
          message: 'TODO comment found — remove it or track the work in the issue tracker.',
        });
      }
    }
  }
  return violations;
}
