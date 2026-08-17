import { Router } from 'express'
import type { Request, Response } from 'express'
import {
  OVERTIME_BACKDATE_LIMIT_DAYS,
  OVERTIME_MAX_MINUTES,
  OVERTIME_MIN_MINUTES,
  OVERTIME_REQUEST_STATUSES,
  ROLES,
  computeOvertimeMinutes,
  findOvertimeShiftConflict,
  parseWallClockMinutes,
  type AuthUser,
  type CalendarDay,
  type OvertimeRequestDetailResponse,
  type OvertimeRequestInput,
  type OvertimeRequestListResponse,
  type OvertimeRequestMineResponse,
  type OvertimeRequestRejectRequest,
  type OvertimeRequestResponse,
  type OvertimeRequestStatus,
} from '@hrm/shared'
import type pg from 'pg'
import { pool, withTransaction } from '../db.js'
import { requireRole } from '../auth/middleware.js'
import { recordAudit } from '../audit.js'
import { fail, handleUnexpected } from '../http.js'
import { findEmployeeById } from '../employeeQueries.js'
import { addDays, toThailandDateString } from '../shiftAssignmentQueries.js'
import { buildCalendarDaysForDates } from '../calendarQueries.js'
import {
  SELECT_OVERTIME_REQUEST,
  findOvertimeRequestById,
  hasOverlappingOvertimeRequest,
  listOvertimeRequests,
  listOvertimeRequestsForEmployee,
  rowToOvertimeRequest,
  type OvertimeRequestRow,
} from '../overtimeRequestQueries.js'

export const overtimeRequestsRouter = Router()

type Queryable = Pick<pg.Pool, 'query'>

// Same split as the other request queues: any HRM role may look at it, only
// HR and Admin may decide it.
const canReadAdmin = requireRole(...ROLES)
const canDecide = requireRole('HRM.HR', 'HRM.Admin')

function actorOf(req: Request): AuthUser | null {
  return req.auth ?? null
}

/** POST /overtime-requests and its /me, /:id, /:id/cancel siblings are for
 *  the employee arm of AuthUser only — an admin token has no employeeId to
 *  submit, edit or cancel a request as, same reasoning as
 *  dayOffSwapRequests.ts. */
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

function parseId(value: string | string[] | undefined): number | null {
  if (typeof value !== 'string') return null
  const id = Number(value)
  return Number.isInteger(id) && id > 0 ? id : null
}

function requiredString(
  source: Record<string, unknown>,
  key: string,
  maxLength: number
): string | null {
  const value = source[key]
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed === '' || trimmed.length > maxLength) return null
  return trimmed
}

function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [year, month, day] = value.split('-').map(Number) as [number, number, number]
  const date = new Date(Date.UTC(year, month - 1, day))
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  )
}

/** 'HH:MM' or 'HH:MM:SS' from the client, normalised to the 'HH:MM:SS' a
 *  `time` column round-trips as, so an edit that changes nothing does not
 *  look like a change. */
function normaliseTime(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const minutes = parseWallClockMinutes(value)
  if (minutes === null) return null
  const hh = String(Math.floor(minutes / 60)).padStart(2, '0')
  const mm = String(minutes % 60).padStart(2, '0')
  return `${hh}:${mm}:00`
}

function parseOvertimeRequestInput(body: unknown): ParseResult<OvertimeRequestInput> {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, message: 'body must be a JSON object' }
  }
  const raw = body as Record<string, unknown>

  const otDateRaw = raw['otDate']
  if (typeof otDateRaw !== 'string' || !isCalendarDate(otDateRaw)) {
    return { ok: false, message: 'otDate is required and must be a date as YYYY-MM-DD' }
  }

  const startTime = normaliseTime(raw['startTime'])
  if (startTime === null) {
    return { ok: false, message: 'startTime is required and must be a time as HH:MM' }
  }

  const endTime = normaliseTime(raw['endTime'])
  if (endTime === null) {
    return { ok: false, message: 'endTime is required and must be a time as HH:MM' }
  }

  const reason = requiredString(raw, 'reason', 1000)
  if (reason === null) {
    return { ok: false, message: 'reason is required and must be 1000 characters or fewer' }
  }

  return { ok: true, value: { otDate: otDateRaw, startTime, endTime, reason } }
}

function parseStatusFilter(
  value: string | string[] | undefined
): ParseResult<OvertimeRequestStatus | undefined> {
  if (value === undefined) return { ok: true, value: undefined }
  if (
    typeof value !== 'string' ||
    !OVERTIME_REQUEST_STATUSES.includes(value as OvertimeRequestStatus)
  ) {
    return { ok: false, message: `status must be one of: ${OVERTIME_REQUEST_STATUSES.join(', ')}` }
  }
  return { ok: true, value: value as OvertimeRequestStatus }
}

function hhmm(time: string): string {
  return time.slice(0, 5)
}

function formatThaiDate(dateStr: string): string {
  return new Date(`${dateStr}T00:00:00Z`).toLocaleDateString('th-TH', {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'short',
  })
}

/** Everything the request row freezes at submission time. See the migration's
 *  comment for why these are snapshots rather than joins. */
type OvertimeSnapshot = {
  requestedMinutes: number
  dayStatus: CalendarDay['status']
  dayLabel: string | null
  shiftId: number | null
  shiftStartTime: string | null
  shiftEndTime: string | null
  overtimeGroupId: number
}

type ValidationOutcome =
  | { kind: 'ok'; snapshot: OvertimeSnapshot }
  | { kind: 'employee-not-found' }
  | { kind: 'no-overtime-group' }
  | { kind: 'too-short' }
  | { kind: 'too-long' }
  | { kind: 'backdated' }
  | { kind: 'before-hire' }
  | { kind: 'on-leave' }
  | { kind: 'shift-conflict'; day: CalendarDay }
  | { kind: 'overlap' }

/**
 * Structural + reference validation shared by create and edit. Returns the
 * snapshot to store on success and a reason otherwise, rather than calling
 * fail() itself, so both call sites can label the response the same way —
 * same shape as validateShiftChangeRequestInput.
 *
 * The calendar is read for otDate AND both its neighbours because the
 * shift-overlap rule spans days in both directions: a 22:00-06:00 shift
 * belonging to yesterday occupies this morning, and a request that crosses
 * midnight runs into tomorrow's shift. buildCalendarDaysForDates is the same
 * classification cascade the monthly calendar and day-off swaps use, so a
 * date can never classify one way here and another way there.
 */
async function validateOvertimeRequestInput(
  employeeId: number,
  input: OvertimeRequestInput,
  excludeId: number | null,
  db: Queryable = pool
): Promise<ValidationOutcome> {
  const employee = await findEmployeeById(employeeId, db)
  if (!employee) return { kind: 'employee-not-found' }

  const overtimeGroupId = employee.employment.overtimeGroupId
  if (overtimeGroupId === null) return { kind: 'no-overtime-group' }

  const requestedMinutes = computeOvertimeMinutes(input.startTime, input.endTime)
  if (requestedMinutes === null || requestedMinutes < OVERTIME_MIN_MINUTES) {
    return { kind: 'too-short' }
  }
  if (requestedMinutes > OVERTIME_MAX_MINUTES) return { kind: 'too-long' }

  const today = toThailandDateString(new Date())
  if (input.otDate < addDays(today, -OVERTIME_BACKDATE_LIMIT_DAYS)) return { kind: 'backdated' }
  if (input.otDate < employee.employment.hireDate) return { kind: 'before-hire' }

  const days = await buildCalendarDaysForDates(
    employeeId,
    [addDays(input.otDate, -1), input.otDate, addDays(input.otDate, 1)],
    db
  )
  const day = days.find((d) => d.date === input.otDate)
  if (!day) throw new Error(`calendar returned no day for ${input.otDate}`)

  // Working overtime on a day already approved as leave is a contradiction:
  // one of the two records is wrong, and this is the cheaper one to stop.
  if (day.status === 'leave') return { kind: 'on-leave' }

  const conflict = findOvertimeShiftConflict(input.otDate, input.startTime, input.endTime, days)
  if (conflict) return { kind: 'shift-conflict', day: conflict }

  const overlapping = await hasOverlappingOvertimeRequest(
    employeeId,
    input.otDate,
    input.startTime,
    input.endTime,
    excludeId,
    db
  )
  if (overlapping) return { kind: 'overlap' }

  return {
    kind: 'ok',
    snapshot: {
      requestedMinutes,
      dayStatus: day.status,
      dayLabel: day.label,
      shiftId: day.shiftId,
      shiftStartTime: day.shiftStartTime,
      shiftEndTime: day.shiftEndTime,
      overtimeGroupId,
    },
  }
}

function validationFail(res: Response, outcome: Exclude<ValidationOutcome, { kind: 'ok' }>): void {
  if (outcome.kind === 'employee-not-found') return fail(res, 404, 'employee not found')
  if (outcome.kind === 'no-overtime-group') {
    return fail(
      res,
      400,
      'ยังไม่ได้กำหนดกลุ่มการทำงานล่วงเวลาให้พนักงานคนนี้ จึงยังคำนวณค่า OT ไม่ได้ กรุณาติดต่อ HR'
    )
  }
  if (outcome.kind === 'too-short') {
    return fail(res, 400, `ช่วงเวลาที่ขอต้องยาวอย่างน้อย ${OVERTIME_MIN_MINUTES} นาที`)
  }
  if (outcome.kind === 'too-long') {
    return fail(
      res,
      400,
      `ช่วงเวลาที่ขอต้องไม่เกิน ${OVERTIME_MAX_MINUTES / 60} ชั่วโมงต่อหนึ่งคำขอ กรุณาตรวจสอบเวลาเริ่มและเวลาสิ้นสุดอีกครั้ง`
    )
  }
  if (outcome.kind === 'backdated') {
    return fail(
      res,
      400,
      `ขอ OT ย้อนหลังได้ไม่เกิน ${OVERTIME_BACKDATE_LIMIT_DAYS} วัน หากเลยกำหนดแล้วกรุณาติดต่อ HR`
    )
  }
  if (outcome.kind === 'before-hire') return fail(res, 400, 'otDate ต้องไม่ก่อนวันที่เริ่มงาน')
  if (outcome.kind === 'on-leave') {
    return fail(res, 400, 'วันที่เลือกเป็นวันลาที่อนุมัติแล้ว ไม่สามารถขอ OT ได้')
  }
  if (outcome.kind === 'shift-conflict') {
    const { day } = outcome
    return fail(
      res,
      400,
      `ช่วงเวลาที่ขอทับกับเวลาทำงานปกติ (${day.shiftName ?? 'กะ'} ${hhmm(day.shiftStartTime ?? '')}-${hhmm(day.shiftEndTime ?? '')} ของวันที่ ${formatThaiDate(day.date)}) กรุณาเลือกช่วงเวลานอกเวลาทำงาน`
    )
  }
  if (outcome.kind === 'overlap') {
    return fail(res, 409, 'ช่วงเวลาที่ขอทับกับคำขอ OT อื่นที่ยังรออนุมัติหรืออนุมัติแล้ว')
  }
}

/**
 * The same outcomes, worded for the admin reviewing the queue rather than the
 * employee filling the form. A request that was valid when it was filed and
 * is not any more is not the reviewer's mistake to correct — there is no way
 * to approve it into a consistent state, so each of these says so and points
 * at rejection, which is the only decision still available.
 */
function approvalStaleFail(res: Response, outcome: Exclude<ValidationOutcome, { kind: 'ok' }>): void {
  if (outcome.kind === 'backdated') {
    return fail(
      res,
      409,
      `คำขอนี้ย้อนหลังเกิน ${OVERTIME_BACKDATE_LIMIT_DAYS} วันไปแล้ว ไม่สามารถอนุมัติได้ กรุณาปฏิเสธคำขอนี้`
    )
  }
  if (outcome.kind === 'shift-conflict') {
    const { day } = outcome
    return fail(
      res,
      409,
      `กะของพนักงานเปลี่ยนไปหลังจากยื่นคำขอ ช่วงเวลาที่ขอทับกับเวลาทำงานปกติแล้ว (${day.shiftName ?? 'กะ'} ${hhmm(day.shiftStartTime ?? '')}-${hhmm(day.shiftEndTime ?? '')} ของวันที่ ${formatThaiDate(day.date)}) กรุณาปฏิเสธคำขอนี้`
    )
  }
  if (outcome.kind === 'overlap') {
    return fail(
      res,
      409,
      'ช่วงเวลานี้ทับกับคำขอ OT อื่นที่อนุมัติไปแล้ว ไม่สามารถอนุมัติซ้ำได้ กรุณาปฏิเสธคำขอนี้'
    )
  }
  if (outcome.kind === 'on-leave') {
    return fail(
      res,
      409,
      'วันที่ขอ OT กลายเป็นวันลาที่อนุมัติแล้ว ไม่สามารถอนุมัติได้ กรุณาปฏิเสธคำขอนี้'
    )
  }
  if (outcome.kind === 'no-overtime-group') {
    return fail(
      res,
      409,
      'พนักงานคนนี้ยังไม่ได้ถูกกำหนดกลุ่มการทำงานล่วงเวลา จึงยังคำนวณค่า OT ไม่ได้ กรุณากำหนดกลุ่มในหน้าข้อมูลพนักงานก่อน'
    )
  }
  // Everything else (length bounds, hire date, missing employee) was already
  // true at submission and cannot become true afterwards; if one shows up
  // here the employee-facing wording is still accurate.
  return validationFail(res, outcome)
}

overtimeRequestsRouter.post('/overtime-requests', async (req: Request, res: Response) => {
  const employeeId = requireEmployeeId(req, res)
  if (employeeId === null) return

  const parsed = parseOvertimeRequestInput(req.body)
  if (!parsed.ok) return fail(res, 400, parsed.message)
  const input = parsed.value

  try {
    const outcome = await validateOvertimeRequestInput(employeeId, input, null)
    if (outcome.kind !== 'ok') return validationFail(res, outcome)
    const snapshot = outcome.snapshot

    const request = await withTransaction(async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO overtime_requests
           (employee_id, ot_date, start_time, end_time, requested_minutes,
            day_status, day_label, shift_id, shift_start_time, shift_end_time,
            overtime_group_id, reason)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING id`,
        [
          employeeId,
          input.otDate,
          input.startTime,
          input.endTime,
          snapshot.requestedMinutes,
          snapshot.dayStatus,
          snapshot.dayLabel,
          snapshot.shiftId,
          snapshot.shiftStartTime,
          snapshot.shiftEndTime,
          snapshot.overtimeGroupId,
          input.reason,
        ]
      )
      const created = rows[0]
      if (!created) throw new Error('insert into overtime_requests returned no row')

      await recordAudit(client, {
        actor: { kind: 'employee', employeeId },
        action: 'overtime_request.create',
        entityId: Number(created.id),
        detail: {
          otDate: input.otDate,
          startTime: input.startTime,
          endTime: input.endTime,
          requestedMinutes: snapshot.requestedMinutes,
        },
      })

      const { rows: selectRows } = await client.query<OvertimeRequestRow>(
        `${SELECT_OVERTIME_REQUEST} WHERE otr.id = $1`,
        [created.id]
      )
      const row = selectRows[0]
      if (!row) throw new Error('re-select of overtime_requests returned no row')
      return rowToOvertimeRequest(row)
    })

    const body: OvertimeRequestResponse = { request }
    res.status(201).json(body)
  } catch (err) {
    handleUnexpected(res, err)
  }
})

overtimeRequestsRouter.get('/overtime-requests/me', async (req: Request, res: Response) => {
  const employeeId = requireEmployeeId(req, res)
  if (employeeId === null) return

  try {
    const requests = await listOvertimeRequestsForEmployee(employeeId)
    const body: OvertimeRequestMineResponse = { requests }
    res.json(body)
  } catch (err) {
    handleUnexpected(res, err)
  }
})

// Editable only while pending — replaces the whole request rather than
// patching one field, same body shape as creation. The snapshots are taken
// again too: an edit that moves the date to a holiday must not keep the
// workday classification the original date had.
overtimeRequestsRouter.put('/overtime-requests/:id', async (req: Request, res: Response) => {
  const employeeId = requireEmployeeId(req, res)
  if (employeeId === null) return

  const id = parseId(req.params['id'])
  if (id === null) return fail(res, 400, 'id must be a positive integer')

  const parsed = parseOvertimeRequestInput(req.body)
  if (!parsed.ok) return fail(res, 400, parsed.message)
  const input = parsed.value

  try {
    const outcome = await validateOvertimeRequestInput(employeeId, input, id)
    if (outcome.kind !== 'ok') return validationFail(res, outcome)
    const snapshot = outcome.snapshot

    const result = await withTransaction(async (client) => {
      const { rows } = await client.query<{ employee_id: string; status: string }>(
        `SELECT employee_id, status FROM overtime_requests WHERE id = $1 FOR UPDATE`,
        [id]
      )
      const row = rows[0]
      if (!row) return { kind: 'not_found' as const }
      if (Number(row.employee_id) !== employeeId) return { kind: 'not_found' as const }
      if (row.status !== 'pending') return { kind: 'conflict' as const }

      await client.query(
        `UPDATE overtime_requests
         SET ot_date = $2, start_time = $3, end_time = $4, requested_minutes = $5,
             day_status = $6, day_label = $7, shift_id = $8,
             shift_start_time = $9, shift_end_time = $10,
             overtime_group_id = $11, reason = $12, updated_at = now()
         WHERE id = $1`,
        [
          id,
          input.otDate,
          input.startTime,
          input.endTime,
          snapshot.requestedMinutes,
          snapshot.dayStatus,
          snapshot.dayLabel,
          snapshot.shiftId,
          snapshot.shiftStartTime,
          snapshot.shiftEndTime,
          snapshot.overtimeGroupId,
          input.reason,
        ]
      )

      await recordAudit(client, {
        actor: { kind: 'employee', employeeId },
        action: 'overtime_request.update',
        entityId: id,
        detail: {
          otDate: input.otDate,
          startTime: input.startTime,
          endTime: input.endTime,
          requestedMinutes: snapshot.requestedMinutes,
        },
      })

      const { rows: selectRows } = await client.query<OvertimeRequestRow>(
        `${SELECT_OVERTIME_REQUEST} WHERE otr.id = $1`,
        [id]
      )
      const updated = selectRows[0]
      if (!updated) throw new Error('re-select of overtime_requests returned no row')
      return { kind: 'ok' as const, request: rowToOvertimeRequest(updated) }
    })

    if (result.kind === 'not_found') return fail(res, 404, `no overtime request with id ${id}`)
    if (result.kind === 'conflict') {
      return fail(res, 409, 'คำขอนี้ถูกดำเนินการไปแล้ว ไม่สามารถแก้ไขได้')
    }

    const body: OvertimeRequestResponse = { request: result.request }
    res.json(body)
  } catch (err) {
    handleUnexpected(res, err)
  }
})

overtimeRequestsRouter.post('/overtime-requests/:id/cancel', async (req: Request, res: Response) => {
  const employeeId = requireEmployeeId(req, res)
  if (employeeId === null) return

  const id = parseId(req.params['id'])
  if (id === null) return fail(res, 400, 'id must be a positive integer')

  try {
    const result = await withTransaction(async (client) => {
      const { rows } = await client.query<{ employee_id: string; status: string }>(
        `SELECT employee_id, status FROM overtime_requests WHERE id = $1 FOR UPDATE`,
        [id]
      )
      const row = rows[0]
      if (!row) return { kind: 'not_found' as const }
      if (Number(row.employee_id) !== employeeId) return { kind: 'not_found' as const }
      if (row.status !== 'pending') return { kind: 'conflict' as const }

      await client.query(
        `UPDATE overtime_requests SET status = 'cancelled', updated_at = now() WHERE id = $1`,
        [id]
      )

      await recordAudit(client, {
        actor: { kind: 'employee', employeeId },
        action: 'overtime_request.cancel',
        entityId: id,
        detail: {},
      })

      const { rows: selectRows } = await client.query<OvertimeRequestRow>(
        `${SELECT_OVERTIME_REQUEST} WHERE otr.id = $1`,
        [id]
      )
      const updated = selectRows[0]
      if (!updated) throw new Error('re-select of overtime_requests returned no row')
      return { kind: 'ok' as const, request: rowToOvertimeRequest(updated) }
    })

    if (result.kind === 'not_found') return fail(res, 404, `no overtime request with id ${id}`)
    if (result.kind === 'conflict') {
      return fail(res, 409, 'คำขอนี้ถูกดำเนินการไปแล้ว ไม่สามารถยกเลิกได้')
    }

    const body: OvertimeRequestResponse = { request: result.request }
    res.json(body)
  } catch (err) {
    handleUnexpected(res, err)
  }
})

overtimeRequestsRouter.get(
  '/overtime-requests',
  canReadAdmin,
  async (req: Request, res: Response) => {
    const statusResult = parseStatusFilter(req.query['status'] as string | string[] | undefined)
    if (!statusResult.ok) return fail(res, 400, statusResult.message)

    try {
      const requests = await listOvertimeRequests({ status: statusResult.value })
      const body: OvertimeRequestListResponse = { requests }
      res.json(body)
    } catch (err) {
      handleUnexpected(res, err)
    }
  }
)

overtimeRequestsRouter.get(
  '/overtime-requests/:id',
  canReadAdmin,
  async (req: Request, res: Response) => {
    const id = parseId(req.params['id'])
    if (id === null) return fail(res, 400, 'id must be a positive integer')

    try {
      const request = await findOvertimeRequestById(id)
      if (!request) return fail(res, 404, `no overtime request with id ${id}`)

      const body: OvertimeRequestDetailResponse = { request }
      res.json(body)
    } catch (err) {
      handleUnexpected(res, err)
    }
  }
)

overtimeRequestsRouter.post(
  '/overtime-requests/:id/approve',
  canDecide,
  async (req: Request, res: Response) => {
    const actor = actorOf(req)
    if (!actor || actor.kind !== 'admin') return fail(res, 500, 'server misconfigured')

    const id = parseId(req.params['id'])
    if (id === null) return fail(res, 400, 'id must be a positive integer')

    try {
      const result = await withTransaction(async (client) => {
        const { rows } = await client.query<{
          employee_id: string
          ot_date: string
          start_time: string
          end_time: string
          reason: string
          status: string
        }>(
          `SELECT employee_id, ot_date, start_time, end_time, reason, status
           FROM overtime_requests WHERE id = $1 FOR UPDATE`,
          [id]
        )
        const row = rows[0]
        if (!row) return { kind: 'not_found' as const }
        if (row.status !== 'pending') {
          return { kind: 'conflict' as const, message: 'คำขอนี้ถูกดำเนินการไปแล้ว' }
        }

        // Re-validated here, not just at submission: a request can sit pending
        // long enough to fall out of the backdating window, and in the
        // meantime an approved shift change can have moved the employee's
        // shift onto the hours this request claims. Both are checked against
        // live data — the row's own snapshot is what was true when it was
        // filed, which is exactly the thing in question.
        const outcome = await validateOvertimeRequestInput(
          Number(row.employee_id),
          {
            otDate: row.ot_date,
            startTime: row.start_time,
            endTime: row.end_time,
            reason: row.reason,
          },
          id,
          client
        )
        if (outcome.kind !== 'ok') return { kind: 'stale' as const, outcome }

        await client.query(
          `UPDATE overtime_requests
           SET status = 'approved', decided_by_oid = $2, decided_by_name = $3,
               decided_at = now(), updated_at = now()
           WHERE id = $1`,
          [id, actor.oid, actor.name]
        )

        await recordAudit(client, {
          actor,
          action: 'overtime_request.approve',
          entityId: id,
          detail: {
            employeeId: Number(row.employee_id),
            otDate: row.ot_date,
            startTime: row.start_time,
            endTime: row.end_time,
          },
        })

        const request = await findOvertimeRequestById(id, client)
        if (!request) throw new Error('re-select of overtime_requests returned no row')
        return { kind: 'ok' as const, request }
      })

      if (result.kind === 'not_found') return fail(res, 404, `no overtime request with id ${id}`)
      if (result.kind === 'conflict') return fail(res, 409, result.message)
      if (result.kind === 'stale') return approvalStaleFail(res, result.outcome)

      const body: OvertimeRequestDetailResponse = { request: result.request }
      res.json(body)
    } catch (err) {
      handleUnexpected(res, err)
    }
  }
)

overtimeRequestsRouter.post(
  '/overtime-requests/:id/reject',
  canDecide,
  async (req: Request, res: Response) => {
    const actor = actorOf(req)
    if (!actor || actor.kind !== 'admin') return fail(res, 500, 'server misconfigured')

    const id = parseId(req.params['id'])
    if (id === null) return fail(res, 400, 'id must be a positive integer')

    const body = req.body as Partial<OvertimeRequestRejectRequest> | null
    const reason = requiredString((body ?? {}) as Record<string, unknown>, 'reason', 1000)
    if (reason === null) {
      return fail(res, 400, 'reason is required and must be 1000 characters or fewer')
    }

    try {
      const result = await withTransaction(async (client) => {
        const { rows } = await client.query<{ status: string }>(
          `SELECT status FROM overtime_requests WHERE id = $1 FOR UPDATE`,
          [id]
        )
        const row = rows[0]
        if (!row) return { kind: 'not_found' as const }
        if (row.status !== 'pending') return { kind: 'conflict' as const }

        await client.query(
          `UPDATE overtime_requests
           SET status = 'rejected', decided_by_oid = $2, decided_by_name = $3,
               decided_at = now(), decision_reason = $4, updated_at = now()
           WHERE id = $1`,
          [id, actor.oid, actor.name, reason]
        )

        await recordAudit(client, {
          actor,
          action: 'overtime_request.reject',
          entityId: id,
          detail: { reason },
        })

        const request = await findOvertimeRequestById(id, client)
        if (!request) throw new Error('re-select of overtime_requests returned no row')
        return { kind: 'ok' as const, request }
      })

      if (result.kind === 'not_found') return fail(res, 404, `no overtime request with id ${id}`)
      if (result.kind === 'conflict') return fail(res, 409, 'คำขอนี้ถูกดำเนินการไปแล้ว')

      const responseBody: OvertimeRequestDetailResponse = { request: result.request }
      res.json(responseBody)
    } catch (err) {
      handleUnexpected(res, err)
    }
  }
)
