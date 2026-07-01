import { track } from './telemetry.js';

export interface CartLine {
  sku: string;
  quantity: number;
  unitPrice: number;
}

/**
 * First checkout step: the shopper reviews the cart before paying.
 * Emits `cart.viewed` so the funnel can measure how many carts advance
 * to the payment step.
 */
export function reviewCart(cartId: string, lines: CartLine[]) {
  const subtotal = lines.reduce((sum, line) => sum + line.quantity * line.unitPrice, 0);

  track('cart.viewed', {
    cartId,
    lineCount: lines.length,
    subtotal,
  });

  return { cartId, subtotal, lineCount: lines.length };
}
