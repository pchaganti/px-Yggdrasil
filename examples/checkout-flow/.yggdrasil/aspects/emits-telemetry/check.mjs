// Deterministic aspect: emits-telemetry
//
// Every checkout step must report a domain event so the observability
// pipeline can reconstruct the funnel (cart -> payment -> fulfillment).
// The rule is satisfied when the step's TypeScript source contains at
// least one call to `track(` (e.g. track('cart.viewed', { ... })).
//
// This check is attached at the FLOW level ('checkout'), so it propagates
// to every participant (cart, payment, fulfillment). A step that stops
// emitting telemetry is refused — proving the flow-level rule reaches
// every component in the business process.

export function check(ctx) {
  const violations = [];

  for (const file of ctx.files) {
    // Only enforce on TypeScript step handlers.
    if (!file.path.endsWith('.ts')) continue;

    // A telemetry event is emitted via a `track(` call.
    if (/\btrack\s*\(/.test(file.content)) continue;

    violations.push({
      file: file.path,
      line: 1,
      column: 0,
      message:
        'Checkout step does not emit a telemetry event: add a track(...) call ' +
        "(e.g. track('cart.viewed', { ... })) so this step appears in the funnel.",
    });
  }

  return violations;
}
