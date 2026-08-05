import { Router } from 'express'
import type { Request, Response } from 'express'
import {
  ROLES,
  DAY_OFF_SWAP_REQUEST_STATUSES,
  type AuthUser,
  type DayOffSwapRequestDetailResponse,
  type DayOffSwapRequestInput,
  type DayOffSwapRequestListResponse,
  type DayOffSwapRequestMineResponse,
  type DayOffSwapRequestRejectRequest,
  type DayOffSwapRequestResponse,
  type DayOffSwapRequestStatus,
} from '@hrm/shared'
import { withTransaction } from '../db.js'
import { requireRole } from '../auth/middleware.js'
import { recordAudit } from '../audit.js'
import { fail, handleUnexpected } from '../http.js'
import { findEmployeeById } from '../employeeQueries.js'
import { getShiftIdForDate, toThailandDateString } from '../shiftAssignmentQueries.js'
import { buildCalendarDaysForDates } from '../calendarQueries.js'
import {
  SELECT_DAY_OFF_SWAP_REQUEST,
  findDayOffSwapRequestById,
  hasConflictingDayOffSwapRequest,
  listDayOffSwapRequests,
  listDayOffSwapRequestsForEmployee,
  rowToDayOffSwapRequest,
  type DayOffSwapRequestRow,
} from '../dayOffSwapRequestQueries.js'
import { hasConflictingShiftChangeRequest } from '../shiftChangeRequestQueries.js'

export const dayOffSwapRequestsRouter = Router()

// Same split as shift-change/leave requests: any HRM role may look at the
// review queue, only HR and Admin may decide it.
const canReadAdmin = requireRole(...ROLES)
const canDecide = requireRole('HRM.HR', 'HRM.Admin')

function actorOf(req: Request): AuthUser | null {
  return req.auth ?? null
}

/** POST /day-off-swap-requests and its /me, /:id, /:id/cancel siblings are
 *  for the employee arm of AuthUser only — an admin token has no employeeId
 *  to submit, edit or cancel a request as, same reasoning as
 *  shiftChangeRequests.ts. */
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

function parseId(value: string | string[] | undefined): number | null {
  if (typeof value !== 'string') return null
  const id = Number(value)
  return Number.isInteger(id) && id > 0 ? id : null
}

function requiredString(source: Record<string, unknown>, key: string, maxLength: number): string | null {
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

function addDays(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

type ParseResult<T> = { ok: true; value: T } | { ok: false; message: string }

function parseDayOffSwapRequestInput(body: unknown): ParseResult<DayOffSwapRequestInput> {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, message: 'body must be a JSON object' }
  }
  const raw = body as Record<string, unknown>

  const workDateRaw = raw['workDate']
  if (typeof workDateRaw !== 'string' || !isCalendarDate(workDateRaw)) {
    return { ok: false, message: 'workDate is required and must be a date as YYYY-MM-DD' }
  }

  const offDateRaw = raw['offDate']
  if (typeof offDateRaw !== 'string' || !isCalendarDate(offDateRaw)) {
    return { ok: false, message: 'offDate is required and must be a date as YYYY-MM-DD' }
  }

  const reason = requiredString(raw, 'reason', 1000)
  if (reason === null) return { ok: false, message: 'reason is required and must be 1000 characters or fewer' }

  return { ok: true, value: { workDate: workDateRaw, offDate: offDateRaw, reason } }
}

function parseStatusFilter(
  value: string | string[] | undefined
): ParseResult<DayOffSwapRequestStatus | undefined> {
  if (value === undefined) return { ok: true, value: undefined }
  if (typeof value !== 'string' || !DAY_OFF_SWAP_REQUEST_STATUSES.includes(value as DayOffSwapRequestStatus)) {
    return { ok: false, message: `status must be one of: ${DAY_OFF_SWAP_REQUEST_STATUSES.join(', ')}` }
  }
  return { ok: true, value: value as DayOffSwapRequestStatus }
}

/**
 * Structural + reference validation shared by create and edit: both dates
 * must be at least 3 days out, workDate must currently classify as a day
 * off (holiday or weekly_off) and offDate must currently classify as a
 * plain workday — both derived from buildCalendarDaysForDates, the same
 * cascade the calendar view uses, which already accounts for approved leave
 * and other approved swaps (a date already claimed by another approved swap
 * no longer classifies as 'workday'/'holiday'/'weekly_off', so it fails
 * here for free). Returns a fail() reason rather than calling fail() itself,
 * so both call sites can label the 400/409 the same way their own route
 * already does.
 */
async function validateDayOffSwapRequestInput(
  employeeId: number,
  input: DayOffSwapRequestInput,
  excludeId: number | null
): Promise<
  | { kind: 'ok'; workDateOriginalStatus: 'holiday' | 'weekly_off'; workDateOriginalLabel: string | null }
  | { kind: 'employee-not-found' }
  | { kind: 'same-date' }
  | { kind: 'too-soon' }
  | { kind: 'work-date-not-off' }
  | { kind: 'off-date-not-workday' }
  | { kind: 'no-shift' }
  | { kind: 'conflict-swap' }
  | { kind: 'conflict-shift-change' }
> {
  const employee = await findEmployeeById(employeeId)
  if (!employee) return { kind: 'employee-not-found' }

  if (input.workDate === input.offDate) return { kind: 'same-date' }

  const today = toThailandDateString(new Date())
  const minAllowed = addDays(today, 3)
  if (input.workDate < minAllowed || input.offDate < minAllowed) return { kind: 'too-soon' }

  const [workDay, offDay] = await buildCalendarDaysForDates(employeeId, [input.workDate, input.offDate])
  if (!workDay || (workDay.status !== 'holiday' && workDay.status !== 'weekly_off')) {
    return { kind: 'work-date-not-off' }
  }
  if (!offDay || offDay.status !== 'workday') return { kind: 'off-date-not-workday' }

  const workShiftId = await getShiftIdForDate(employeeId, input.workDate)
  if (workShiftId === null) return { kind: 'no-shift' }

  if (await hasConflictingDayOffSwapRequest(employeeId, input.workDate, input.offDate, excludeId)) {
    return { kind: 'conflict-swap' }
  }
  if (await hasConflictingShiftChangeRequest(employeeId, input.workDate, null)) {
    return { kind: 'conflict-shift-change' }
  }
  if (await hasConflictingShiftChangeRequest(employeeId, input.offDate, null)) {
    return { kind: 'conflict-shift-change' }
  }

  return {
    kind: 'ok',
    workDateOriginalStatus: workDay.status as 'holiday' | 'weekly_off',
    workDateOriginalLabel: workDay.label,
  }
}

function validationFail(
  res: Response,
  outcome:
    | { kind: 'employee-not-found' }
    | { kind: 'same-date' }
    | { kind: 'too-soon' }
    | { kind: 'work-date-not-off' }
    | { kind: 'off-date-not-workday' }
    | { kind: 'no-shift' }
    | { kind: 'conflict-swap' }
    | { kind: 'conflict-shift-change' }
): void {
  if (outcome.kind === 'employee-not-found') return fail(res, 404, 'employee not found')
  if (outcome.kind === 'same-date') return fail(res, 400, 'วันทำงานและวันที่ต้องการสลับต้องเป็นคนละวันกัน')
  if (outcome.kind === 'too-soon') {
    return fail(res, 400, 'ต้องขอสลับวันหยุดล่วงหน้าอย่างน้อย 3 วัน ไม่สามารถขอย้อนหลังหรือกระชั้นชิดได้')
  }
  if (outcome.kind === 'work-date-not-off') {
    return fail(res, 400, 'วันทำงานที่เลือกต้องเป็นวันหยุด (วันหยุดบริษัทหรือวันหยุดประจำสัปดาห์) ของคุณเท่านั้น')
  }
  if (outcome.kind === 'off-date-not-workday') {
    return fail(res, 400, 'วันที่ต้องการสลับต้องเป็นวันทำงานปกติของคุณเท่านั้น')
  }
  if (outcome.kind === 'no-shift') {
    return fail(res, 400, 'คุณยังไม่มีกะถาวรที่กำหนดไว้ ไม่สามารถระบุกะสำหรับวันทำงานที่ขอได้')
  }
  if (outcome.kind === 'conflict-swap') {
    return fail(res, 409, 'มีคำขอสลับวันหยุดอื่นสำหรับวันที่นี้ที่ยังรออนุมัติหรืออนุมัติแล้วอยู่แล้ว')
  }
  if (outcome.kind === 'conflict-shift-change') {
    return fail(res, 409, 'มีคำขอเปลี่ยนกะสำหรับวันที่นี้ที่ยังรออนุมัติหรืออนุมัติแล้วอยู่แล้ว')
  }
}

dayOffSwapRequestsRouter.post('/day-off-swap-requests', async (req: Request, res: Response) => {
  const employeeId = requireEmployeeId(req, res)
  if (employeeId === null) return

  const parsed = parseDayOffSwapRequestInput(req.body)
  if (!parsed.ok) return fail(res, 400, parsed.message)
  const input = parsed.value

  try {
    const outcome = await validateDayOffSwapRequestInput(employeeId, input, null)
    if (outcome.kind !== 'ok') return validationFail(res, outcome)

    const request = await withTransaction(async (client) => {
      const { rows } = await client.query<{ id: string; created_at: string; updated_at: string }>(
        `INSERT INTO day_off_swap_requests
           (employee_id, work_date, off_date, work_date_original_status, work_date_original_label, reason)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, created_at, updated_at`,
        [
          employeeId,
          input.workDate,
          input.offDate,
          outcome.workDateOriginalStatus,
          outcome.workDateOriginalLabel,
          input.reason,
        ]
      )
      const created = rows[0]
      if (!created) throw new Error('insert into day_off_swap_requests returned no row')

      await recordAudit(client, {
        actor: { kind: 'employee', employeeId },
        action: 'day_off_swap_request.create',
        entityId: Number(created.id),
        detail: { workDate: input.workDate, offDate: input.offDate },
      })

      const { rows: selectRows } = await client.query<DayOffSwapRequestRow>(
        `${SELECT_DAY_OFF_SWAP_REQUEST} WHERE dosr.id = $1`,
        [created.id]
      )
      const row = selectRows[0]
      if (!row) throw new Error('re-select of day_off_swap_requests returned no row')
      return rowToDayOffSwapRequest(row)
    })

    const body: DayOffSwapRequestResponse = { request }
    res.status(201).json(body)
  } catch (err) {
    handleUnexpected(res, err)
  }
})

dayOffSwapRequestsRouter.get('/day-off-swap-requests/me', async (req: Request, res: Response) => {
  const employeeId = requireEmployeeId(req, res)
  if (employeeId === null) return

  try {
    const requests = await listDayOffSwapRequestsForEmployee(employeeId)
    const body: DayOffSwapRequestMineResponse = { requests }
    res.json(body)
  } catch (err) {
    handleUnexpected(res, err)
  }
})

// Editable only while pending — replaces the whole request rather than
// patching one field, same body shape as creation.
dayOffSwapRequestsRouter.put('/day-off-swap-requests/:id', async (req: Request, res: Response) => {
  const employeeId = requireEmployeeId(req, res)
  if (employeeId === null) return

  const id = parseId(req.params['id'])
  if (id === null) return fail(res, 400, 'id must be a positive integer')

  const parsed = parseDayOffSwapRequestInput(req.body)
  if (!parsed.ok) return fail(res, 400, parsed.message)
  const input = parsed.value

  try {
    const outcome = await validateDayOffSwapRequestInput(employeeId, input, id)
    if (outcome.kind !== 'ok') return validationFail(res, outcome)

    const result = await withTransaction(async (client) => {
      const { rows } = await client.query<{ employee_id: string; status: string }>(
        `SELECT employee_id, status FROM day_off_swap_requests WHERE id = $1 FOR UPDATE`,
        [id]
      )
      const row = rows[0]
      if (!row) return { kind: 'not_found' as const }
      if (Number(row.employee_id) !== employeeId) return { kind: 'not_found' as const }
      if (row.status !== 'pending') return { kind: 'conflict' as const }

      await client.query(
        `UPDATE day_off_swap_requests
         SET work_date = $2, off_date = $3, work_date_original_status = $4,
             work_date_original_label = $5, reason = $6, updated_at = now()
         WHERE id = $1`,
        [id, input.workDate, input.offDate, outcome.workDateOriginalStatus, outcome.workDateOriginalLabel, input.reason]
      )

      await recordAudit(client, {
        actor: { kind: 'employee', employeeId },
        action: 'day_off_swap_request.update',
        entityId: id,
        detail: { workDate: input.workDate, offDate: input.offDate },
      })

      const { rows: selectRows } = await client.query<DayOffSwapRequestRow>(
        `${SELECT_DAY_OFF_SWAP_REQUEST} WHERE dosr.id = $1`,
        [id]
      )
      const updated = selectRows[0]
      if (!updated) throw new Error('re-select of day_off_swap_requests returned no row')
      return { kind: 'ok' as const, request: rowToDayOffSwapRequest(updated) }
    })

    if (result.kind === 'not_found') return fail(res, 404, `no day off swap request with id ${id}`)
    if (result.kind === 'conflict') return fail(res, 409, 'คำขอนี้ถูกดำเนินการไปแล้ว ไม่สามารถแก้ไขได้')

    const body: DayOffSwapRequestResponse = { request: result.request }
    res.json(body)
  } catch (err) {
    handleUnexpected(res, err)
  }
})

dayOffSwapRequestsRouter.post('/day-off-swap-requests/:id/cancel', async (req: Request, res: Response) => {
  const employeeId = requireEmployeeId(req, res)
  if (employeeId === null) return

  const id = parseId(req.params['id'])
  if (id === null) return fail(res, 400, 'id must be a positive integer')

  try {
    const result = await withTransaction(async (client) => {
      const { rows } = await client.query<{ employee_id: string; status: string }>(
        `SELECT employee_id, status FROM day_off_swap_requests WHERE id = $1 FOR UPDATE`,
        [id]
      )
      const row = rows[0]
      if (!row) return { kind: 'not_found' as const }
      if (Number(row.employee_id) !== employeeId) return { kind: 'not_found' as const }
      if (row.status !== 'pending') return { kind: 'conflict' as const }

      await client.query(
        `UPDATE day_off_swap_requests SET status = 'cancelled', updated_at = now() WHERE id = $1`,
        [id]
      )

      await recordAudit(client, {
        actor: { kind: 'employee', employeeId },
        action: 'day_off_swap_request.cancel',
        entityId: id,
        detail: {},
      })

      const { rows: selectRows } = await client.query<DayOffSwapRequestRow>(
        `${SELECT_DAY_OFF_SWAP_REQUEST} WHERE dosr.id = $1`,
        [id]
      )
      const updated = selectRows[0]
      if (!updated) throw new Error('re-select of day_off_swap_requests returned no row')
      return { kind: 'ok' as const, request: rowToDayOffSwapRequest(updated) }
    })

    if (result.kind === 'not_found') return fail(res, 404, `no day off swap request with id ${id}`)
    if (result.kind === 'conflict') return fail(res, 409, 'คำขอนี้ถูกดำเนินการไปแล้ว ไม่สามารถยกเลิกได้')

    const body: DayOffSwapRequestResponse = { request: result.request }
    res.json(body)
  } catch (err) {
    handleUnexpected(res, err)
  }
})

dayOffSwapRequestsRouter.get('/day-off-swap-requests', canReadAdmin, async (req: Request, res: Response) => {
  const statusResult = parseStatusFilter(req.query['status'] as string | string[] | undefined)
  if (!statusResult.ok) return fail(res, 400, statusResult.message)

  try {
    const requests = await listDayOffSwapRequests({ status: statusResult.value })
    const body: DayOffSwapRequestListResponse = { requests }
    res.json(body)
  } catch (err) {
    handleUnexpected(res, err)
  }
})

dayOffSwapRequestsRouter.get('/day-off-swap-requests/:id', canReadAdmin, async (req: Request, res: Response) => {
  const id = parseId(req.params['id'])
  if (id === null) return fail(res, 400, 'id must be a positive integer')

  try {
    const request = await findDayOffSwapRequestById(id)
    if (!request) return fail(res, 404, `no day off swap request with id ${id}`)

    const body: DayOffSwapRequestDetailResponse = { request }
    res.json(body)
  } catch (err) {
    handleUnexpected(res, err)
  }
})

dayOffSwapRequestsRouter.post(
  '/day-off-swap-requests/:id/approve',
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
          work_date: string
          off_date: string
          status: string
        }>(
          `SELECT employee_id, work_date, off_date, status
           FROM day_off_swap_requests WHERE id = $1 FOR UPDATE`,
          [id]
        )
        const row = rows[0]
        if (!row) return { kind: 'not_found' as const }
        if (row.status !== 'pending') return { kind: 'conflict' as const, message: 'คำขอนี้ถูกดำเนินการไปแล้ว' }

        // Re-checked here, not just at submission: a request can sit pending
        // long enough for its dates to slip into the past, or for the
        // underlying holiday calendar/shift assignment to change out from
        // under it.
        const employeeId = Number(row.employee_id)
        const today = toThailandDateString(new Date())
        if (row.work_date < today || row.off_date < today) {
          return {
            kind: 'expired' as const,
            message: 'วันที่ขอสลับผ่านไปแล้ว ไม่สามารถอนุมัติได้ กรุณาปฏิเสธคำขอนี้',
          }
        }

        const [workDay, offDay] = await buildCalendarDaysForDates(employeeId, [row.work_date, row.off_date], client)
        const workOk = workDay && (workDay.status === 'holiday' || workDay.status === 'weekly_off')
        const offOk = offDay && offDay.status === 'workday'
        if (!workOk || !offOk) {
          return {
            kind: 'drifted' as const,
            message: 'ข้อมูลวันหยุด/กะการทำงานของพนักงานเปลี่ยนไปตั้งแต่ยื่นคำขอ กรุณาตรวจสอบและปฏิเสธคำขอนี้หากไม่ถูกต้องแล้ว',
          }
        }
        if ((await getShiftIdForDate(employeeId, row.work_date, client)) === null) {
          return {
            kind: 'no_shift' as const,
            message: 'พนักงานคนนี้ยังไม่มีกะถาวรที่กำหนดไว้ ไม่สามารถอนุมัติได้',
          }
        }

        await client.query(
          `UPDATE day_off_swap_requests
           SET status = 'approved', decided_by_oid = $2, decided_by_name = $3, decided_at = now(), updated_at = now()
           WHERE id = $1`,
          [id, actor.oid, actor.name]
        )

        await recordAudit(client, {
          actor,
          action: 'day_off_swap_request.approve',
          entityId: id,
          detail: { employeeId, workDate: row.work_date, offDate: row.off_date },
        })

        const request = await findDayOffSwapRequestById(id, client)
        if (!request) throw new Error('re-select of day_off_swap_requests returned no row')
        return { kind: 'ok' as const, request }
      })

      if (result.kind === 'not_found') return fail(res, 404, `no day off swap request with id ${id}`)
      if (result.kind === 'conflict' || result.kind === 'expired' || result.kind === 'drifted' || result.kind === 'no_shift') {
        return fail(res, 409, result.message)
      }

      const body: DayOffSwapRequestDetailResponse = { request: result.request }
      res.json(body)
    } catch (err) {
      handleUnexpected(res, err)
    }
  }
)

dayOffSwapRequestsRouter.post(
  '/day-off-swap-requests/:id/reject',
  canDecide,
  async (req: Request, res: Response) => {
    const actor = actorOf(req)
    if (!actor || actor.kind !== 'admin') return fail(res, 500, 'server misconfigured')

    const id = parseId(req.params['id'])
    if (id === null) return fail(res, 400, 'id must be a positive integer')

    const body = req.body as Partial<DayOffSwapRequestRejectRequest> | null
    const reason = requiredString((body ?? {}) as Record<string, unknown>, 'reason', 1000)
    if (reason === null) return fail(res, 400, 'reason is required and must be 1000 characters or fewer')

    try {
      const result = await withTransaction(async (client) => {
        const { rows } = await client.query<{ status: string }>(
          `SELECT status FROM day_off_swap_requests WHERE id = $1 FOR UPDATE`,
          [id]
        )
        const row = rows[0]
        if (!row) return { kind: 'not_found' as const }
        if (row.status !== 'pending') return { kind: 'conflict' as const }

        await client.query(
          `UPDATE day_off_swap_requests
           SET status = 'rejected', decided_by_oid = $2, decided_by_name = $3,
               decided_at = now(), decision_reason = $4, updated_at = now()
           WHERE id = $1`,
          [id, actor.oid, actor.name, reason]
        )

        await recordAudit(client, {
          actor,
          action: 'day_off_swap_request.reject',
          entityId: id,
          detail: { reason },
        })

        const request = await findDayOffSwapRequestById(id, client)
        if (!request) throw new Error('re-select of day_off_swap_requests returned no row')
        return { kind: 'ok' as const, request }
      })

      if (result.kind === 'not_found') return fail(res, 404, `no day off swap request with id ${id}`)
      if (result.kind === 'conflict') return fail(res, 409, 'คำขอนี้ถูกดำเนินการไปแล้ว')

      const responseBody: DayOffSwapRequestDetailResponse = { request: result.request }
      res.json(responseBody)
    } catch (err) {
      handleUnexpected(res, err)
    }
  }
)
