#!/usr/bin/env bash

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
FAILED=()

run_step() {
  local label="$1"
  local cwd="$2"
  local command="$3"

  echo "[repo-check] $label"
  if (
    cd "$cwd"
    eval "$command"
  ); then
    : # ok
  else
    FAILED+=("$label")
  fi
}

run_step "CLI: typecheck" "$REPO_ROOT/source/cli" "npm run typecheck"
run_step "CLI: lint" "$REPO_ROOT/source/cli" "npm run lint"
run_step "CLI: build" "$REPO_ROOT/source/cli" "npm run build"
# Guard (D4): the spawned-binary E2E suites self-skip via describe.skipIf(!distExists).
# If the build silently produced no dist/bin.js they would ALL no-op and the test
# run would go green over zero E2E coverage. Fail loudly here instead.
run_step "CLI: built binary present (E2E guard)" "$REPO_ROOT/source/cli" "test -f dist/bin.js || { echo 'dist/bin.js missing after build — E2E suites would silently skip'; exit 1; }"
run_step "CLI: pack-smoke (A2)" "$REPO_ROOT/source/cli" "node scripts/pack-smoke.mjs"
run_step "CLI: test (with coverage)" "$REPO_ROOT/source/cli" "npm run test:coverage"
run_step "CLI: coverage >= 90%" "$REPO_ROOT/source/cli" "node -e \"
const j = require('./coverage/coverage-summary.json');
const t = j.total;
const lines = t.lines.pct;
const stmts = t.statements.pct;
const funcs = t.functions.pct;
const br = t.branches.pct;
if (lines < 90 || stmts < 90 || funcs < 90 || br < 90) {
  console.error('Coverage below 90%: lines=' + lines + '%, statements=' + stmts + '%, functions=' + funcs + '%, branches=' + br + '%');
  process.exit(1);
}
console.log('Coverage OK: lines=' + lines + '%, statements=' + stmts + '%, functions=' + funcs + '%, branches=' + br + '%');
\""
run_step "Docs: build" "$REPO_ROOT/docs" "npm run build"
run_step "Markdown: lint" "$REPO_ROOT" "npx markdownlint-cli2 \"**/*.md\" \".markdownlint-cli2.jsonc\""
run_step "Graph: check" "$REPO_ROOT" "node source/cli/dist/bin.js check --approve --only-deterministic"

if [ ${#FAILED[@]} -gt 0 ]; then
  echo ""
  echo "[repo-check] Failed: ${FAILED[*]}"
  exit 1
fi
echo "[repo-check] All checks passed"
