## [2026-05-15T08:40:18.544Z]
Register registerTypeSuggestCommand in bin.ts entry point to expose yg type-suggest command.
## [2026-05-15T17:44:22.847Z]
Phase 2: reclassified from adapter to entry-point (maps source/cli/src/bin.ts).
## [2026-05-16T03:57:21.153Z]
Add unhandledRejection handler and try/catch around program.parse() — satisfies top-level-error-handler aspect: every unhandled error produces a structured message on stderr and a controlled exit code.
## [2026-05-29T08:26:02.108Z]
Added registration of the yg structure-test command (registerStructureTestCommand) in the main bin.ts dispatcher. This is the pattern used for all CLI commands — entry-point only imports and registers, no logic here.
