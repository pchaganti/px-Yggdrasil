# Parser Contract

All parser adapters in the IO layer follow an identical pipeline regardless of the input format (YAML, JSON, NDJSON, plain text).

## Pipeline

1. Read raw content from disk (via `readTextFile` or equivalent io helper).
2. Parse to an untyped intermediate object (e.g. `parseYaml`, `JSON.parse`).
3. Validate fields manually with explicit type guards (`typeof x !== 'string'`, `!Array.isArray(x)`).
4. Throw a descriptive error with file path and field name on validation failure.
5. Return a typed domain object.

## Error format

- With path context: `<filename> at <path>: <field description>`
- Config-level: `<filename>: <field description>`

## Invariants

- No schema-based validation libraries (joi, zod, etc.) — validation is manual and explicit.
- Every required field is checked individually with a clear error message.
- Optional fields use fallback defaults; never throw on absence.
- Parsers never write — they are pure read-transform functions.
