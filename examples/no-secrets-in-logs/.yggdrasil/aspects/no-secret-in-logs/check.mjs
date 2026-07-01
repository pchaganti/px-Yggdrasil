/**
 * no-secret-in-logs — deterministic check.
 *
 * Rule: a logging call must never reference a raw secret or PII identifier.
 * A "logging call" is logger.debug/info/warn/error(...) or console.*(...).
 * If any of the forbidden field names appears as an identifier inside the
 * call's argument list, the call is a violation (PCI-DSS: cardholder data
 * and credentials must never be written to logs).
 *
 * This is a pure content scan over each file's raw text — no AST required.
 * It is line-based so the reported line number points straight at the
 * offending log call.
 */

// Identifiers that must never appear inside a log call's arguments.
const FORBIDDEN = [
  "password",
  "apiKey",
  "secret",
  "token",
  "pan",
  "cardNumber",
  "cvv",
  "ssn",
];

// Matches the start of a logging call and captures everything after the
// opening paren on the same line: logger.info( ... | console.error( ...
const LOG_CALL = /(?:\blogger\s*\.\s*(?:debug|info|warn|error)|\bconsole\s*\.\s*(?:log|debug|info|warn|error))\s*\(/;

// A forbidden name is only a hit when it stands alone as an identifier —
// not as a substring of a larger word. So `maskedPan`, `chargeId`,
// `panelName` are safe; `pan`, `card.pan`, `req.cvv` are not.
function referencesForbidden(argText) {
  for (const name of FORBIDDEN) {
    // (^|[^A-Za-z0-9_]) left boundary, then name, then a right boundary
    // that is NOT a name character. This keeps `pan` from matching inside
    // `maskedPan` / `panel` while still catching `.pan`, `pan,`, `pan)`.
    const re = new RegExp(`(^|[^A-Za-z0-9_])${name}(?![A-Za-z0-9_])`);
    if (re.test(argText)) return name;
  }
  return null;
}

export function check(ctx) {
  const violations = [];

  for (const file of ctx.files) {
    // Only scan source we understand; skip anything non-.ts just in case.
    if (!file.path.endsWith(".ts")) continue;

    const lines = file.content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const start = line.match(LOG_CALL);
      if (!start) continue;

      // Arguments are everything from just after the log call's "(" to the
      // end of the line — enough for a single-line log statement, which is
      // the shape this rule targets.
      const openParen = start.index + start[0].length;
      const argText = line.slice(openParen);

      const hit = referencesForbidden(argText);
      if (hit) {
        violations.push({
          file: file.path,
          line: i + 1,
          column: openParen,
          message:
            `Logging call references forbidden secret/PII field "${hit}". ` +
            `Log a redacted value (e.g. a masked PAN or an id) instead — ` +
            `raw cardholder data and credentials must never be written to logs (PCI-DSS).`,
        });
      }
    }
  }

  return violations;
}
