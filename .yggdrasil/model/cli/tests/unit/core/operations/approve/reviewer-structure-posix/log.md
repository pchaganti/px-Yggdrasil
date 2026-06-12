## [2026-06-12T15:06:57.227Z]
Runner results now always carry the observation snapshot and its taint flag, so doubles standing in for the runner must declare both fields explicitly — an absent snapshot would be indistinguishable from a run that observed nothing.
