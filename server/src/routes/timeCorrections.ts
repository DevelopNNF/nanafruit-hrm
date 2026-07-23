import { Router } from 'express'
import type { Request, Response } from 'express'
import {
  ATTENDANCE_EVENT_TYPES,
  ROLES,
  TIME_CORRECTION_STATUSES,
  type AttendanceEventType,
  type AuthUser,
  type TimeCorrectionDetailResponse,
  type TimeCorrectionInput,
  type TimeCorrectionListResponse,
  type TimeCorrectionMineResponse,
  type TimeCorrectionRejectRequest,
  type TimeCorrectionResponse,
  type TimeCorrectionStatus,
} from '@hrm/shared'
import { pool, withTransaction } from '../db.js'
import { requireRole } from '../auth/middleware.js'
import { recordAudit } from '../audit.js'
import { fail, handleUnexpected } from '../http.js'
import { findEmployeeById } from '../employeeQueries.js'
import {
  findTimeCorrectionById,
  listTimeCorrections,
  listTimeCorrectionsForEmployee,
  rowToTimeCorrection,
  rowToTimeCorrectionListItem,
  type TimeCorrectionListRow,
  type TimeCorrectionRow,
} from '../timeCorrectionQueries.js'

export const timeCorrectionsRouter = Router()

// Same split as attendance: any HRM role may look at the review queue, only
// HR and Admin may decide it — matching employees/jobs/shifts' write level,
// not locations' Admin-only (a time correction isn't a security control the
// way a geofence radius is).
const canReadAdmin = requireRole(...ROLES)
const canDecide = requireRole('HRM.HR', 'HRM.Admin')

function actorOf(req: Request): AuthUser | null {
  return req.auth ?? null
}

/** POST /time-corrections and GET .../me are for the employee arm of AuthUser
 *  only — an admin token has no employeeId to submit a request as, same
 *  reasoning as attendance.ts's requireEmployeeId. */
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

function requiredString(source: Record<string, unknown>, key: string, maxLength: number): string | null {
  const value = source[key]
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed === '' || trimmed.length > maxLength) return null
  return trimmed
}

function parseTimeCorrectionInput(body: unknown): ParseResult<TimeCorrectionInput> {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, message: 'body must be a JSON object' }
  }
  const raw = body as Record<string, unknown>

  const eventType = raw['eventType']
  if (typeof eventType !== 'string' || !ATTENDANCE_EVENT_TYPES.includes(eventType as AttendanceEventType)) {
    return { ok: false, message: `eventType must be one of: ${ATTENDANCE_EVENT_TYPES.join(', ')}` }
  }

  const requestedEventTimeRaw = raw['requestedEventTime']
  if (typeof requestedEventTimeRaw !== 'string') {
    return { ok: false, message: 'requestedEventTime is required and must be an ISO 8601 string' }
  }
  const requestedEventTime = new Date(requestedEventTimeRaw)
  if (Number.isNaN(requestedEventTime.getTime())) {
    return { ok: false, message: 'requestedEventTime must be a valid ISO 8601 date' }
  }
  if (requestedEventTime.getTime() > Date.now()) {
    return { ok: false, message: 'ไม่สามารถขอแก้ไขเวลาที่ยังไม่เกิดขึ้นได้' }
  }

  const reason = requiredString(raw, 'reason', 1000)
  if (reason === null) return { ok: false, message: 'reason is required and must be 1000 characters or fewer' }

  return {
    ok: true,
    value: { eventType: eventType as AttendanceEventType, requestedEventTime: requestedEventTime.toISOString(), reason },
  }
}

function parseId(value: string | string[] | undefined): number | null {
  if (typeof value !== 'string') return null
  const id = Number(value)
  return Number.isInteger(id) && id > 0 ? id : null
}

function parseStatusFilter(value: string | string[] | undefined): ParseResult<TimeCorrectionStatus | undefined> {
  if (value === undefined) return { ok: true, value: undefined }
  if (typeof value !== 'string' || !TIME_CORRECTION_STATUSES.includes(value as TimeCorrectionStatus)) {
    return { ok: false, message: `status must be one of: ${TIME_CORRECTION_STATUSES.join(', ')}` }
  }
  return { ok: true, value: value as TimeCorrectionStatus }
}

timeCorrectionsRouter.post('/time-corrections', async (req: Request, res: Response) => {
  const employeeId = requireEmployeeId(req, res)
  if (employeeId === null) return

  const parsed = parseTimeCorrectionInput(req.body)
  if (!parsed.ok) return fail(res, 400, parsed.message)
  const input = parsed.value

  try {
    const request = await withTransaction(async (client) => {
      const { rows } = await client.query<TimeCorrectionRow>(
        `INSERT INTO time_correction_requests (employee_id, event_type, requested_event_time, reason)
         VALUES ($1, $2, $3, $4)
         RETURNING id, employee_id, event_type, requested_event_time, reason, status,
                   decided_by_name, decided_at, decision_reason, resulting_event_id, created_at`,
        [employeeId, input.eventType, input.requestedEventTime, input.reason]
      )
      const row = rows[0]
      if (!row) throw new Error('insert into time_correction_requests returned no row')

      await recordAudit(client, {
        actor: { kind: 'employee', employeeId },
        action: 'time_correction.create',
        entityId: Number(row.id),
        detail: { eventType: input.eventType, requestedEventTime: input.requestedEventTime },
      })

      return rowToTimeCorrection(row)
    })

    const body: TimeCorrectionResponse = { request }
    res.status(201).json(body)
  } catch (err) {
    handleUnexpected(res, err)
  }
})

timeCorrectionsRouter.get('/time-corrections/me', async (req: Request, res: Response) => {
  const employeeId = requireEmployeeId(req, res)
  if (employeeId === null) return

  try {
    const requests = await listTimeCorrectionsForEmployee(employeeId)
    const body: TimeCorrectionMineResponse = { requests }
    res.json(body)
  } catch (err) {
    handleUnexpected(res, err)
  }
})

timeCorrectionsRouter.get('/time-corrections', canReadAdmin, async (req: Request, res: Response) => {
  const statusResult = parseStatusFilter(req.query['status'] as string | string[] | undefined)
  if (!statusResult.ok) return fail(res, 400, statusResult.message)

  try {
    const requests = await listTimeCorrections({ status: statusResult.value })
    const body: TimeCorrectionListResponse = { requests }
    res.json(body)
  } catch (err) {
    handleUnexpected(res, err)
  }
})

timeCorrectionsRouter.get('/time-corrections/:id', canReadAdmin, async (req: Request, res: Response) => {
  const id = parseId(req.params['id'])
  if (id === null) return fail(res, 400, 'id must be a positive integer')

  try {
    const request = await findTimeCorrectionById(id)
    if (!request) return fail(res, 404, `no time correction request with id ${id}`)

    const body: TimeCorrectionDetailResponse = { request }
    res.json(body)
  } catch (err) {
    handleUnexpected(res, err)
  }
})

/** The neighboring attendance_events row on one side of a point in time, for
 *  the alternation check below — same "most recent" shape as
 *  findLastAttendanceEvent, but bounded and directional instead of just DESC. */
async function neighborEvent(
  client: { query: typeof pool.query },
  employeeId: number,
  eventTime: Date,
  direction: 'before' | 'after'
): Promise<AttendanceEventType | null> {
  const operator = direction === 'before' ? '<' : '>'
  const order = direction === 'before' ? 'DESC' : 'ASC'
  const { rows } = await client.query<{ event_type: string }>(
    `SELECT event_type FROM attendance_events
     WHERE employee_id = $1 AND event_time ${operator} $2
     ORDER BY event_time ${order} LIMIT 1`,
    [employeeId, eventTime.toISOString()]
  )
  const row = rows[0]
  return row ? (row.event_type as AttendanceEventType) : null
}

timeCorrectionsRouter.post('/time-corrections/:id/approve', canDecide, async (req: Request, res: Response) => {
  const actor = actorOf(req)
  if (!actor || actor.kind !== 'admin') return fail(res, 500, 'server misconfigured')

  const id = parseId(req.params['id'])
  if (id === null) return fail(res, 400, 'id must be a positive integer')

  try {
    const result = await withTransaction(async (client) => {
      const { rows } = await client.query<TimeCorrectionRow>(
        `SELECT id, employee_id, event_type, requested_event_time, reason, status,
                decided_by_name, decided_at, decision_reason, resulting_event_id, created_at
         FROM time_correction_requests WHERE id = $1 FOR UPDATE`,
        [id]
      )
      const row = rows[0]
      if (!row) return { kind: 'not_found' as const }
      if (row.status !== 'pending') return { kind: 'conflict' as const, message: 'คำขอนี้ถูกดำเนินการไปแล้ว' }

      const employeeId = Number(row.employee_id)
      const eventType = row.event_type as AttendanceEventType
      const eventTime = new Date(row.requested_event_time)

      const [prev, next] = await Promise.all([
        neighborEvent(client, employeeId, eventTime, 'before'),
        neighborEvent(client, employeeId, eventTime, 'after'),
      ])

      if (prev === null && eventType === 'check_out') {
        return { kind: 'conflict' as const, message: 'ไม่มีการลงเวลาเข้างานก่อนเวลานี้ ไม่สามารถลงเวลาออกงานได้' }
      }
      if (prev !== null && prev === eventType) {
        return {
          kind: 'conflict' as const,
          message: 'เวลานี้จะทำให้มีการลงเวลาประเภทเดียวกันติดกันกับรายการก่อนหน้า กรุณาตรวจสอบเวลาที่ขอแก้ไข',
        }
      }
      if (next !== null && next === eventType) {
        return {
          kind: 'conflict' as const,
          message: 'เวลานี้จะทำให้มีการลงเวลาประเภทเดียวกันติดกันกับรายการถัดไป กรุณาตรวจสอบเวลาที่ขอแก้ไข',
        }
      }

      const employee = await findEmployeeById(employeeId, client)
      if (!employee) return { kind: 'conflict' as const, message: 'ไม่พบข้อมูลพนักงานของคำขอนี้' }

      const { rows: insertedRows } = await client.query<{ id: string }>(
        `INSERT INTO attendance_events (employee_id, event_type, event_time, source, shift_id)
         VALUES ($1, $2, $3, 'admin_correction', $4)
         RETURNING id`,
        [employeeId, eventType, row.requested_event_time, employee.employment.shiftId]
      )
      const resultingEventId = Number(insertedRows[0]?.id)
      if (!resultingEventId) throw new Error('insert into attendance_events returned no id')

      const { rows: updatedRows } = await client.query<TimeCorrectionListRow>(
        `WITH updated AS (
           UPDATE time_correction_requests
           SET status = 'approved', decided_by_oid = $2, decided_by_name = $3,
               decided_at = now(), resulting_event_id = $4, updated_at = now()
           WHERE id = $1
           RETURNING id, employee_id, event_type, requested_event_time, reason, status,
                     decided_by_name, decided_at, decision_reason, resulting_event_id, created_at
         )
         SELECT updated.*, e.employee_code,
                (e.title || e.first_name_th || ' ' || e.last_name_th) AS employee_name
         FROM updated JOIN employees e ON e.id = updated.employee_id`,
        [id, actor.oid, actor.name, resultingEventId]
      )
      const updated = updatedRows[0]
      if (!updated) throw new Error('update time_correction_requests returned no row')

      await recordAudit(client, {
        actor,
        action: 'time_correction.approve',
        entityId: id,
        detail: { resultingEventId, eventType, requestedEventTime: row.requested_event_time },
      })

      return { kind: 'ok' as const, request: rowToTimeCorrectionListItem(updated) }
    })

    if (result.kind === 'not_found') return fail(res, 404, `no time correction request with id ${id}`)
    if (result.kind === 'conflict') return fail(res, 409, result.message)

    const body: TimeCorrectionDetailResponse = { request: result.request }
    res.json(body)
  } catch (err) {
    handleUnexpected(res, err)
  }
})

timeCorrectionsRouter.post('/time-corrections/:id/reject', canDecide, async (req: Request, res: Response) => {
  const actor = actorOf(req)
  if (!actor || actor.kind !== 'admin') return fail(res, 500, 'server misconfigured')

  const id = parseId(req.params['id'])
  if (id === null) return fail(res, 400, 'id must be a positive integer')

  const body = req.body as Partial<TimeCorrectionRejectRequest> | null
  const reason = requiredString((body ?? {}) as Record<string, unknown>, 'reason', 1000)
  if (reason === null) return fail(res, 400, 'reason is required and must be 1000 characters or fewer')

  try {
    const result = await withTransaction(async (client) => {
      const { rows } = await client.query<{ status: string }>(
        `SELECT status FROM time_correction_requests WHERE id = $1 FOR UPDATE`,
        [id]
      )
      const row = rows[0]
      if (!row) return { kind: 'not_found' as const }
      if (row.status !== 'pending') return { kind: 'conflict' as const }

      const { rows: updatedRows } = await client.query<TimeCorrectionListRow>(
        `WITH updated AS (
           UPDATE time_correction_requests
           SET status = 'rejected', decided_by_oid = $2, decided_by_name = $3,
               decided_at = now(), decision_reason = $4, updated_at = now()
           WHERE id = $1
           RETURNING id, employee_id, event_type, requested_event_time, reason, status,
                     decided_by_name, decided_at, decision_reason, resulting_event_id, created_at
         )
         SELECT updated.*, e.employee_code,
                (e.title || e.first_name_th || ' ' || e.last_name_th) AS employee_name
         FROM updated JOIN employees e ON e.id = updated.employee_id`,
        [id, actor.oid, actor.name, reason]
      )
      const updated = updatedRows[0]
      if (!updated) throw new Error('update time_correction_requests returned no row')

      await recordAudit(client, {
        actor,
        action: 'time_correction.reject',
        entityId: id,
        detail: { reason },
      })

      return { kind: 'ok' as const, request: rowToTimeCorrectionListItem(updated) }
    })

    if (result.kind === 'not_found') return fail(res, 404, `no time correction request with id ${id}`)
    if (result.kind === 'conflict') return fail(res, 409, 'คำขอนี้ถูกดำเนินการไปแล้ว')

    const body2: TimeCorrectionDetailResponse = { request: result.request }
    res.json(body2)
  } catch (err) {
    handleUnexpected(res, err)
  }
})
