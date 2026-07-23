import { Router } from 'express'
import type { Request, Response } from 'express'
import {
  ATTENDANCE_EVENT_TYPES,
  ROLES,
  type AttendanceClockResponse,
  type AttendanceEventType,
  type AttendanceListResponse,
  type AttendanceStatusResponse,
} from '@hrm/shared'
import { pool } from '../db.js'
import { requireRole } from '../auth/middleware.js'
import { fail, handleUnexpected } from '../http.js'
import { findEmployeeById } from '../employeeQueries.js'
import { findActiveLocations } from '../locationQueries.js'
import { nearestLocation } from '../geo.js'
import {
  findLastAttendanceEvent,
  listAttendanceEvents,
  rowToAttendanceEvent,
  type AttendanceRow,
} from '../attendanceQueries.js'

export const attendanceRouter = Router()

// Same read split as shifts/jobs: any HRM role may look at the admin list.
// There is no write role here — nothing under /api/attendance/clock or
// /api/attendance/me is admin-writable, an employee can only ever record
// their own events.
const canReadAdmin = requireRole(...ROLES)

/** Both /clock and /me are for the employee arm of AuthUser only — an admin
 *  token has no employeeId to act as, and cannot clock in for someone else. */
function requireEmployeeId(req: Request, res: Response): number | null {
  const auth = req.auth
  if (!auth) {
    fail(res, 500, 'server misconfigured')
    return null
  }
  if (auth.kind !== 'employee') {
    fail(res, 403, 'this endpoint is for employee accounts', 'FORBIDDEN')
    return null
  }
  return auth.employeeId
}

type ParseResult<T> = { ok: true; value: T } | { ok: false; message: string }

/** The wire shape (AttendanceClockRequest) makes coordinates optional, since a
 *  client with no geolocation support may omit them rather than send null —
 *  but once parsed, this code always has a definite number-or-null to reason
 *  about, so the parsed shape drops the "or absent" that only ever mattered
 *  on the wire. */
type ParsedClockInput = {
  eventType: AttendanceEventType
  latitude: number | null
  longitude: number | null
  accuracyMeters: number | null
  deviceInfo: string | null
}

/** A finite number in range, or null/undefined passed through — see
 *  AttendanceClockRequest: coordinates are optional, not just nullable, since
 *  a client with no geolocation support omits them rather than sending null. */
function optionalCoordinate(
  source: Record<string, unknown>,
  key: string,
  min: number,
  max: number
): number | null | undefined {
  const value = source[key]
  if (value === undefined || value === null) return null
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    return undefined
  }
  return value
}

function parseClockInput(body: unknown): ParseResult<ParsedClockInput> {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, message: 'body must be a JSON object' }
  }
  const raw = body as Record<string, unknown>

  const eventType = raw['eventType']
  if (
    typeof eventType !== 'string' ||
    !ATTENDANCE_EVENT_TYPES.includes(eventType as AttendanceEventType)
  ) {
    return { ok: false, message: `eventType must be one of: ${ATTENDANCE_EVENT_TYPES.join(', ')}` }
  }

  const latitude = optionalCoordinate(raw, 'latitude', -90, 90)
  if (latitude === undefined) return { ok: false, message: 'latitude must be a number between -90 and 90, or null' }

  const longitude = optionalCoordinate(raw, 'longitude', -180, 180)
  if (longitude === undefined) return { ok: false, message: 'longitude must be a number between -180 and 180, or null' }

  if ((latitude === null) !== (longitude === null)) {
    return { ok: false, message: 'latitude and longitude must both be set, or both be empty' }
  }

  const accuracyMeters = optionalCoordinate(raw, 'accuracyMeters', 0, 1_000_000)
  if (accuracyMeters === undefined) {
    return { ok: false, message: 'accuracyMeters must be a non-negative number, or null' }
  }

  // Debugging data, not something a clock event should ever fail over — a
  // wrong type is silently dropped rather than rejected, same reasoning as
  // GPS being optional.
  const deviceInfoRaw = raw['deviceInfo']
  const deviceInfo = typeof deviceInfoRaw === 'string' ? deviceInfoRaw.trim().slice(0, 500) || null : null

  return {
    ok: true,
    value: { eventType: eventType as AttendanceEventType, latitude, longitude, accuracyMeters, deviceInfo },
  }
}

attendanceRouter.post('/attendance/clock', async (req: Request, res: Response) => {
  const employeeId = requireEmployeeId(req, res)
  if (employeeId === null) return

  const parsed = parseClockInput(req.body)
  if (!parsed.ok) return fail(res, 400, parsed.message)
  const input = parsed.value

  try {
    const last = await findLastAttendanceEvent(employeeId)
    if (input.eventType === 'check_in' && last?.eventType === 'check_in') {
      return fail(res, 409, 'ลงเวลาเข้างานไปแล้ว กรุณาลงเวลาออกก่อน')
    }
    if (input.eventType === 'check_out' && last?.eventType !== 'check_in') {
      return fail(res, 409, 'ยังไม่ได้ลงเวลาเข้างาน')
    }

    // Geofencing is unconditional — there is no "not configured yet" grace
    // period. An empty master_locations table blocks every clock event, same
    // as being genuinely out of range: this repo's earlier stance ("a missing
    // GPS fix must never block a clock event") was explicitly overridden for
    // this feature, so an empty-table fallthrough would quietly reinstate the
    // behaviour that was just turned off. Until admin/ has at least one
    // location active, no one can clock in — a manual time correction is the
    // documented workaround for that gap, not a code path here.
    if (input.latitude === null || input.longitude === null) {
      return fail(res, 409, 'ไม่พบพิกัด GPS กรุณาเปิดสิทธิ์ตำแหน่งที่ตั้งแล้วลองลงเวลาอีกครั้ง')
    }
    const activeLocations = await findActiveLocations()
    const nearest = nearestLocation(input.latitude, input.longitude, activeLocations)
    if (nearest === null || nearest.distanceMeters > nearest.location.radiusMeters) {
      const message =
        nearest === null
          ? 'ยังไม่มีการตั้งค่าพิกัดที่อนุญาตให้ลงเวลาในระบบ กรุณาติดต่อฝ่ายบุคคล'
          : `อยู่นอกพื้นที่ที่อนุญาตให้ลงเวลา (ห่างจาก "${nearest.location.locationName}" ประมาณ ${Math.round(nearest.distanceMeters)} ม. ขอบเขตที่อนุญาต ${nearest.location.radiusMeters} ม.)`
      return fail(res, 409, message)
    }
    const matched = { locationId: nearest.location.id, distanceMeters: nearest.distanceMeters }

    const employee = await findEmployeeById(employeeId)
    if (!employee) return fail(res, 404, 'employee record not found')

    const { rows } = await pool.query<AttendanceRow>(
      `WITH inserted AS (
         INSERT INTO attendance_events
           (employee_id, event_type, source, latitude, longitude, accuracy_meters, shift_id,
            device_info, matched_location_id, distance_meters)
         VALUES ($1, $2, 'liff_gps', $3, $4, $5, $6, $7, $8, $9)
         RETURNING id, employee_id, event_type, event_time, source,
                   latitude, longitude, accuracy_meters, shift_id, device_info,
                   matched_location_id, distance_meters
       )
       SELECT inserted.*, ms.shift_name, ml.location_name AS matched_location_name
       FROM inserted
       LEFT JOIN master_shifts ms ON ms.id = inserted.shift_id
       LEFT JOIN master_locations ml ON ml.id = inserted.matched_location_id`,
      [
        employeeId,
        input.eventType,
        input.latitude,
        input.longitude,
        input.accuracyMeters,
        employee.employment.shiftId,
        input.deviceInfo,
        matched?.locationId ?? null,
        matched?.distanceMeters ?? null,
      ]
    )
    const row = rows[0]
    if (!row) throw new Error('insert into attendance_events returned no row')

    const body: AttendanceClockResponse = { event: rowToAttendanceEvent(row) }
    res.status(201).json(body)
  } catch (err) {
    handleUnexpected(res, err)
  }
})

attendanceRouter.get('/attendance/me', async (req: Request, res: Response) => {
  const employeeId = requireEmployeeId(req, res)
  if (employeeId === null) return

  try {
    const lastEvent = await findLastAttendanceEvent(employeeId)
    const body: AttendanceStatusResponse = { lastEvent }
    res.json(body)
  } catch (err) {
    handleUnexpected(res, err)
  }
})

function parseOptionalId(value: unknown): number | null | undefined {
  if (value === undefined) return null
  if (typeof value !== 'string') return undefined
  const id = Number(value)
  return Number.isInteger(id) && id > 0 ? id : undefined
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function parseOptionalDate(value: unknown): string | null | undefined {
  if (value === undefined) return null
  if (typeof value !== 'string' || !DATE_RE.test(value)) return undefined
  return value
}

attendanceRouter.get('/attendance', canReadAdmin, async (req: Request, res: Response) => {
  const employeeId = parseOptionalId(req.query['employeeId'])
  if (employeeId === undefined) return fail(res, 400, 'employeeId must be a positive integer')

  const fromDate = parseOptionalDate(req.query['fromDate'])
  if (fromDate === undefined) return fail(res, 400, 'fromDate must be YYYY-MM-DD')

  const toDate = parseOptionalDate(req.query['toDate'])
  if (toDate === undefined) return fail(res, 400, 'toDate must be YYYY-MM-DD')

  try {
    const events = await listAttendanceEvents({
      ...(employeeId !== null && { employeeId }),
      ...(fromDate !== null && { fromDate }),
      ...(toDate !== null && { toDate }),
    })
    const body: AttendanceListResponse = { events }
    res.json(body)
  } catch (err) {
    handleUnexpected(res, err)
  }
})
