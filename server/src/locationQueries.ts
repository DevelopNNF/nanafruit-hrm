// Reading locations out of master_locations. A single flat table, like
// master_jobs and master_shifts — the row-mapper alone, no SELECT-join
// helper needed.

import type pg from 'pg'
import type { Location } from '@hrm/shared'
import { pool } from './db.js'

type Queryable = Pick<pg.Pool, 'query'>

export type LocationRow = {
  id: string // bigint: pg hands these back as strings to avoid precision loss
  location_name: string
  latitude: string // numeric: pg hands these back as strings to avoid precision loss
  longitude: string
  radius_meters: string
  is_active: boolean
}

export const SELECT_LOCATION = `
  SELECT id, location_name, latitude, longitude, radius_meters, is_active
  FROM master_locations
`

export function rowToLocation(row: LocationRow): Location {
  return {
    id: Number(row.id),
    locationName: row.location_name,
    latitude: Number(row.latitude),
    longitude: Number(row.longitude),
    radiusMeters: Number(row.radius_meters),
    isActive: row.is_active,
  }
}

export async function findLocationById(id: number, db: Queryable = pool): Promise<Location | null> {
  const { rows } = await db.query<LocationRow>(`${SELECT_LOCATION} WHERE id = $1`, [id])
  const row = rows[0]
  return row ? rowToLocation(row) : null
}

/** Every active location — the candidate set a clock event's coordinates are
 *  checked against. See server/src/geo.ts for the distance check itself. */
export async function findActiveLocations(db: Queryable = pool): Promise<Location[]> {
  const { rows } = await db.query<LocationRow>(`${SELECT_LOCATION} WHERE is_active = true`)
  return rows.map(rowToLocation)
}
