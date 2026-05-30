// Orders service — creates and retrieves customer orders.

export interface Order {
  id: string;
  total: number;
}

export function createOrder(id: string, total: number): Order {
  return { id, total };
}

export function orderSummary(order: Order): string {
  return `Order ${order.id}: ${order.total}`;
}
