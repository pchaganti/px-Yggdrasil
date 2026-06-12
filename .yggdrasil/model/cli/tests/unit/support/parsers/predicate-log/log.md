## [2026-05-31T09:10:50.839Z]
Updated the suite to assert the corrected behavior after fixing product defects surfaced by this comprehensive E2E effort. The suite previously pinned the actual (defective) behavior so it would stay green either way; now that the defects are fixed, the assertions assert the intended contract instead, so the suite guards the corrected behavior going forward.
## [2026-06-12T13:14:21.760Z]
Updated all parseFileWhen calls in file-when-parser.test.ts to pass the now-required 'site' parameter ('scope.files'). No test logic changed.
