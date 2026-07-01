/**
 * Minimal structured logger for the payments service.
 *
 * Log lines are shipped to a centralized aggregator that is retained for
 * audit purposes. Because those retained lines fall inside PCI-DSS scope,
 * callers MUST pass only redacted / non-sensitive values (ids, masked PANs,
 * amounts) — never raw secrets or full cardholder data.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

interface LogFields {
  [key: string]: string | number | boolean | null | undefined;
}

function emit(level: LogLevel, message: string, fields?: LogFields): void {
  const line = {
    ts: new Date().toISOString(),
    level,
    message,
    ...fields,
  };
  // In production this is routed to the log aggregator; stdout for the example.
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

export const logger = {
  debug: (message: string, fields?: LogFields): void => emit("debug", message, fields),
  info: (message: string, fields?: LogFields): void => emit("info", message, fields),
  warn: (message: string, fields?: LogFields): void => emit("warn", message, fields),
  error: (message: string, fields?: LogFields): void => emit("error", message, fields),
};

/**
 * Mask a Primary Account Number to its last four digits, e.g.
 * "4242424242424242" -> "************4242". Callers log the masked form.
 */
export function maskPan(pan: string): string {
  const last4 = pan.slice(-4);
  return `${"*".repeat(Math.max(0, pan.length - 4))}${last4}`;
}
