import { Router } from 'express'
import type { Request, Response } from 'express'
import type { AuthUser, LocationInput, LocationListResponse, LocationResponse } from '@hrm/shared'
import { pool, withTransaction } from '../db.js'
import { requireRole } from '../auth/middleware.js'
import { recordAudit } from '../audit.js'
import { fail, handleUnexpected } from '../http.js'
import { SELECT_LOCATION, findLocationById, rowToLocation, type LocationRow } from '../locationQueries.js'

export const locationsRouter = Router()

// Any HRM role may read master_locations, same as jobs/shifts — but write is
// Admin-only, not HR: a wrong radius or a stray inactive point here is a
// security control (who may clock in from where), not a scheduling detail,
// so this is narrower than canWrite elsewhere in this file's siblings.
const canRead = requireRole('HRM.Viewer', 'HRM.HR', 'HRM.Admin')
const canWrite = requireRole('HRM.Admin')

function actorOf(req: Request): AuthUser | null {
  return req.auth ?? null
}

type ParseResult<T> = { ok: true; value: T } | { ok: false; message: string }

function requiredString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key]
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

function requiredNumber(
  source: Record<string, unknown>,
  key: string,
  min: number,
  max: number
): number | null {
  const value = source[key]
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    return null
  }
  return value
}

function parseLocationInput(body: unknown): ParseResult<LocationInput> {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, message: 'body must be a JSON object' }
  }
  const raw = body as Record<string, unknown>

  const locationName = requiredString(raw, 'locationName')
  if (locationName === null) return { ok: false, message: 'locationName is required' }

  const latitude = requiredNumber(raw, 'latitude', -90, 90)
  if (latitude === null) return { ok: false, message: 'latitude must be a number between -90 and 90' }

  const longitude = requiredNumber(raw, 'longitude', -180, 180)
  if (longitude === null) {
    return { ok: false, message: 'longitude must be a number between -180 and 180' }
  }

  const radiusMeters = requiredNumber(raw, 'radiusMeters', 0.01, 1_000_000)
  if (radiusMeters === null) return { ok: false, message: 'radiusMeters must be a positive number' }

  const isActiveRaw = raw['isActive']
  if (typeof isActiveRaw !== 'boolean') {
    return { ok: false, message: 'isActive must be a boolean' }
  }

  return {
    ok: true,
    value: { locationName, latitude, longitude, radiusMeters, isActive: isActiveRaw },
  }
}

function parseId(value: string | string[] | undefined): number | null {
  if (typeof value !== 'string') return null
  const id = Number(value)
  return Number.isInteger(id) && id > 0 ? id : null
}

locationsRouter.get('/locations', canRead, async (_req: Request, res: Response) => {
  try {
    const { rows } = await pool.query<LocationRow>(`${SELECT_LOCATION} ORDER BY location_name`)
    const body: LocationListResponse = { locations: rows.map(rowToLocation) }
    res.json(body)
  } catch (err) {
    handleUnexpected(res, err)
  }
})

locationsRouter.get('/locations/:id', canRead, async (req: Request, res: Response) => {
  const id = parseId(req.params['id'])
  if (id === null) return fail(res, 400, 'id must be a positive integer')

  try {
    const location = await findLocationById(id)
    if (!location) return fail(res, 404, `no location with id ${id}`)

    const body: LocationResponse = { location }
    res.json(body)
  } catch (err) {
    handleUnexpected(res, err)
  }
})

locationsRouter.post('/locations', canWrite, async (req: Request, res: Response) => {
  const actor = actorOf(req)
  if (!actor) return fail(res, 500, 'server misconfigured')

  const parsed = parseLocationInput(req.body)
  if (!parsed.ok) return fail(res, 400, parsed.message)
  const input = parsed.value

  try {
    const location = await withTransaction(async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO master_locations (location_name, latitude, longitude, radius_meters, is_active)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id`,
        [input.locationName, input.latitude, input.longitude, input.radiusMeters, input.isActive]
      )
      const created = rows[0]
      if (!created) throw new Error('insert into master_locations returned no id')

      await recordAudit(client, {
        actor,
        action: 'location.create',
        entityId: Number(created.id),
        detail: { locationName: input.locationName },
      })

      return { ...input, id: Number(created.id) } satisfies LocationResponse['location']
    })

    const body: LocationResponse = { location }
    res.status(201).json(body)
  } catch (err) {
    handleUnexpected(res, err)
  }
})

// PUT, not PATCH: the body is a complete location, matching jobs and shifts.
locationsRouter.put('/locations/:id', canWrite, async (req: Request, res: Response) => {
  const actor = actorOf(req)
  if (!actor) return fail(res, 500, 'server misconfigured')

  const id = parseId(req.params['id'])
  if (id === null) return fail(res, 400, 'id must be a positive integer')

  const parsed = parseLocationInput(req.body)
  if (!parsed.ok) return fail(res, 400, parsed.message)
  const input = parsed.value

  try {
    const updated = await withTransaction(async (client) => {
      const { rowCount } = await client.query(
        `UPDATE master_locations SET
           location_name = $2, latitude = $3, longitude = $4, radius_meters = $5, is_active = $6,
           updated_at = now()
         WHERE id = $1`,
        [id, input.locationName, input.latitude, input.longitude, input.radiusMeters, input.isActive]
      )
      if (rowCount === 0) return false

      await recordAudit(client, {
        actor,
        action: 'location.update',
        entityId: id,
        detail: { locationName: input.locationName },
      })
      return true
    })

    if (!updated) return fail(res, 404, `no location with id ${id}`)

    const body: LocationResponse = { location: { ...input, id } }
    res.json(body)
  } catch (err) {
    handleUnexpected(res, err)
  }
})
