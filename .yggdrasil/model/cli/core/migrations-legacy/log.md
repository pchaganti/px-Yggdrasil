## [2026-05-29T22:37:52.715Z]
The migrations were separated into a current-generation group (the latest transform, its helpers, and the registry) and a legacy group (older version transforms), so the set a reviewer inspects at once stays small as more migrations accumulate over time. No migration logic changed; only which node owns which file.
