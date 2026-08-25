import { Router } from 'express'
import type { Request, Response } from 'express'
import type pg from 'pg'
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
  type LeaveRequestStage,
  type LeaveRequestStatus,
} from '@hrm/shared'
import { pool, withTransaction } from '../db.js'
import { requireRole, requireRoleOrEmployee } from '../auth/middleware.js'
import { recordAudit } from '../audit.js'
import { fail, handleUnexpected } from '../http.js'
import { describeActor, findEmployeeById, findEmployeeIdByEntraUpn } from '../employeeQueries.js'
import { findLeaveTypeById } from '../leaveTypeQueries.js'
import { listLeaveBalanceSummaries } from '../leaveBalanceQueries.js'
import { resolveSupervisorScope } from '../supervisorScope.js'
import {
  SELECT_LEAVE_REQUEST,
  computeTotalDays,
  findLeaveRequestById,
  hasOverlappingLeaveRequest,
  listLeaveRequests,
  listLeaveRequestsForEmployee,
  listLeaveRequestsPendingApproval,
  loadLeaveDayContext,
  rowToLeaveRequest,
  type LeaveRequestRow,
} from '../leaveRequestQueries.js'

export const leaveRequestsRouter = Router()

type Queryable = Pick<pg.Pool, 'query'>

// Any HRM role may look at the review queue (unchanged). Deciding one is no
// longer a fixed role check: HR/Admin may always decide, and a supervisor
// may decide only their own team's request while it's waiting on them — see
// resolveLeaveApprover, checked per-request inside each handler once the row
// (and its current_stage) is loaded.
const canReadAdmin = requireRole(...ROLES)
// Approve/reject only: an employee-kind caller (a LIFF supervisor) always
// passes this gate too — resolveLeaveApprover still gates what they may
// actually do once the row is loaded, same as an admin with the wrong role.
const canDecideAsAdminOrEmployee = requireRoleOrEmployee(...ROLES)

function actorOf(req: Request): AuthUser | null {
  return req.auth ?? null
}

type LeaveApproverKind = 'hr' | 'supervisor'

/** Who, if anyone, may decide this request right now. HR/Admin may always
 *  decide, at any stage — the confirmed override rule. Anyone else may only
 *  act while the request is pending at the 'supervisor' stage and they are
 *  the snapshotted supervisor_employee_id, resolved from their Entra UPN the
 *  same way resolveSupervisorScope does. */
export async function resolveLeaveApprover(
  actor: AuthUser,
  row: { status: string; currentStage: string | null; supervisorEmployeeId: number | null },
  db: Queryable
): Promise<LeaveApproverKind | null> {
  if (actor.kind === 'employee') {
    // No UPN lookup needed — actor.employeeId is already the identity. Never
    // the 'hr' override: that stays an admin-only privilege by design.
    if (row.status !== 'pending' || row.currentStage !== 'supervisor' || row.supervisorEmployeeId === null) {
      return null
    }
    return actor.employeeId === row.supervisorEmployeeId ? 'supervisor' : null
  }
  if (actor.roles.includes('HRM.HR') || actor.roles.includes('HRM.Admin')) return 'hr'
  if (row.status !== 'pending' || row.currentStage !== 'supervisor' || row.supervisorEmployeeId === null) {
    return null
  }
  const callerEmployeeId = await findEmployeeIdByEntraUpn(actor.upn, db)
  return callerEmployeeId === row.supervisorEmployeeId ? 'supervisor' : null
}

/** LeaveRequestDetailResponse.canDecide — whether to show the request's own
 *  actor the approve/reject controls at all. */
async function computeCanDecide(
  actor: AuthUser | null,
  request: { status: string; currentStage: string | null; supervisorEmployeeId: number | null },
  db: Queryable
): Promise<boolean> {
  if (!actor || request.status !== 'pending') return false
  return (await resolveLeaveApprover(actor, request, db)) !== null
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

    // Snapshotted from employment_details.supervisor_employee_id (via
    // employee.employment, already loaded above), same as every other frozen
    // field on this request — see the migration's comment. No supervisor
    // means the request skips straight to the HR/Admin stage.
    const supervisorEmployeeId = employee.employment.supervisorEmployeeId
    const requiresSupervisorApproval = supervisorEmployeeId !== null
    const currentStage: LeaveRequestStage = requiresSupervisorApproval ? 'supervisor' : 'hr'

    const request = await withTransaction(async (client) => {
      const { rows } = await client.query<{ id: string; created_at: string }>(
        `INSERT INTO leave_requests
           (employee_id, leave_type_id, start_date, end_date, start_time, end_time, total_days, reason,
            requires_supervisor_approval, supervisor_employee_id, current_stage)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
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
          requiresSupervisorApproval,
          supervisorEmployeeId,
          currentStage,
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
        requires_supervisor_approval: requiresSupervisorApproval,
        supervisor_employee_id: supervisorEmployeeId === null ? null : String(supervisorEmployeeId),
        supervisor_employee_name: employee.employment.supervisorEmployeeName,
        current_stage: currentStage,
        supervisor_approved_by_name: null,
        supervisor_approved_at: null,
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
      const { rows } = await client.query<{
        employee_id: string
        status: string
        supervisor_approved_by_oid: string | null
      }>(
        `SELECT employee_id, status, supervisor_approved_by_oid FROM leave_requests WHERE id = $1 FOR UPDATE`,
        [id]
      )
      const row = rows[0]
      if (!row) return { kind: 'not_found' as const }
      if (Number(row.employee_id) !== employeeId) return { kind: 'not_found' as const }
      // Blocked once the supervisor has already forwarded it, even though
      // status is still 'pending' — HR is now looking at this request, and
      // an employee withdrawing it out from under them (or, via the
      // sibling edit route on other request types, silently changing what
      // they're deciding) is exactly the case a first-level approval is
      // supposed to lock in against.
      if (row.status !== 'pending' || row.supervisor_approved_by_oid !== null) {
        return { kind: 'conflict' as const }
      }

      await client.query(
        `UPDATE leave_requests SET status = 'cancelled', current_stage = NULL, updated_at = now() WHERE id = $1`,
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

// A supervisor's inbox — requests currently waiting on them, or (HR/Admin)
// every request currently waiting on any supervisor. Mounted ahead of
// GET /leave-requests/:id so 'pending-approval' is never parsed as an id.
leaveRequestsRouter.get('/leave-requests/pending-approval', canReadAdmin, async (req: Request, res: Response) => {
  const auth = actorOf(req)
  if (!auth) return fail(res, 500, 'server misconfigured')

  try {
    const scope = await resolveSupervisorScope(auth)
    // 'none' isn't an error here the way it is for Bulk OT — it just means
    // this account isn't anyone's supervisor, so their inbox is empty.
    if (scope.kind === 'none') {
      const body: LeaveRequestListResponse = { requests: [] }
      return res.json(body)
    }

    const requests = await listLeaveRequestsPendingApproval(
      scope.kind === 'all' ? null : scope.supervisorEmployeeId
    )
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

    const canDecide = await computeCanDecide(actorOf(req), request, pool)
    const body: LeaveRequestDetailResponse = { request, canDecide }
    res.json(body)
  } catch (err) {
    handleUnexpected(res, err)
  }
})

leaveRequestsRouter.post('/leave-requests/:id/approve', canDecideAsAdminOrEmployee, async (req: Request, res: Response) => {
  const actor = actorOf(req)
  if (!actor) return fail(res, 500, 'server misconfigured')

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
        current_stage: string | null
        supervisor_employee_id: string | null
      }>(
        `SELECT employee_id, leave_type_id, start_date, total_days, status, current_stage, supervisor_employee_id
         FROM leave_requests WHERE id = $1 FOR UPDATE`,
        [id]
      )
      const row = rows[0]
      if (!row) return { kind: 'not_found' as const }
      if (row.status !== 'pending') return { kind: 'conflict' as const, message: 'คำขอนี้ถูกดำเนินการไปแล้ว' }

      const approverKind = await resolveLeaveApprover(
        actor,
        {
          status: row.status,
          currentStage: row.current_stage,
          supervisorEmployeeId: row.supervisor_employee_id === null ? null : Number(row.supervisor_employee_id),
        },
        client
      )
      if (approverKind === null) return { kind: 'forbidden' as const }

      const actorInfo = await describeActor(actor, client)
      if (!actorInfo) return { kind: 'forbidden' as const }

      if (approverKind === 'supervisor') {
        // Forwarding approval only — the request stays pending, now waiting
        // on HR/Admin. Not the same event as the final approval below: no
        // leave balance is posted here, because nothing is decided yet.
        await client.query(
          `UPDATE leave_requests
           SET current_stage = 'hr', supervisor_approved_by_oid = $2,
               supervisor_approved_by_name = $3, supervisor_approved_at = now(), updated_at = now()
           WHERE id = $1`,
          [id, actorInfo.oid, actorInfo.name]
        )

        await recordAudit(client, {
          actor,
          action: 'leave_request.supervisor_approve',
          entityId: id,
          detail: {},
        })

        const request = await findLeaveRequestById(id, client)
        if (!request) throw new Error('re-select of leave_requests returned no row')
        const canDecide = await computeCanDecide(actor, request, client)
        return { kind: 'ok' as const, request, canDecide }
      }

      // HR/Admin's final decision — reached the ordinary way (current_stage
      // was already 'hr') or as an override of a still-pending supervisor
      // stage (confirmed: HR/Admin may act at any stage).
      const year = Number(row.start_date.slice(0, 4))

      const { rows: entryRows } = await client.query<{ id: string }>(
        `INSERT INTO leave_balance_entries
           (employee_id, leave_type_id, year, entry_type, amount_days, created_by_oid, created_by_name)
         VALUES ($1, $2, $3, 'usage', $4, $5, $6)
         RETURNING id`,
        [row.employee_id, row.leave_type_id, year, -Number(row.total_days), actorInfo.oid, actorInfo.name]
      )
      const leaveBalanceEntryId = Number(entryRows[0]?.id)
      if (!leaveBalanceEntryId) throw new Error('insert into leave_balance_entries returned no id')

      await client.query(
        `UPDATE leave_requests
         SET status = 'approved', current_stage = NULL, decided_by_oid = $2, decided_by_name = $3,
             decided_at = now(), leave_balance_entry_id = $4, updated_at = now()
         WHERE id = $1`,
        [id, actorInfo.oid, actorInfo.name, leaveBalanceEntryId]
      )

      await recordAudit(client, {
        actor,
        action: 'leave_request.approve',
        entityId: id,
        detail: { leaveBalanceEntryId, totalDays: Number(row.total_days) },
      })

      const request = await findLeaveRequestById(id, client)
      if (!request) throw new Error('re-select of leave_requests returned no row')
      return { kind: 'ok' as const, request, canDecide: false }
    })

    if (result.kind === 'not_found') return fail(res, 404, `no leave request with id ${id}`)
    if (result.kind === 'conflict') return fail(res, 409, result.message)
    if (result.kind === 'forbidden') return fail(res, 403, 'คุณไม่มีสิทธิ์อนุมัติคำขอนี้', 'FORBIDDEN')

    const body: LeaveRequestDetailResponse = { request: result.request, canDecide: result.canDecide }
    res.json(body)
  } catch (err) {
    handleUnexpected(res, err)
  }
})

leaveRequestsRouter.post('/leave-requests/:id/reject', canDecideAsAdminOrEmployee, async (req: Request, res: Response) => {
  const actor = actorOf(req)
  if (!actor) return fail(res, 500, 'server misconfigured')

  const id = parseId(req.params['id'])
  if (id === null) return fail(res, 400, 'id must be a positive integer')

  const body = req.body as Partial<LeaveRequestRejectRequest> | null
  const reason = requiredString((body ?? {}) as Record<string, unknown>, 'reason', 1000)
  if (reason === null) return fail(res, 400, 'reason is required and must be 1000 characters or fewer')

  try {
    const result = await withTransaction(async (client) => {
      const { rows } = await client.query<{
        status: string
        current_stage: string | null
        supervisor_employee_id: string | null
      }>(
        `SELECT status, current_stage, supervisor_employee_id FROM leave_requests WHERE id = $1 FOR UPDATE`,
        [id]
      )
      const row = rows[0]
      if (!row) return { kind: 'not_found' as const }
      if (row.status !== 'pending') return { kind: 'conflict' as const }

      const approverKind = await resolveLeaveApprover(
        actor,
        {
          status: row.status,
          currentStage: row.current_stage,
          supervisorEmployeeId: row.supervisor_employee_id === null ? null : Number(row.supervisor_employee_id),
        },
        client
      )
      if (approverKind === null) return { kind: 'forbidden' as const }

      const actorInfo = await describeActor(actor, client)
      if (!actorInfo) return { kind: 'forbidden' as const }

      // Terminal either way — unlike approval, a supervisor's reject needs
      // no separate forwarding step: there is nothing left to decide once
      // one link in the chain has said no. decided_by_* names whoever
      // actually made this call, supervisor or HR/Admin.
      await client.query(
        `UPDATE leave_requests
         SET status = 'rejected', current_stage = NULL, decided_by_oid = $2, decided_by_name = $3,
             decided_at = now(), decision_reason = $4, updated_at = now()
         WHERE id = $1`,
        [id, actorInfo.oid, actorInfo.name, reason]
      )

      await recordAudit(client, {
        actor,
        action: 'leave_request.reject',
        entityId: id,
        detail: { reason, decidedAsSupervisor: approverKind === 'supervisor' },
      })

      const request = await findLeaveRequestById(id, client)
      if (!request) throw new Error('re-select of leave_requests returned no row')
      return { kind: 'ok' as const, request, canDecide: false }
    })

    if (result.kind === 'not_found') return fail(res, 404, `no leave request with id ${id}`)
    if (result.kind === 'conflict') return fail(res, 409, 'คำขอนี้ถูกดำเนินการไปแล้ว')
    if (result.kind === 'forbidden') return fail(res, 403, 'คุณไม่มีสิทธิ์ปฏิเสธคำขอนี้', 'FORBIDDEN')

    const responseBody: LeaveRequestDetailResponse = { request: result.request, canDecide: result.canDecide }
    res.json(responseBody)
  } catch (err) {
    handleUnexpected(res, err)
  }
})
