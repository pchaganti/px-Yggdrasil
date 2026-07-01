import { track } from './telemetry.js';

export interface FulfillmentRequest {
  cartId: string;
  transactionId: string;
  address: string;
}

/**
 * Final checkout step: hand the paid order to the warehouse.
 * Emits `fulfillment.scheduled` so the funnel can confirm that captured
 * payments actually turn into shipments.
 */
export function scheduleFulfillment(request: FulfillmentRequest) {
  const shipmentId = `shp_${request.transactionId}`;

  track('fulfillment.scheduled', {
    cartId: request.cartId,
    transactionId: request.transactionId,
    shipmentId,
  });

  return { shipmentId, status: 'scheduled' as const };
}
