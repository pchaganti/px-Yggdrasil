# POSIX Paths — Output

All paths written to stdout, stored in graph outputs, or returned from public API functions use POSIX format for cross-platform consistency.

## Rules

- Backslash `\` is always replaced with forward slash `/` before any path is written to output or stored.
- Trailing slashes are always stripped from output paths.
- Path comparisons and storage always use the normalized form, never raw OS-native input.
- Graph-internal lookups (e.g. `graph.nodes.get()`, `flow.nodes?.includes()`) are exempt — graph data is normalized at load time by the graph loader.

## Implementation pattern

```typescript
path.replace(/\\/g, '/').replace(/\/+$/, '')
```

This applies to: paths in CLI stdout messages, paths returned by context formatters, paths stored in drift-state files, and any path passed as a return value from a node's public functions.

## Related

`posix-paths-source` (AST aspect) enforces the structural pattern in source code — it catches backslash literals and `path.sep` usage. `posix-paths-output` (this aspect) verifies semantic correctness at the output boundary.
