## [2026-06-12T13:14:18.355Z]
Added test cases for edge inputs that were missing coverage: per: 'File' (capitalized), files: {} (empty mapping), scope: null, scope: [] (array), and a nested node-family atom inside all_of in scope.files. These cases exercise the scope validation and file-when grammar paths introduced in the scope: block parser.
