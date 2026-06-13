import { walk, report } from '@chrisdudek/yg/ast';

// A migration must NOT write the project version itself. The migration runner is
// the sole writer of yg-config.yaml's `version` field — it calls
// updateConfigVersion(yggRoot, migration.to) once a migration reports success.
// Mechanically: flag ANY call to updateConfigVersion from migration code.
const FORBIDDEN_CALLEE = 'updateConfigVersion';

export function check(ctx) {
  const violations = [];
  for (const file of ctx.files) {
    if (!file.ast) continue;
    walk(file.ast.rootNode, (node) => {
      if (node.type !== 'call_expression') return;
      const callee = node.childForFieldName('function');
      if (!callee) return;
      // Match a bare call `updateConfigVersion(...)` — function is an identifier.
      if (callee.type === 'identifier' && callee.text === FORBIDDEN_CALLEE) {
        violations.push(
          report(
            file,
            node,
            `migration calls '${FORBIDDEN_CALLEE}()' — version bookkeeping is delegated to the runner, which is the sole writer of yg-config.yaml's version field (return bumpVersion: false to withhold the bump)`,
          ),
        );
      }
    });
  }
  return violations;
}
