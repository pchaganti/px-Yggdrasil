// Payments service — charges and refunds payments for orders.

export interface Payment {
  orderId: string;
  amount: number;
}

export function charge(orderId: string, amount: number): Payment {
  return { orderId, amount };
}

export function refund(payment: Payment): Payment {
  return { orderId: payment.orderId, amount: -payment.amount };
}
