export function check(ctx) {
  const violations = [];
  const commandFile = ctx.node.files[0];
  if (!commandFile) return violations;

  const basename = commandFile.path.split('/').pop();
  const stem = basename.replace(/\.ts$/, '');
  const expectedTestSuffix = `/${stem}.test.ts`;

  let testSuite;
  try {
    testSuite = ctx.graph.node('cli/tests/unit/cli');
  } catch (err) {
    violations.push({
      file: commandFile.path,
      message: `Command node cannot reach 'cli/tests/unit/cli'. Add 'relations: [{ type: uses, target: cli/tests/unit/cli }]' to this node's yg-node.yaml.`,
      kind: 'missing-relation',
    });
    return violations;
  }
  if (!testSuite) return violations;

  const allTests = collectTestFiles(testSuite, ctx);
  const hasSibling = allTests.some(f => f.path.endsWith(expectedTestSuffix));
  if (!hasSibling) {
    violations.push({
      file: commandFile.path,
      message: `Missing sibling test '${stem}.test.ts' under cli/tests/unit/cli/. Every command must have a unit test.`,
      kind: 'missing-test-sibling',
    });
  }
  return violations;
}

function collectTestFiles(node, ctx) {
  const out = [...node.files];
  for (const child of ctx.graph.children(node)) {
    out.push(...collectTestFiles(child, ctx));
  }
  return out;
}
