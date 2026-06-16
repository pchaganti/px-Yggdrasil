## [2026-06-13T03:12:07.687Z]
Producer and verifier must fold byte-identical hash ingredients or every recorded verdict would read as unverified, so the ingredient assembly lives in one shared place that both the fill stage and the check stage call, with each side owning only its own read-failure policy.
## [2026-06-16T09:52:38.429Z]
Same contract as the hash core: the tier hash view folds only the tier NAME. The resolved tier configuration is not a judgment input, so swapping the model or provider behind a named tier does not invalidate recorded verdicts.
