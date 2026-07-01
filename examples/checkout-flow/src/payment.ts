import { track } from './telemetry.js';

export interface PaymentRequest {
  cartId: string;
  amount: number;
  currency: string;
}

/**
 * Second checkout step: capture payment for the reviewed cart.
 * Emits `payment.captured` so the funnel can measure conversion from
 * cart review to a successful charge.
 */
export function capturePayment(request: PaymentRequest) {
  const transactionId = `txn_${request.cartId}_${Date.now()}`;

  track('payment.captured', {
    cartId: request.cartId,
    transactionId,
    amount: request.amount,
    currency: request.currency,
  });

  return { transactionId, status: 'captured' as const };
}
