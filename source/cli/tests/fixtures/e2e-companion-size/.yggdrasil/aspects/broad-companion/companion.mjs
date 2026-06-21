// Reproduction companion for the verify-lock §4 size gate.
//
// The hook READS a large reachable file (`payloads/big.txt`) to "decide" — this is
// recorded as a read: observation in `touched` — but INJECTS only the small paired
// payload (`payloads/small.txt`). The injected prompt is therefore small.
//
// The bug: plain `yg check` reconstructed the gate's companion set from the stored
// `touched` read: keys, which conflates the large DECISION read with the small
// INJECTED companion — measuring a prompt ~the size of big.txt. The fix runs this
// hook live and measures only what it returns (small.txt).
export function companion(ctx) {
  // Decision read: inspect a large reachable file but DO NOT inject it.
  void ctx.fs.read('payloads/big.txt');
  // Inject only the small paired payload.
  return [{ path: 'payloads/small.txt', label: 'small payload' }];
}
