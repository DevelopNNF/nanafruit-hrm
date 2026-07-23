// Straight-line ("as the crow flies") distance between two lat/lng points, for
// attendance geofencing — a circle around each master_locations row, not a
// polygon, which is what was asked for and is plenty for a single site.

import type { Location } from '@hrm/shared'

const EARTH_RADIUS_METERS = 6_371_000

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180
}

/** Haversine distance in meters. */
export function distanceMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = toRadians(lat2 - lat1)
  const dLon = toRadians(lon2 - lon1)
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLon / 2) ** 2
  return EARTH_RADIUS_METERS * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

export type LocationMatch = { location: Location; distanceMeters: number }

/**
 * The active location closest to (lat, lon) — regardless of whether it's
 * within that location's own radius. Callers compare the returned distance
 * against `location.radiusMeters` themselves, which is what lets a rejection
 * report "how far off" rather than just "no".
 *
 * Returns null only when `locations` is empty — callers treat that as
 * geofencing not being configured yet, not as "nothing matched".
 */
export function nearestLocation(
  lat: number,
  lon: number,
  locations: Location[]
): LocationMatch | null {
  let best: LocationMatch | null = null
  for (const location of locations) {
    const distance = distanceMeters(lat, lon, location.latitude, location.longitude)
    if (best === null || distance < best.distanceMeters) {
      best = { location, distanceMeters: distance }
    }
  }
  return best
}
