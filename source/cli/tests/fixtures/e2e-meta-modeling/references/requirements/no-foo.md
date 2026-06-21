---
title: No forbidden token in application source
enforced-by: enforced/no-foo
---

The application source must never contain the forbidden token. This requirement is
realized by a deterministic check that scans the application's source files and
refuses any occurrence.
