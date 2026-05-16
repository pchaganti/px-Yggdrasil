# CLI Command Contract

Every CLI command handler follows these conventions:

## Output routing

- Results to stdout via `process.stdout.write()`. Never `console.log`.
- Errors exclusively to stderr via `process.stderr.write()`.
- Chalk color semantics: green = ok/success, red = error/failure, yellow = warning, dim = suppressed/hidden.

## Error handling

- Every command action body is wrapped in try/catch.
- Catch block: `process.stderr.write(`Error: ${(error as Error).message}\n`)` then `process.exit(1)`.
- The missing-graph case is handled by `loadGraphOrAbort` (see **Graph loading** below) — commands do NOT inline a `'No .yggdrasil/ directory found'` string or ENOENT branch themselves.

## Exit codes

- `process.exit(1)` on failure (thrown error).
- `process.exit(1)` on actionable state (drift found, validation errors).
- Implicit exit 0 when no issues. Warnings alone do not trigger exit 1.

## Graph loading

- Commands requiring graph state start with `await loadGraphOrAbort(process.cwd())` (from `formatters/cli-preamble.js`).
- `loadGraphOrAbort` writes the canonical what/why/next missing-graph error to stderr and `process.exit(1)`s on ENOENT-shaped loader failures, then rethrows any other error so the surrounding try/catch handles it.
- The bootstrap command `init` is the only exception — it must run when no `.yggdrasil/` exists and therefore calls `loadGraph` directly inside its `--upgrade` path (covered by a separate suppression if the wider aspect ever forbids it).

## Node path normalization

- Commands accepting `--node <path>` normalize with: `options.node.trim().replace(/\/$/, '')`.

## File path normalization

- Commands accepting `--file <path>` resolve it via `resolveFileArg(repoRoot, options.file)` where `repoRoot = projectRootFromGraph(graph.rootPath)`. Never resolve relative to `process.cwd()` directly.
