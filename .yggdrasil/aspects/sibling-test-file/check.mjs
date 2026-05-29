export function check(ctx) {
  const violations = [];
  for (const file of ctx.files) {
    // Command files live at source/cli/src/cli/<name>.ts
    // Expected sibling test: source/cli/tests/unit/cli/<name>.test.ts
    const testPath = file.path
      .replace('source/cli/src/cli/', 'source/cli/tests/unit/cli/')
      .replace(/\.ts$/, '.test.ts');
    if (ctx.fs.exists(testPath) !== 'file') {
      violations.push({
        message: `Missing sibling test file: ${testPath}. Every command must have a unit test.`,
        file: file.path,
        line: 1,
        column: 1,
        kind: 'missing-test-sibling',
      });
    }
  }
  return violations;
}
