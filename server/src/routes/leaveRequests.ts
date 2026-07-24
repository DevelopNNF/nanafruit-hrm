import { Router } from 'express'
import type { Request, Response } from 'express'
import {
  LEAVE_REQUEST_STATUSES,
  ROLES,
  type AuthUser,
  type LeaveRequestDetailResponse,
  type LeaveRequestInput,
  type LeaveRequestListResponse,
  type LeaveRequestMineResponse,
  type LeaveRequestRejectRequest,
  type LeaveRequestResponse,
  type LeaveRequestStatus,
} from '@hrm/shared'
import { withTransaction } from '../db.js'
import { requireRole } from '../auth/middleware.js'
import { recordAudit } from '../audit.js'
import { fail, handleUnexpected } from '../http.js'
import { findEmployeeById } from '../employeeQueries.js'
import { findLeaveTypeById } from '../leaveTypeQueries.js'
import { listLeaveBalanceSummaries } from '../leaveBalanceQueries.js'
import {
  SELECT_LEAVE_REQUEST,
  computeTotalDays,
  findLeaveRequestById,
  hasOverlappingLeaveRequest,
  listLeaveRequests,
  listLeaveRequestsForEmployee,
  loadLeaveDayContext,
  rowToLeaveRequest,
  type LeaveRequestRow,
} from '../leaveRequestQueries.js'

export const leaveRequestsRouter = Router()

// Same split as time corrections: any HRM role may look at the review
// queue, only HR and Admin may decide it.
const canReadAdmin = requireRole(...ROLES)
const canDecide = requireRole('HRM.HR', 'HRM.Admin')

function actorOf(req: Request): AuthUser | null {
  return req.auth ?? null
}

/** POST /leave-requests and its /me, /:id/cancel siblings are for the
 *  employee arm of AuthUser only — an admin token has no employeeId to
 *  submit or cancel a request as, same reasoning as timeCorrections.ts. */
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

function requiredString(source: Record<string, unknown>, key: string, maxLength: number): string | null {
  const value = source[key]
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed === '' || trimmed.length > maxLength) return null
  return trimmed
}

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)(:[0-5]\d)?$/

function parseDateOnly(value: unknown): string | null {
  if (typeof value !== 'string' || !DATE_ONLY_RE.test(value)) return null
  return Number.isNaN(new Date(`${value}T00:00:00Z`).getTime()) ? null : value
}

/** Normalized to 'HH:MM:SS' so it always matches what the DB hands back on read. */
function parseTimeOnly(value: unknown): string | null | undefined {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string' || !TIME_RE.test(value)) return undefined
  return value.length === 5 ? `${value}:00` : value
}

/** Structural validation only — leave-type-specific rules (gender, half-day/
 *  hourly allowance, min/max days, advance notice, balance, overlap) all
 *  need data this function doesn't have, so they're checked in the route
 *  handler once the leave type and employee are loaded. */
function parseLeaveRequestInput(body: unknown): ParseResult<LeaveRequestInput> {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, message: 'body must be a JSON object' }
  }
  const raw = body as Record<string, unknown>

  const leaveTypeIdRaw = raw['leaveTypeId']
  if (typeof leaveTypeIdRaw !== 'number' || !Number.isInteger(leaveTypeIdRaw) || leaveTypeIdRaw <= 0) {
    return { ok: false, message: 'leaveTypeId is required and must be a positive integer' }
  }

  const startDate = parseDateOnly(raw['startDate'])
  if (startDate === null) return { ok: false, message: 'startDate is required and must be a YYYY-MM-DD date' }

  const endDate = parseDateOnly(raw['endDate'])
  if (endDate === null) return { ok: false, message: 'endDate is required and must be a YYYY-MM-DD date' }

  if (endDate < startDate) return { ok: false, message: 'endDate must not be before startDate' }

  const startTime = parseTimeOnly(raw['startTime'])
  if (startTime === undefined) return { ok: false, message: 'startTime must be a HH:MM time or null' }

  const endTime = parseTimeOnly(raw['endTime'])
  if (endTime === undefined) return { ok: false, message: 'endTime must be a HH:MM time or null' }

  if ((startTime === null) !== (endTime === null)) {
    return { ok: false, message: 'startTime and endTime must both be set or both be null' }
  }
  if (startTime !== null && endTime !== null) {
    if (startDate !== endDate) {
      return { ok: false, message: 'a request with startTime/endTime must have the same startDate and endDate' }
    }
    if (endTime <= startTime) {
      return { ok: false, message: 'endTime must be after startTime' }
    }
  }

  const reasonRaw = raw['reason']
  const reason = typeof reasonRaw === 'string' && reasonRaw.trim() !== '' ? reasonRaw.trim() : null

  return {
    ok: true,
    value: { leaveTypeId: leaveTypeIdRaw, startDate, endDate, startTime, endTime, reason },
  }
}

function parseStatusFilter(
  value: string | string[] | undefined
): ParseResult<LeaveRequestStatus | undefined> {
  if (value === undefined) return { ok: true, value: undefined }
  if (typeof value !== 'string' || !LEAVE_REQUEST_STATUSES.includes(value as LeaveRequestStatus)) {
    return { ok: false, message: `status must be one of: ${LEAVE_REQUEST_STATUSES.join(', ')}` }
  }
  return { ok: true, value: value as LeaveRequestStatus }
}

/** 'Today' in Thailand, regardless of the server's own timezone — same
 *  standing assumption as liff's clock-in flow: the employee's phone (and
 *  the org running this system) is on Thailand time. */
function thailandToday(): string {
  const bangkokNow = new Date(Date.now() + 7 * 60 * 60 * 1000)
  return bangkokNow.toISOString().slice(0, 10)
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

leaveRequestsRouter.post('/leave-requests', async (req: Request, res: Response) => {
  const employeeId = requireEmployeeId(req, res)
  if (employeeId === null) return

  const parsed = parseLeaveRequestInput(req.body)
  if (!parsed.ok) return fail(res, 400, parsed.message)
  const input = parsed.value

  try {
    const [employee, leaveType] = await Promise.all([
      findEmployeeById(employeeId),
      findLeaveTypeById(input.leaveTypeId),
    ])
    if (!employee) return fail(res, 404, `no employee with id ${employeeId}`)
    if (!leaveType) return fail(res, 400, `no leave type with id ${input.leaveTypeId}`)
    if (!leaveType.isActive) return fail(res, 400, `leave type "${leaveType.leaveName}" is no longer active`)

    if (leaveType.gender !== 'all' && employee.gender !== leaveType.gender) {
      return fail(res, 400, `ประเภทการลานี้จำกัดเฉพาะเพศ${leaveType.gender === 'male' ? 'ชาย' : 'หญิง'}`)
    }

    const isPartialDay = input.startTime !== null
    if (isPartialDay && !leaveType.allowHalfDay && !leaveType.allowHourly) {
      return fail(res, 400, `ประเภทการลานี้ไม่รองรับการลาแบบระบุช่วงเวลา`)
    }

    if (leaveType.requireReason && input.reason === null) {
      return fail(res, 400, `ประเภทการลานี้ต้องระบุเหตุผล`)
    }

    const minStartDate = addDays(thailandToday(), leaveType.advanceNoticeDays)
    if (input.startDate < minStartDate) {
      return fail(
        res,
        400,
        `ประเภทการลานี้ต้องแจ้งล่วงหน้าอย่างน้อย ${leaveType.advanceNoticeDays} วัน — วันที่เร็วที่สุดที่ขอได้คือ ${minStartDate}`
      )
    }

    const overlapping = await hasOverlappingLeaveRequest(employeeId, input.startDate, input.endDate)
    if (overlapping) {
      return fail(res, 409, 'ช่วงวันที่นี้ทับซ้อนกับคำขอลาอื่นที่ยังรออนุมัติหรืออนุมัติแล้วของคุณ')
    }

    const dayContext = await loadLeaveDayContext(employeeId, input.startDate, input.endDate)
    const totalDays = computeTotalDays({
      startDate: input.startDate,
      endDate: input.endDate,
      startTime: input.startTime,
      endTime: input.endTime,
      isCountHoliday: leaveType.isCountHoliday,
      isCountWeekend: leaveType.isCountWeekend,
      shift: dayContext.shift,
      holidayDates: dayContext.holidayDates,
    })

    if (totalDays <= 0) {
      return fail(res, 400, 'ช่วงวันที่ที่เลือกไม่มีวันลาที่นับได้ (เป็นวันหยุดทั้งหมด)')
    }
    if (totalDays < leaveType.minLeaveDays) {
      return fail(res, 400, `ประเภทการลานี้ขอได้อย่างน้อย ${leaveType.minLeaveDays} วันต่อครั้ง`)
    }
    if (leaveType.maxLeaveDays !== null && totalDays > leaveType.maxLeaveDays) {
      return fail(res, 400, `ประเภทการลานี้ขอได้ไม่เกิน ${leaveType.maxLeaveDays} วันต่อครั้ง`)
    }

    if (leaveType.defaultDaysPerYear !== null) {
      const year = Number(input.startDate.slice(0, 4))
      const summaries = await listLeaveBalanceSummaries(employeeId, year)
      const summary = summaries.find((s) => s.leaveTypeId === leaveType.id)
      const available = (summary?.remainingDays ?? 0) - (summary?.pendingDays ?? 0)
      if (totalDays > available) {
        return fail(
          res,
          400,
          `สิทธิ์คงเหลือไม่เพียงพอ (คงเหลือ ${available} วัน หลังหักคำขอที่รออนุมัติ, ขอ ${totalDays} วัน)`
        )
      }
    }

    const request = await withTransaction(async (client) => {
      const { rows } = await client.query<{ id: string; created_at: string }>(
        `INSERT INTO leave_requests
           (employee_id, leave_type_id, start_date, end_date, start_time, end_time, total_days, reason)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id, created_at`,
        [
          employeeId,
          input.leaveTypeId,
          input.startDate,
          input.endDate,
          input.startTime,
          input.endTime,
          totalDays,
          input.reason,
        ]
      )
      const created = rows[0]
      if (!created) throw new Error('insert into leave_requests returned no row')

      await recordAudit(client, {
        actor: { kind: 'employee', employeeId },
        action: 'leave_request.create',
        entityId: Number(created.id),
        detail: { leaveTypeId: input.leaveTypeId, startDate: input.startDate, endDate: input.endDate, totalDays },
      })

      return rowToLeaveRequest({
        id: created.id,
        employee_id: String(employeeId),
        leave_type_id: String(leaveType.id),
        leave_code: leaveType.leaveCode,
        leave_name: leaveType.leaveName,
        start_date: input.startDate,
        end_date: input.endDate,
        start_time: input.startTime,
        end_time: input.endTime,
        total_days: String(totalDays),
        reason: input.reason,
        status: 'pending',
        decided_by_name: null,
        decided_at: null,
        decision_reason: null,
        leave_balance_entry_id: null,
        created_at: created.created_at,
      })
    })

    const body: LeaveRequestResponse = { request }
    res.status(201).json(body)
  } catch (err) {
    handleUnexpected(res, err)
  }
})

leaveRequestsRouter.get('/leave-requests/me', async (req: Request, res: Response) => {
  const employeeId = requireEmployeeId(req, res)
  if (employeeId === null) return

  try {
    const requests = await listLeaveRequestsForEmployee(employeeId)
    const body: LeaveRequestMineResponse = { requests }
    res.json(body)
  } catch (err) {
    handleUnexpected(res, err)
  }
})

leaveRequestsRouter.post('/leave-requests/:id/cancel', async (req: Request, res: Response) => {
  const employeeId = requireEmployeeId(req, res)
  if (employeeId === null) return

  const id = parseId(req.params['id'])
  if (id === null) return fail(res, 400, 'id must be a positive integer')

  try {
    const result = await withTransaction(async (client) => {
      const { rows } = await client.query<{ employee_id: string; status: string }>(
        `SELECT employee_id, status FROM leave_requests WHERE id = $1 FOR UPDATE`,
        [id]
      )
      const row = rows[0]
      if (!row) return { kind: 'not_found' as const }
      if (Number(row.employee_id) !== employeeId) return { kind: 'not_found' as const }
      if (row.status !== 'pending') return { kind: 'conflict' as const }

      await client.query(
        `UPDATE leave_requests SET status = 'cancelled', updated_at = now() WHERE id = $1`,
        [id]
      )

      await recordAudit(client, {
        actor: { kind: 'employee', employeeId },
        action: 'leave_request.cancel',
        entityId: id,
        detail: {},
      })

      const { rows: updatedRows } = await client.query<LeaveRequestRow>(
        `${SELECT_LEAVE_REQUEST} WHERE lr.id = $1`,
        [id]
      )
      const updated = updatedRows[0]
      if (!updated) throw new Error('re-select of leave_requests returned no row')
      return { kind: 'ok' as const, request: rowToLeaveRequest(updated) }
    })

    if (result.kind === 'not_found') return fail(res, 404, `no leave request with id ${id}`)
    if (result.kind === 'conflict') return fail(res, 409, 'คำขอนี้ถูกดำเนินการไปแล้ว ไม่สามารถยกเลิกได้')

    const body: LeaveRequestResponse = { request: result.request }
    res.json(body)
  } catch (err) {
    handleUnexpected(res, err)
  }
})

leaveRequestsRouter.get('/leave-requests', canReadAdmin, async (req: Request, res: Response) => {
  const statusResult = parseStatusFilter(req.query['status'] as string | string[] | undefined)
  if (!statusResult.ok) return fail(res, 400, statusResult.message)

  try {
    const requests = await listLeaveRequests({ status: statusResult.value })
    const body: LeaveRequestListResponse = { requests }
    res.json(body)
  } catch (err) {
    handleUnexpected(res, err)
  }
})

leaveRequestsRouter.get('/leave-requests/:id', canReadAdmin, async (req: Request, res: Response) => {
  const id = parseId(req.params['id'])
  if (id === null) return fail(res, 400, 'id must be a positive integer')

  try {
    const request = await findLeaveRequestById(id)
    if (!request) return fail(res, 404, `no leave request with id ${id}`)

    const body: LeaveRequestDetailResponse = { request }
    res.json(body)
  } catch (err) {
    handleUnexpected(res, err)
  }
})

leaveRequestsRouter.post('/leave-requests/:id/approve', canDecide, async (req: Request, res: Response) => {
  const actor = actorOf(req)
  if (!actor || actor.kind !== 'admin') return fail(res, 500, 'server misconfigured')

  const id = parseId(req.params['id'])
  if (id === null) return fail(res, 400, 'id must be a positive integer')

  try {
    const result = await withTransaction(async (client) => {
      const { rows } = await client.query<{
        employee_id: string
        leave_type_id: string
        start_date: string
        total_days: string
        status: string
      }>(
        `SELECT employee_id, leave_type_id, start_date, total_days, status
         FROM leave_requests WHERE id = $1 FOR UPDATE`,
        [id]
      )
      const row = rows[0]
      if (!row) return { kind: 'not_found' as const }
      if (row.status !== 'pending') return { kind: 'conflict' as const, message: 'คำขอนี้ถูกดำเนินการไปแล้ว' }

      const year = Number(row.start_date.slice(0, 4))

      const { rows: entryRows } = await client.query<{ id: string }>(
        `INSERT INTO leave_balance_entries
           (employee_id, leave_type_id, year, entry_type, amount_days, created_by_oid, created_by_name)
         VALUES ($1, $2, $3, 'usage', $4, $5, $6)
         RETURNING id`,
        [row.employee_id, row.leave_type_id, year, -Number(row.total_days), actor.oid, actor.name]
      )
      const leaveBalanceEntryId = Number(entryRows[0]?.id)
      if (!leaveBalanceEntryId) throw new Error('insert into leave_balance_entries returned no id')

      await client.query(
        `UPDATE leave_requests
         SET status = 'approved', decided_by_oid = $2, decided_by_name = $3,
             decided_at = now(), leave_balance_entry_id = $4, updated_at = now()
         WHERE id = $1`,
        [id, actor.oid, actor.name, leaveBalanceEntryId]
      )

      await recordAudit(client, {
        actor,
        action: 'leave_request.approve',
        entityId: id,
        detail: { leaveBalanceEntryId, totalDays: Number(row.total_days) },
      })

      const request = await findLeaveRequestById(id, client)
      if (!request) throw new Error('re-select of leave_requests returned no row')
      return { kind: 'ok' as const, request }
    })

    if (result.kind === 'not_found') return fail(res, 404, `no leave request with id ${id}`)
    if (result.kind === 'conflict') return fail(res, 409, result.message)

    const body: LeaveRequestDetailResponse = { request: result.request }
    res.json(body)
  } catch (err) {
    handleUnexpected(res, err)
  }
})

leaveRequestsRouter.post('/leave-requests/:id/reject', canDecide, async (req: Request, res: Response) => {
  const actor = actorOf(req)
  if (!actor || actor.kind !== 'admin') return fail(res, 500, 'server misconfigured')

  const id = parseId(req.params['id'])
  if (id === null) return fail(res, 400, 'id must be a positive integer')

  const body = req.body as Partial<LeaveRequestRejectRequest> | null
  const reason = requiredString((body ?? {}) as Record<string, unknown>, 'reason', 1000)
  if (reason === null) return fail(res, 400, 'reason is required and must be 1000 characters or fewer')

  try {
    const result = await withTransaction(async (client) => {
      const { rows } = await client.query<{ status: string }>(
        `SELECT status FROM leave_requests WHERE id = $1 FOR UPDATE`,
        [id]
      )
      const row = rows[0]
      if (!row) return { kind: 'not_found' as const }
      if (row.status !== 'pending') return { kind: 'conflict' as const }

      await client.query(
        `UPDATE leave_requests
         SET status = 'rejected', decided_by_oid = $2, decided_by_name = $3,
             decided_at = now(), decision_reason = $4, updated_at = now()
         WHERE id = $1`,
        [id, actor.oid, actor.name, reason]
      )

      await recordAudit(client, {
        actor,
        action: 'leave_request.reject',
        entityId: id,
        detail: { reason },
      })

      const request = await findLeaveRequestById(id, client)
      if (!request) throw new Error('re-select of leave_requests returned no row')
      return { kind: 'ok' as const, request }
    })

    if (result.kind === 'not_found') return fail(res, 404, `no leave request with id ${id}`)
    if (result.kind === 'conflict') return fail(res, 409, 'คำขอนี้ถูกดำเนินการไปแล้ว')

    const responseBody: LeaveRequestDetailResponse = { request: result.request }
    res.json(responseBody)
  } catch (err) {
    handleUnexpected(res, err)
  }
})
