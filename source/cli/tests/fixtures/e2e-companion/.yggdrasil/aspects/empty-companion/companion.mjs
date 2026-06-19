// A companion hook that resolves to no companion files. [] is a valid result:
// the unit is reviewed with its subject only (no <companions> block), but the
// aspect still SHIPS companion.mjs, so companionHash folds into every pair's
// verdict and a companion.mjs edit re-verifies them all.
export function companion(ctx) {
  void ctx;
  return [];
}
