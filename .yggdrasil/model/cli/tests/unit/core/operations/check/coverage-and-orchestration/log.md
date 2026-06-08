## [2026-06-08T07:50:41.168Z]
Extended the scanUncoveredFiles test suite with a case that verifies files under a nested .yggdrasil subtree are excluded from the uncovered-file report. The test passes a git-file list that includes paths from both a covered source directory and a nested-graph subtree, and asserts that the nested subtree paths are absent from the result.
