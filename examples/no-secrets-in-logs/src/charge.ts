/**
 * Card-charge use case for the payments API.
 *
 * All observability here logs redacted, non-sensitive values only:
 * a masked PAN and the generated charge id. The raw card fields
 * (pan, cvv) never reach a log call — they stay inside the request
 * object and are handed to the acquirer over TLS elsewhere.
 */

import { logger, maskPan } from "./logger";

export interface Card {
  pan: string;
  cvv: string;
  expiry: string;
}

export interface ChargeRequest {
  card: Card;
  amountMinor: number;
  currency: string;
}

export interface ChargeResult {
  chargeId: string;
  status: "authorized" | "declined";
}

function newChargeId(): string {
  return `ch_${Math.random().toString(36).slice(2, 12)}`;
}

export function charge(request: ChargeRequest): ChargeResult {
  const chargeId = newChargeId();
  const maskedPan = maskPan(request.card.pan);

  logger.info("charge.started", {
    chargeId,
    maskedPan,
    amountMinor: request.amountMinor,
    currency: request.currency,
  });

  // Pretend authorization: decline anything at or above 1,000,000 minor units.
  const status: ChargeResult["status"] =
    request.amountMinor >= 1_000_000 ? "declined" : "authorized";

  if (status === "declined") {
    logger.warn("charge.declined", { chargeId, maskedPan });
    return { chargeId, status };
  }

  logger.info("charge.authorized", { chargeId, maskedPan });
  return { chargeId, status };
}
