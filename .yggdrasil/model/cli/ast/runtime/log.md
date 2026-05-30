## [2026-05-15T17:44:12.755Z]
Phase 2: split from cli/ast — loader hook, parser, check runner, suppress. Type: ast-adapter.
## [2026-05-15T19:28:49.972Z]
Move IssueMessage type from formatters/message-builder to model/validation — engine→formatter import violation fix for boundaries enforcement
## [2026-05-26T09:43:17.807Z]
Add find-comments.ts reading comment node types from language registry per ctx.language. Two discriminated forms: file ({ ast, language }) or subtree ({ rootNode, language }). Both present throws AST_FINDCOMMENTS_AMBIGUOUS_TARGET; unknown language throws AST_FINDCOMMENTS_UNKNOWN_LANGUAGE. Errors propagate through runner's AST_CHECK_THROWN path. Task 28 reassigns to cli/ast/report alongside walk/file-path/index.
## [2026-05-26T09:50:11.164Z]
Add AST_CHECK_FILE_NOT_IN_CONTEXT runtime guard. check.mjs cannot synthesize violations for files outside ctx.files (protects suppress mechanism — markers cannot reach unknown files). Throws via existing AstRunnerError; cli/approve.ts catch (added in Task 3) flows it through errorSource: 'astRuntime'.
## [2026-05-26T10:52:26.554Z]
Remove find-comments.ts from mapping — this file was reassigned to cli/ast/report as part of the public API consolidation. The runtime node now only contains: loader hook, parser, check runner, and suppress marker extractor.
## [2026-05-28T10:07:11.726Z]
Added optional ParseCache parameter to RunAstAspectParams and runAstAspect. When provided, the cache is checked before reading and parsing each file — if the file is already in the cache, the cached content and AST are reused directly. After parsing, the result is stored in the cache. This avoids redundant file reads and re-parses when the same source files are visited by multiple AST aspects in a single dry-run or approve invocation. The ParseCache type is exported for use by CLI-layer callers.
## [2026-05-29T06:40:35.395Z]
Extract the ParseCache type alias from the AST runner into a small neutral module so the upcoming structure runner can share the same per-invocation cache shape. Runner re-exports the type for callers that import it from the AST entry.
## [2026-05-30T07:12:18.331Z]
The four check.mjs export-shape guards — named export present, not a default-only export, is a function, takes exactly one argument — now come from one shared validator so the AST and structure runtimes cannot drift apart in what they accept or in the wording of the error they raise. Error codes are unchanged; the only text change is a trailing aspect-id suffix on the default-export message.
## [2026-05-30T14:09:01.061Z]
The per-aspect language declaration was removed from the system. An aspect that ships a parsed-tree check used to carry a `language:` list naming the languages it targeted, and the system validated that list with four dedicated checks. Nothing in the runtime ever read it: the engine already determines each source file's language from its file extension through one shared registry, then loads the matching grammar. The declaration was therefore inert metadata that could silently disagree with what the engine actually parsed — an authoritative-looking field that governed nothing.

This change deletes the field, the validators that policed its shape, and the documentation and tests that described it, and promotes the extension-to-grammar registry to the single authority for matching a file to its parser. The motivation is to remove a confusing mismatch between what an aspect claimed about languages and what the engine did, and to collapse the duplicated extension-knowledge that had drifted into more than one place.

The language a parsed-tree check sees for a given file is now derived solely from that file's extension; an unrecognized extension yields no parsed tree rather than a per-aspect error. The drift identity of a graph-aware structural check is deliberately held stable across this change so existing approvals are not invalidated by metadata that never affected behavior.
