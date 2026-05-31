## [2026-05-28T08:20:06.069Z]
Added context-references.test.ts covering the new references rendering behavior in both formatFileContext and formatNodeContext: read: line emission ordering, description truncation at word boundaries, bare-path emission when no description, and regression for aspects without references.
## [2026-05-28T14:13:30.184Z]
Extended context-file and context-node formatter tests to cover the new bracketed status tag and the draft skip path. Cases assert that an enforced aspect renders [enforced] followed by the read: line plus any reference lines; that a draft aspect renders [draft], a reviewer-skipped notice, and no read: lines for either the aspect content or its references; that mixed-status lists keep the declaration order intact; and that an aspect with an undefined status defaults to enforced. Branch-coverage additions cover a draft aspect that still has source or implies metadata and a reference without a description.
## [2026-05-28T15:48:35.256Z]
Add snapshot tests for all 9 aspect-status message builders
## [2026-05-31T06:24:50.666Z]
Two agent-facing diagnostics were corrected. A multi-node cascade target list rendered with a doubled path separator; it now renders with a single separator. And a configuration whose schema version is newer than this CLI supports was being wrapped as an internal bug with a file-an-issue prompt; it is now classified as the expected user error it is — telling the user to upgrade the CLI — without the bug framing. Neither changes the underlying detection; both make the output read correctly.
