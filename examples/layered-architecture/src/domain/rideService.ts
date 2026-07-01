// Domain layer: the business rules for booking and completing a ride.
// It reaches persistence only through the repository — never a raw store.

import {
  insertRide,
  findRide,
  updateRideStatus,
  RideRecord,
} from '../data/rideRepository.js';

const BASE_FARE_CENTS = 500;
const PER_TRIP_SURCHARGE_CENTS = 250;

export function bookRide(
  riderId: string,
  pickup: string,
  dropoff: string,
): RideRecord {
  const id = `ride_${Date.now()}`;
  const fareCents = BASE_FARE_CENTS + PER_TRIP_SURCHARGE_CENTS;

  return insertRide({
    id,
    riderId,
    driverId: null,
    pickup,
    dropoff,
    status: 'requested',
    fareCents,
  });
}

export function completeRide(id: string): RideRecord {
  const ride = findRide(id);
  if (!ride) {
    throw new Error(`Unknown ride: ${id}`);
  }
  if (ride.status === 'cancelled') {
    throw new Error(`Cannot complete a cancelled ride: ${id}`);
  }

  const completed = updateRideStatus(id, 'completed');
  if (!completed) {
    throw new Error(`Failed to complete ride: ${id}`);
  }
  return completed;
}
