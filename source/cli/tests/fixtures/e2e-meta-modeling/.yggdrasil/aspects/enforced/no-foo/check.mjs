// Trivial deterministic enforcer. Its real purpose in this fixture is to EXIST as a
// check file under .yggdrasil/aspects/enforced/ so a meta node can map it, reference
// it, and inject it via a companion — the four meta-modeling access channels.
export function check(ctx) {
  void ctx;
  return [];
}
