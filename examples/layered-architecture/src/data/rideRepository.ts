// Data layer: owns all persistence for rides. No domain rules live here —
// only reads and writes against the store.

export interface RideRecord {
  id: string;
  riderId: string;
  driverId: string | null;
  pickup: string;
  dropoff: string;
  status: 'requested' | 'assigned' | 'completed' | 'cancelled';
  fareCents: number;
}

const rides = new Map<string, RideRecord>();

export function insertRide(record: RideRecord): RideRecord {
  rides.set(record.id, record);
  return record;
}

export function findRide(id: string): RideRecord | null {
  return rides.get(id) ?? null;
}

export function updateRideStatus(
  id: string,
  status: RideRecord['status'],
): RideRecord | null {
  const existing = rides.get(id);
  if (!existing) {
    return null;
  }
  const updated = { ...existing, status };
  rides.set(id, updated);
  return updated;
}
