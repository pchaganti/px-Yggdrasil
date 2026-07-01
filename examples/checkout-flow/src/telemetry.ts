/**
 * Shared telemetry helper for the checkout process.
 *
 * Every checkout step reports a domain event through `track` so the
 * observability pipeline can reconstruct the funnel (cart -> payment ->
 * fulfillment) and alert on drop-off between steps.
 */

export interface TelemetryEvent {
  /** Dotted event name, e.g. `cart.viewed`. */
  name: string;
  /** Arbitrary structured payload attached to the event. */
  properties?: Record<string, unknown>;
}

/**
 * Emit a single telemetry event. In production this flushes to the
 * analytics sink; here it writes a structured line the collector scrapes.
 */
export function track(name: string, properties: Record<string, unknown> = {}): void {
  const event: TelemetryEvent = { name, properties };
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ type: 'telemetry', ...event }));
}
