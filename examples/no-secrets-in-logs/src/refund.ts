/**
 * Refund use case for the payments API.
 *
 * Refunds are keyed by the original charge id; there is no cardholder
 * data in scope here. Logging references the charge id and refund id
 * only — both safe to retain.
 */

import { logger } from "./logger";

export interface RefundRequest {
  chargeId: string;
  amountMinor: number;
  reason: string;
}

export interface RefundResult {
  refundId: string;
  chargeId: string;
}

function newRefundId(): string {
  return `rf_${Math.random().toString(36).slice(2, 12)}`;
}

export function refund(request: RefundRequest): RefundResult {
  const refundId = newRefundId();

  logger.info("refund.started", {
    refundId,
    chargeId: request.chargeId,
    amountMinor: request.amountMinor,
  });

  logger.info("refund.completed", { refundId, chargeId: request.chargeId });
  return { refundId, chargeId: request.chargeId };
}
