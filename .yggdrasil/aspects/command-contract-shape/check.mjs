import { ast } from '@chrisdudek/yg/ast';

const REGISTER_PATTERN = /^register[A-Z]\w*Command$/;

export function check(ctx) {
  const violations = [];
  for (const file of ctx.files) {
    if (!ast.inFile(file, 'src/cli/*.ts')) continue;

    const registerExports = ast
      .exports(file.ast.rootNode)
      .filter((n) => {
        const name = ast.nameOf(n);
        return name !== null && REGISTER_PATTERN.test(name);
      });

    if (registerExports.length === 0) {
      violations.push(
        ast.report(file, file.ast.rootNode, 'command file must export a register<Pascal>Command function'),
      );
    } else if (registerExports.length > 1) {
      violations.push(
        ast.report(
          file,
          registerExports[1],
          `command file exports ${registerExports.length} register*Command functions — must export exactly one`,
        ),
      );
    }
  }
  return violations;
}
