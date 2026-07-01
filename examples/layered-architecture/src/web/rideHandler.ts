// Web layer: translates HTTP requests into domain calls. It talks only to
// the service layer — it must never reach into persistence directly.

import { bookRide, completeRide } from '../domain/rideService.js';

interface HttpRequest {
  body: Record<string, string>;
  params: Record<string, string>;
}

interface HttpResponse {
  status: number;
  body: unknown;
}

export function postRide(req: HttpRequest): HttpResponse {
  const { riderId, pickup, dropoff } = req.body;
  if (!riderId || !pickup || !dropoff) {
    return { status: 400, body: { error: 'missing required fields' } };
  }

  const ride = bookRide(riderId, pickup, dropoff);
  return { status: 201, body: ride };
}

export function postRideCompletion(req: HttpRequest): HttpResponse {
  const { id } = req.params;
  try {
    const ride = completeRide(id);
    return { status: 200, body: ride };
  } catch (err) {
    return { status: 409, body: { error: (err as Error).message } };
  }
}
