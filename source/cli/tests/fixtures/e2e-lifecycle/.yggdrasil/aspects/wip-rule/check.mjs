// Draft aspect — the reviewer never invokes this while status is `draft`.
// It would flag every line containing the literal "WIP" if it were promoted,
// but as a draft it produces no verdict and no drift. Demonstrates the draft
// path: structurally valid, behaviorally dormant.
export function check(ctx) {
  const violations = [];
  for (const file of ctx.files) {
    const lines = file.content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes('WIP')) {
        violations.push({
          file: file.path,
          line: i + 1,
          column: 0,
          message: 'WIP marker found.',
        });
      }
    }
  }
  return violations;
}
