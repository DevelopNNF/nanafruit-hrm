import { randomUUID } from 'crypto'
import { Router } from 'express'
import type { Request, Response } from 'express'
import type pg from 'pg'
import {
  ROLES,
  DAY_OFF_SWAP_REQUEST_STATUSES,
  type AuthUser,
  type DayOffSwapRequestBatchActionResponse,
  type DayOffSwapRequestBatchDecisionOutcome,
  type DayOffSwapRequestBatchResponse,
  type DayOffSwapRequestBulkCreateOutcome,
  type DayOffSwapRequestBulkCreateResponse,
  type DayOffSwapRequestBulkInput,
  type DayOffSwapRequestBulkPrecheckOutcome,
  type DayOffSwapRequestDetailResponse,
  type DayOffSwapRequestEligibleEmployeesResponse,
  type DayOffSwapRequestInput,
  type DayOffSwapRequestListResponse,
  type DayOffSwapRequestPendingApprovalResponse,
  type DayOffSwapRequestMineResponse,
  type DayOffSwapRequestRejectRequest,
  type DayOffSwapRequestResponse,
  type DayOffSwapRequestStage,
  type DayOffSwapRequestStatus,
} from '@hrm/shared'
import { pool, withTransaction } from '../db.js'
import { requireRole, requireRoleOrEmployee } from '../auth/middleware.js'
import { recordAudit } from '../audit.js'
import { fail, handleUnexpected, parseOptionalPositiveInt, parseOptionalPositiveIntArray } from '../http.js'
import {
  describeActor,
  findEmployeeById,
  findEmployeeIdByEntraUpn,
  listActiveEmployeesInScope,
} from '../employeeQueries.js'
import { notify } from '../notifications/dispatch.js'
import { getShiftIdForDate, toThailandDateString } from '../shiftAssignmentQueries.js'
import { buildCalendarDaysForDates } from '../calendarQueries.js'
import { narrowToScope, resolveSupervisorScope, scopeAllows } from '../supervisorScope.js'
import {
  SELECT_DAY_OFF_SWAP_REQUEST,
  findDayOffSwapRequestById,
  hasConflictingDayOffSwapRequest,
  listDayOffSwapRequests,
  listDayOffSwapRequestsByBatchId,
  listDayOffSwapRequestsForEmployee,
  listDayOffSwapRequestsPendingApproval,
  rowToDayOffSwapRequest,
  type DayOffSwapRequestRow,
} from '../dayOffSwapRequestQueries.js'
import { hasConflictingShiftChangeRequest } from '../shiftChangeRequestQueries.js'

export const dayOffSwapRequestsRouter = Router()

type Queryable = Pick<pg.Pool, 'query'>

// Any HRM role may look at the review queue. Deciding one is no longer a
// fixed role check — see resolveDayOffSwapApprover, checked per-request once
// current_stage is loaded, same pattern as leaveRequests.ts.
const canReadAdmin = requireRole(...ROLES)
// Approve/reject only: an employee-kind caller (a LIFF supervisor) always
// passes this gate too — resolveDayOffSwapApprover still gates what they may
// actually do once the row is loaded, same as an admin with the wrong role.
const canDecideAsAdminOrEmployee = requireRoleOrEmployee(...ROLES)

function actorOf(req: Request): AuthUser | null {
  return req.auth ?? null
}

type DayOffSwapApproverKind = 'hr' | 'supervisor'

/** Same rule as leaveRequests.ts's resolveLeaveApprover. */
export async function resolveDayOffSwapApprover(
  actor: AuthUser,
  row: { status: string; currentStage: string | null; supervisorEmployeeId: number | null },
  db: Queryable
): Promise<DayOffSwapApproverKind | null> {
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

/** DayOffSwapRequestDetailResponse.canDecide. */
async function computeCanDecide(
  actor: AuthUser | null,
  request: { status: string; currentStage: string | null; supervisorEmployeeId: number | null },
  db: Queryable
): Promise<boolean> {
  if (!actor || request.status !== 'pending') return false
  return (await resolveDayOffSwapApprover(actor, request, db)) !== null
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
 * Structural + reference validation shared by create, edit, and the
 * admin-side bulk request: workDate must currently classify as a day off
 * (holiday or weekly_off) and offDate must currently classify as a plain
 * workday — both derived from buildCalendarDaysForDates, the same cascade
 * the calendar view uses, which already accounts for approved leave and
 * other approved swaps (a date already claimed by another approved swap no
 * longer classifies as 'workday'/'holiday'/'weekly_off', so it fails here
 * for free). Returns a fail() reason rather than calling fail() itself, so
 * every call site can label the 400/409 the same way its own route already
 * does.
 *
 * enforceMinNotice (default true) gates the "≥3 days out" check only — a
 * self-service employee request (POST/PUT) always enforces it, but a bulk
 * request filed by a supervisor/HR/Admin on someone's behalf may pass
 * `false` to allow a more urgent same-week swap, per HR's decision that
 * admin-filed requests don't need the same lead time an employee's own
 * planning does.
 */
async function validateDayOffSwapRequestInput(
  employeeId: number,
  input: DayOffSwapRequestInput,
  excludeId: number | null,
  enforceMinNotice: boolean = true
): Promise<
  | {
      kind: 'ok'
      workDateOriginalStatus: 'holiday' | 'weekly_off'
      workDateOriginalLabel: string | null
      requiresSupervisorApproval: boolean
      supervisorEmployeeId: number | null
      supervisorEmployeeName: string | null
    }
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

  if (enforceMinNotice) {
    const today = toThailandDateString(new Date())
    const minAllowed = addDays(today, 3)
    if (input.workDate < minAllowed || input.offDate < minAllowed) return { kind: 'too-soon' }
  }

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
    requiresSupervisorApproval: employee.employment.supervisorEmployeeId !== null,
    supervisorEmployeeId: employee.employment.supervisorEmployeeId,
    supervisorEmployeeName: employee.employment.supervisorEmployeeName,
  }
}

type DayOffSwapValidationFailure =
  | { kind: 'employee-not-found' }
  | { kind: 'same-date' }
  | { kind: 'too-soon' }
  | { kind: 'work-date-not-off' }
  | { kind: 'off-date-not-workday' }
  | { kind: 'no-shift' }
  | { kind: 'conflict-swap' }
  | { kind: 'conflict-shift-change' }

/** Shared by the single-request routes' validationFail and the bulk-request
 *  precheck, which needs the message but not an HTTP response of its own —
 *  mirrors overtimeRequests.ts's describeValidationOutcome/validationFail
 *  split. */
function describeDayOffSwapValidationFailure(outcome: DayOffSwapValidationFailure): { status: number; message: string } {
  if (outcome.kind === 'employee-not-found') return { status: 404, message: 'employee not found' }
  if (outcome.kind === 'same-date') {
    return { status: 400, message: 'วันทำงานและวันที่ต้องการสลับต้องเป็นคนละวันกัน' }
  }
  if (outcome.kind === 'too-soon') {
    return { status: 400, message: 'ต้องขอสลับวันหยุดล่วงหน้าอย่างน้อย 3 วัน ไม่สามารถขอย้อนหลังหรือกระชั้นชิดได้' }
  }
  if (outcome.kind === 'work-date-not-off') {
    return { status: 400, message: 'วันทำงานที่เลือกต้องเป็นวันหยุด (วันหยุดบริษัทหรือวันหยุดประจำสัปดาห์) ของพนักงานคนนี้เท่านั้น' }
  }
  if (outcome.kind === 'off-date-not-workday') {
    return { status: 400, message: 'วันที่ต้องการสลับต้องเป็นวันทำงานปกติของพนักงานคนนี้เท่านั้น' }
  }
  if (outcome.kind === 'no-shift') {
    return { status: 400, message: 'พนักงานคนนี้ยังไม่มีกะถาวรที่กำหนดไว้ ไม่สามารถระบุกะสำหรับวันทำงานที่ขอได้' }
  }
  if (outcome.kind === 'conflict-swap') {
    return { status: 409, message: 'มีคำขอสลับวันหยุดอื่นสำหรับวันที่นี้ที่ยังรออนุมัติหรืออนุมัติแล้วอยู่แล้ว' }
  }
  return { status: 409, message: 'มีคำขอเปลี่ยนกะสำหรับวันที่นี้ที่ยังรออนุมัติหรืออนุมัติแล้วอยู่แล้ว' }
}

function validationFail(res: Response, outcome: DayOffSwapValidationFailure): void {
  const { status, message } = describeDayOffSwapValidationFailure(outcome)
  fail(res, status, message)
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

    const currentStage: DayOffSwapRequestStage = outcome.requiresSupervisorApproval ? 'supervisor' : 'hr'

    const request = await withTransaction(async (client) => {
      const { rows } = await client.query<{ id: string; created_at: string; updated_at: string }>(
        `INSERT INTO day_off_swap_requests
           (employee_id, work_date, off_date, work_date_original_status, work_date_original_label, reason,
            requires_supervisor_approval, supervisor_employee_id, current_stage)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING id, created_at, updated_at`,
        [
          employeeId,
          input.workDate,
          input.offDate,
          outcome.workDateOriginalStatus,
          outcome.workDateOriginalLabel,
          input.reason,
          outcome.requiresSupervisorApproval,
          outcome.supervisorEmployeeId,
          currentStage,
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

    void notify({
      kind: 'created',
      resource: 'day_off_swap_request',
      requestId: request.id,
      requesterEmployeeId: employeeId,
      supervisorEmployeeId: outcome.supervisorEmployeeId,
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

    // Re-freezes the supervisor snapshot too, and resets any prior supervisor
    // sign-off — same reasoning as overtimeRequests.ts's PUT route.
    const currentStage: DayOffSwapRequestStage = outcome.requiresSupervisorApproval ? 'supervisor' : 'hr'

    const result = await withTransaction(async (client) => {
      const { rows } = await client.query<{
        employee_id: string
        status: string
        supervisor_approved_by_oid: string | null
      }>(
        `SELECT employee_id, status, supervisor_approved_by_oid FROM day_off_swap_requests WHERE id = $1 FOR UPDATE`,
        [id]
      )
      const row = rows[0]
      if (!row) return { kind: 'not_found' as const }
      if (Number(row.employee_id) !== employeeId) return { kind: 'not_found' as const }
      // Blocked once the supervisor has already forwarded it, even though
      // status is still 'pending' — see leaveRequests.ts's cancel route for
      // the full reasoning, which applies unchanged here.
      if (row.status !== 'pending' || row.supervisor_approved_by_oid !== null) {
        return { kind: 'conflict' as const }
      }

      await client.query(
        `UPDATE day_off_swap_requests
         SET work_date = $2, off_date = $3, work_date_original_status = $4,
             work_date_original_label = $5, reason = $6,
             requires_supervisor_approval = $7, supervisor_employee_id = $8, current_stage = $9,
             supervisor_approved_by_oid = NULL, supervisor_approved_by_name = NULL, supervisor_approved_at = NULL,
             updated_at = now()
         WHERE id = $1`,
        [
          id,
          input.workDate,
          input.offDate,
          outcome.workDateOriginalStatus,
          outcome.workDateOriginalLabel,
          input.reason,
          outcome.requiresSupervisorApproval,
          outcome.supervisorEmployeeId,
          currentStage,
        ]
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
      const { rows } = await client.query<{
        employee_id: string
        status: string
        supervisor_employee_id: string | null
        supervisor_approved_by_oid: string | null
      }>(
        `SELECT employee_id, status, supervisor_employee_id, supervisor_approved_by_oid
         FROM day_off_swap_requests WHERE id = $1 FOR UPDATE`,
        [id]
      )
      const row = rows[0]
      if (!row) return { kind: 'not_found' as const }
      if (Number(row.employee_id) !== employeeId) return { kind: 'not_found' as const }
      // Blocked once the supervisor has already forwarded it, even though
      // status is still 'pending' — see this file's PUT route for the full
      // reasoning, which applies unchanged here.
      if (row.status !== 'pending' || row.supervisor_approved_by_oid !== null) {
        return { kind: 'conflict' as const }
      }

      await client.query(
        `UPDATE day_off_swap_requests SET status = 'cancelled', current_stage = NULL, updated_at = now() WHERE id = $1`,
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
      return {
        kind: 'ok' as const,
        request: rowToDayOffSwapRequest(updated),
        supervisorEmployeeId: row.supervisor_employee_id === null ? null : Number(row.supervisor_employee_id),
      }
    })

    if (result.kind === 'not_found') return fail(res, 404, `no day off swap request with id ${id}`)
    if (result.kind === 'conflict') return fail(res, 409, 'คำขอนี้ถูกดำเนินการไปแล้ว ไม่สามารถยกเลิกได้')

    void notify({
      kind: 'cancelled',
      resource: 'day_off_swap_request',
      requestId: id,
      requesterEmployeeId: employeeId,
      supervisorEmployeeId: result.supervisorEmployeeId,
    })

    const body: DayOffSwapRequestResponse = { request: result.request }
    res.json(body)
  } catch (err) {
    handleUnexpected(res, err)
  }
})

dayOffSwapRequestsRouter.get('/day-off-swap-requests', canReadAdmin, async (req: Request, res: Response) => {
  const statusResult = parseStatusFilter(req.query['status'] as string | string[] | undefined)
  if (!statusResult.ok) return fail(res, 400, statusResult.message)

  const page = parseOptionalPositiveInt(req.query['page'])
  if (page === undefined) return fail(res, 400, 'page must be a positive integer')

  const pageSize = parseOptionalPositiveInt(req.query['pageSize'])
  if (pageSize === undefined) return fail(res, 400, 'pageSize must be a positive integer')

  const employeeIds = parseOptionalPositiveIntArray(req.query['employeeId'])
  if (employeeIds === undefined) return fail(res, 400, 'employeeId must be a positive integer')

  const auth = actorOf(req)
  if (!auth) return fail(res, 500, 'server misconfigured')

  try {
    const scope = await resolveSupervisorScope(auth)
    if (scope.kind === 'none') {
      const body: DayOffSwapRequestListResponse = {
        requests: [],
        page: page ?? 1,
        pageSize: pageSize ?? 50,
        total: 0,
      }
      return res.json(body)
    }

    const scopedEmployeeIds = narrowToScope(scope, employeeIds ?? undefined)

    const result = await listDayOffSwapRequests(
      {
        status: statusResult.value,
        ...(scopedEmployeeIds !== undefined && { employeeIds: scopedEmployeeIds }),
      },
      { ...(page !== null && { page }), ...(pageSize !== null && { pageSize }) }
    )
    const body: DayOffSwapRequestListResponse = result
    res.json(body)
  } catch (err) {
    handleUnexpected(res, err)
  }
})

// Who an admin-side caller may file a bulk request for — mirrors GET
// /overtime-requests/bulk/eligible-employees minus the weekly-cap/date logic,
// which has no equivalent here. Mounted ahead of GET
// /day-off-swap-requests/:id so 'eligible-employees' is never parsed as an id.
dayOffSwapRequestsRouter.get('/day-off-swap-requests/eligible-employees', async (req: Request, res: Response) => {
  const auth = actorOf(req)
  if (!auth) return fail(res, 500, 'server misconfigured')

  try {
    const scope = await resolveSupervisorScope(auth)
    if (scope.kind === 'none') {
      return fail(res, 403, 'บัญชีนี้ไม่มีสิทธิ์ขอสลับวันหยุดแทนพนักงาน', 'FORBIDDEN')
    }

    const candidates = await listActiveEmployeesInScope(scope.kind === 'all' ? null : scope.employeeIds)
    const body: DayOffSwapRequestEligibleEmployeesResponse = {
      scope: scope.kind === 'all' ? 'all' : 'team',
      employees: candidates.map((c) => ({
        employeeId: c.id,
        employeeCode: c.employeeCode,
        employeeName: c.employeeName,
        departmentName: c.departmentName,
      })),
    }
    res.json(body)
  } catch (err) {
    handleUnexpected(res, err)
  }
})

// A supervisor's inbox — mirrors GET /leave-requests/pending-approval. Mounted
// ahead of GET /day-off-swap-requests/:id so 'pending-approval' is never
// parsed as an id.
dayOffSwapRequestsRouter.get(
  '/day-off-swap-requests/pending-approval',
  canReadAdmin,
  async (req: Request, res: Response) => {
    const auth = actorOf(req)
    if (!auth) return fail(res, 500, 'server misconfigured')

    try {
      const scope = await resolveSupervisorScope(auth)
      if (scope.kind === 'none') {
        const body: DayOffSwapRequestPendingApprovalResponse = { requests: [] }
        return res.json(body)
      }

      const requests = await listDayOffSwapRequestsPendingApproval(
        scope.kind === 'all' ? null : scope.supervisorEmployeeId
      )
      const body: DayOffSwapRequestPendingApprovalResponse = { requests }
      res.json(body)
    } catch (err) {
      handleUnexpected(res, err)
    }
  }
)

dayOffSwapRequestsRouter.get('/day-off-swap-requests/:id', canReadAdmin, async (req: Request, res: Response) => {
  const id = parseId(req.params['id'])
  if (id === null) return fail(res, 400, 'id must be a positive integer')

  const auth = actorOf(req)
  if (!auth) return fail(res, 500, 'server misconfigured')

  try {
    const request = await findDayOffSwapRequestById(id)
    if (!request) return fail(res, 404, `no day off swap request with id ${id}`)

    const canDecide = await computeCanDecide(auth, request, pool)
    const scope = await resolveSupervisorScope(auth)
    if (!scopeAllows(scope, request.employeeId) && !canDecide) {
      return fail(res, 404, `no day off swap request with id ${id}`)
    }

    const body: DayOffSwapRequestDetailResponse = { request, canDecide }
    res.json(body)
  } catch (err) {
    handleUnexpected(res, err)
  }
})

dayOffSwapRequestsRouter.post(
  '/day-off-swap-requests/:id/approve',
  canDecideAsAdminOrEmployee,
  async (req: Request, res: Response) => {
    const actor = actorOf(req)
    if (!actor) return fail(res, 500, 'server misconfigured')

    const id = parseId(req.params['id'])
    if (id === null) return fail(res, 400, 'id must be a positive integer')

    try {
      const result = await withTransaction(async (client) => {
        const { rows } = await client.query<{
          employee_id: string
          work_date: string
          off_date: string
          status: string
          current_stage: string | null
          supervisor_employee_id: string | null
        }>(
          `SELECT employee_id, work_date, off_date, status, current_stage, supervisor_employee_id
           FROM day_off_swap_requests WHERE id = $1 FOR UPDATE`,
          [id]
        )
        const row = rows[0]
        if (!row) return { kind: 'not_found' as const }
        if (row.status !== 'pending') return { kind: 'conflict' as const, message: 'คำขอนี้ถูกดำเนินการไปแล้ว' }

        const approverKind = await resolveDayOffSwapApprover(
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

        // Re-checked here, not just at submission, for BOTH a forwarding
        // approval and a final one — same reasoning as
        // overtimeRequests.ts's approve route.
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

        if (approverKind === 'supervisor') {
          // Forwarding approval only — the request stays pending, now
          // waiting on HR/Admin.
          await client.query(
            `UPDATE day_off_swap_requests
             SET current_stage = 'hr', supervisor_approved_by_oid = $2,
                 supervisor_approved_by_name = $3, supervisor_approved_at = now(), updated_at = now()
             WHERE id = $1`,
            [id, actorInfo.oid, actorInfo.name]
          )

          await recordAudit(client, {
            actor,
            action: 'day_off_swap_request.supervisor_approve',
            entityId: id,
            detail: {},
          })

          const request = await findDayOffSwapRequestById(id, client)
          if (!request) throw new Error('re-select of day_off_swap_requests returned no row')
          const canDecide = await computeCanDecide(actor, request, client)
          return { kind: 'ok' as const, request, canDecide }
        }

        await client.query(
          `UPDATE day_off_swap_requests
           SET status = 'approved', current_stage = NULL, decided_by_oid = $2, decided_by_name = $3,
               decided_at = now(), updated_at = now()
           WHERE id = $1`,
          [id, actorInfo.oid, actorInfo.name]
        )

        await recordAudit(client, {
          actor,
          action: 'day_off_swap_request.approve',
          entityId: id,
          detail: { employeeId, workDate: row.work_date, offDate: row.off_date },
        })

        const request = await findDayOffSwapRequestById(id, client)
        if (!request) throw new Error('re-select of day_off_swap_requests returned no row')
        return { kind: 'ok' as const, request, canDecide: false }
      })

      if (result.kind === 'not_found') return fail(res, 404, `no day off swap request with id ${id}`)
      if (result.kind === 'forbidden') return fail(res, 403, 'คุณไม่มีสิทธิ์อนุมัติคำขอนี้', 'FORBIDDEN')
      if (result.kind === 'conflict' || result.kind === 'expired' || result.kind === 'drifted' || result.kind === 'no_shift') {
        return fail(res, 409, result.message)
      }

      // status === 'approved' means this was the final decision; anything
      // else ('pending', now at the hr stage) means a supervisor just
      // forwarded it.
      void notify(
        result.request.status === 'approved'
          ? {
              kind: 'approved',
              resource: 'day_off_swap_request',
              requestId: id,
              requesterEmployeeId: result.request.employeeId,
            }
          : {
              kind: 'supervisor_approved',
              resource: 'day_off_swap_request',
              requestId: id,
              requesterEmployeeId: result.request.employeeId,
            }
      )

      const body: DayOffSwapRequestDetailResponse = { request: result.request, canDecide: result.canDecide }
      res.json(body)
    } catch (err) {
      handleUnexpected(res, err)
    }
  }
)

dayOffSwapRequestsRouter.post(
  '/day-off-swap-requests/:id/reject',
  canDecideAsAdminOrEmployee,
  async (req: Request, res: Response) => {
    const actor = actorOf(req)
    if (!actor) return fail(res, 500, 'server misconfigured')

    const id = parseId(req.params['id'])
    if (id === null) return fail(res, 400, 'id must be a positive integer')

    const body = req.body as Partial<DayOffSwapRequestRejectRequest> | null
    const reason = requiredString((body ?? {}) as Record<string, unknown>, 'reason', 1000)
    if (reason === null) return fail(res, 400, 'reason is required and must be 1000 characters or fewer')

    try {
      const result = await withTransaction(async (client) => {
        const { rows } = await client.query<{
          status: string
          current_stage: string | null
          supervisor_employee_id: string | null
        }>(
          `SELECT status, current_stage, supervisor_employee_id FROM day_off_swap_requests WHERE id = $1 FOR UPDATE`,
          [id]
        )
        const row = rows[0]
        if (!row) return { kind: 'not_found' as const }
        if (row.status !== 'pending') return { kind: 'conflict' as const }

        const approverKind = await resolveDayOffSwapApprover(
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

        await client.query(
          `UPDATE day_off_swap_requests
           SET status = 'rejected', current_stage = NULL, decided_by_oid = $2, decided_by_name = $3,
               decided_at = now(), decision_reason = $4, updated_at = now()
           WHERE id = $1`,
          [id, actorInfo.oid, actorInfo.name, reason]
        )

        await recordAudit(client, {
          actor,
          action: 'day_off_swap_request.reject',
          entityId: id,
          detail: { reason, decidedAsSupervisor: approverKind === 'supervisor' },
        })

        const request = await findDayOffSwapRequestById(id, client)
        if (!request) throw new Error('re-select of day_off_swap_requests returned no row')
        return { kind: 'ok' as const, request, canDecide: false }
      })

      if (result.kind === 'not_found') return fail(res, 404, `no day off swap request with id ${id}`)
      if (result.kind === 'conflict') return fail(res, 409, 'คำขอนี้ถูกดำเนินการไปแล้ว')
      if (result.kind === 'forbidden') return fail(res, 403, 'คุณไม่มีสิทธิ์ปฏิเสธคำขอนี้', 'FORBIDDEN')

      void notify({
        kind: 'rejected',
        resource: 'day_off_swap_request',
        requestId: id,
        requesterEmployeeId: result.request.employeeId,
        reason,
      })

      const responseBody: DayOffSwapRequestDetailResponse = { request: result.request, canDecide: result.canDecide }
      res.json(responseBody)
    } catch (err) {
      handleUnexpected(res, err)
    }
  }
)

// --- Bulk Day Off Swap Request ("ขอสลับวันหยุดแบบกลุ่ม") -------------------
// A supervisor/HR/Admin filing the same work_date/off_date pair for several
// employees at once from admin/. Every employee still gets an independent
// day_off_swap_requests row (see migration 083's comment — a date pair can
// legitimately classify differently per employee), tagged with a shared
// batch_id purely so the admin list/detail screens can show and act on the
// group as one unit. Mirrors Bulk OT Request (routes/overtimeRequests.ts)
// almost exactly.

function parseDayOffSwapBulkInput(body: unknown): ParseResult<DayOffSwapRequestBulkInput> {
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

  const employeeIdsRaw = raw['employeeIds']
  if (!Array.isArray(employeeIdsRaw) || employeeIdsRaw.length === 0) {
    return { ok: false, message: 'employeeIds must be a non-empty array' }
  }
  const employeeIds: number[] = []
  const seenEmployeeIds = new Set<number>()
  for (const item of employeeIdsRaw) {
    if (typeof item !== 'number' || !Number.isInteger(item) || item <= 0) {
      return { ok: false, message: 'employeeIds must contain only positive integers' }
    }
    if (!seenEmployeeIds.has(item)) {
      seenEmployeeIds.add(item)
      employeeIds.push(item)
    }
  }

  return { ok: true, value: { workDate: workDateRaw, offDate: offDateRaw, reason, employeeIds } }
}

// All-or-nothing: every employeeId is validated first, against plain pool
// queries (nothing written yet), and only if every one of them passes does a
// second pass actually insert the rows — one shared batch_id, all in one
// transaction. See Bulk OT Request's identical comment for why this is
// all-or-nothing rather than silently skipping whoever fails.
dayOffSwapRequestsRouter.post('/day-off-swap-requests/bulk', async (req: Request, res: Response) => {
  const actor = actorOf(req)
  if (!actor || actor.kind !== 'admin') return fail(res, 500, 'server misconfigured')

  const parsed = parseDayOffSwapBulkInput(req.body)
  if (!parsed.ok) return fail(res, 400, parsed.message)
  const input = parsed.value

  try {
    const scope = await resolveSupervisorScope(actor)
    if (scope.kind === 'none') {
      return fail(res, 403, 'บัญชีนี้ไม่มีสิทธิ์ขอสลับวันหยุดแทนพนักงาน', 'FORBIDDEN')
    }

    // Pass 1: validate every employee against live data, nothing written yet.
    // Keeps each passing employee's snapshot so pass 2 doesn't have to
    // validate a second time.
    const precheckOutcomes: DayOffSwapRequestBulkPrecheckOutcome[] = []
    const passingSnapshots = new Map<
      number,
      { workDateOriginalStatus: 'holiday' | 'weekly_off'; workDateOriginalLabel: string | null }
    >()
    for (const employeeId of input.employeeIds) {
      // Re-checked against the server-resolved scope, not the client's
      // say-so — a supervisor's picker is pre-filtered to their own team, but
      // nothing stops a hand-built request naming someone else's employeeId.
      if (!scopeAllows(scope, employeeId)) {
        precheckOutcomes.push({
          employeeId,
          kind: 'invalid',
          message: 'พนักงานคนนี้ไม่อยู่ในสิทธิ์ของผู้ขอ',
        })
        continue
      }

      // enforceMinNotice = false: an admin-filed swap may be more urgent than
      // the 3-day lead time a self-service request requires — see HR's
      // decision in validateDayOffSwapRequestInput's own comment.
      const outcome = await validateDayOffSwapRequestInput(
        employeeId,
        { workDate: input.workDate, offDate: input.offDate, reason: input.reason },
        null,
        false
      )
      if (outcome.kind !== 'ok') {
        precheckOutcomes.push({
          employeeId,
          kind: 'invalid',
          message: describeDayOffSwapValidationFailure(outcome).message,
        })
        continue
      }
      passingSnapshots.set(employeeId, {
        workDateOriginalStatus: outcome.workDateOriginalStatus,
        workDateOriginalLabel: outcome.workDateOriginalLabel,
      })
      precheckOutcomes.push({ employeeId, kind: 'ok' })
    }

    if (precheckOutcomes.some((o) => o.kind === 'invalid')) {
      const body: DayOffSwapRequestBulkCreateResponse = { blocked: true, outcomes: precheckOutcomes }
      return res.json(body)
    }

    const batchId = randomUUID()

    // Resolved once for the whole batch, not per employee: this request is
    // filed BY the caller ON BEHALF OF everyone in employeeIds, so the
    // approval chain follows the caller's own supervisor (their boss), not
    // each employee's — which is usually the caller themselves, and routing
    // it back to them would be a self-approval loop. No employee record for
    // the caller (an HR/Admin account with none) is the same as no
    // supervisor: straight to the HR/Admin stage. Same reasoning as Bulk OT
    // Request's batch-level resolution.
    const callerEmployeeId = await findEmployeeIdByEntraUpn(actor.upn)
    const callerEmployee = callerEmployeeId !== null ? await findEmployeeById(callerEmployeeId) : null
    const batchSupervisorEmployeeId = callerEmployee?.employment.supervisorEmployeeId ?? null
    const batchRequiresSupervisorApproval = batchSupervisorEmployeeId !== null
    const batchCurrentStage: DayOffSwapRequestStage = batchRequiresSupervisorApproval ? 'supervisor' : 'hr'

    // Pass 2: every employee already passed pass 1, so this is now expected
    // to succeed for all of them. If anything here does fail (a genuine race
    // between the two passes, or an unexpected DB error), the whole
    // transaction rolls back rather than silently creating a partial batch.
    const outcomes = await withTransaction(async (client) => {
      const results: DayOffSwapRequestBulkCreateOutcome[] = []
      for (const employeeId of input.employeeIds) {
        const snapshot = passingSnapshots.get(employeeId)
        if (!snapshot) throw new Error(`no snapshot recorded for employee ${employeeId}`)

        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO day_off_swap_requests
             (employee_id, work_date, off_date, work_date_original_status, work_date_original_label, reason,
              requires_supervisor_approval, supervisor_employee_id, current_stage,
              batch_id, created_by_oid, created_by_name)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
           RETURNING id`,
          [
            employeeId,
            input.workDate,
            input.offDate,
            snapshot.workDateOriginalStatus,
            snapshot.workDateOriginalLabel,
            input.reason,
            // The batch-level resolution from above, not the outcome's own
            // requiresSupervisorApproval/supervisorEmployeeId — those are
            // this employee's own supervisor, which is the wrong chain for a
            // request filed on their behalf. See this route's comment above
            // the batch resolution.
            batchRequiresSupervisorApproval,
            batchSupervisorEmployeeId,
            batchCurrentStage,
            batchId,
            actor.oid,
            actor.name,
          ]
        )
        const created = rows[0]
        if (!created) throw new Error('insert into day_off_swap_requests returned no row')

        await recordAudit(client, {
          actor,
          action: 'day_off_swap_request.bulk_create',
          entityId: Number(created.id),
          detail: { employeeId, workDate: input.workDate, offDate: input.offDate, batchId },
        })

        results.push({ employeeId, kind: 'ok', requestId: Number(created.id) })
      }
      return results
    })

    // No 'created' notification here — same as Bulk OT Request: a batch can
    // span many employees/supervisors, and there is no single recipient a
    // "day_off_swap_request.created" event is meant for.
    const body: DayOffSwapRequestBulkCreateResponse = { blocked: false, batchId, outcomes }
    res.status(201).json(body)
  } catch (err) {
    handleUnexpected(res, err)
  }
})

// Every row one Bulk Day Off Swap Request submission created, for the batch
// detail screen. canReadAdmin, same as GET /day-off-swap-requests/:id:
// viewing is open to all four roles, deciding is not.
dayOffSwapRequestsRouter.get(
  '/day-off-swap-requests/batch/:batchId',
  canReadAdmin,
  async (req: Request, res: Response) => {
    const batchId = req.params['batchId']
    if (typeof batchId !== 'string' || batchId === '') return fail(res, 400, 'batchId is required')

    try {
      const requests = await listDayOffSwapRequestsByBatchId(batchId)
      if (requests.length === 0) return fail(res, 404, `no batch with id ${batchId}`)

      // Every pending row in one batch shares the same supervisor_employee_id
      // (resolved once from the filer, see the bulk-create route), so
      // checking the first one still pending stands in for the whole batch.
      const firstPending = requests.find((r) => r.status === 'pending')
      const canDecideBatch =
        firstPending !== undefined ? await computeCanDecide(actorOf(req), firstPending, pool) : false

      const body: DayOffSwapRequestBatchResponse = { requests, canDecideBatch }
      res.json(body)
    } catch (err) {
      handleUnexpected(res, err)
    }
  }
)

// Approves every still-pending row of a batch with one click, so a reviewer
// is not clicking "approve" once per employee for a submission that was
// really one decision. Each row still goes through its own SAVEPOINT and its
// own live re-validation (buildCalendarDaysForDates + getShiftIdForDate, same
// as single approve) — one employee's calendar having drifted since filing
// does not block the rest of the group, it just leaves that one row pending,
// 'stale', for the reviewer to look at individually afterwards through the
// ordinary single-request detail page.
dayOffSwapRequestsRouter.post(
  '/day-off-swap-requests/batch/:batchId/approve',
  canReadAdmin,
  async (req: Request, res: Response) => {
    const actor = actorOf(req)
    if (!actor) return fail(res, 500, 'server misconfigured')

    const batchId = req.params['batchId']
    if (typeof batchId !== 'string' || batchId === '') return fail(res, 400, 'batchId is required')

    try {
      const pendingRows = await pool.query<{
        id: string
        employee_id: string
        current_stage: string | null
        supervisor_employee_id: string | null
      }>(
        `SELECT id, employee_id, current_stage, supervisor_employee_id
         FROM day_off_swap_requests WHERE batch_id = $1 AND status = 'pending'`,
        [batchId]
      )
      if (pendingRows.rows.length === 0) return fail(res, 404, `no pending requests in batch ${batchId}`)

      // Checked once against the batch's first pending row rather than per
      // row inside the loop: every row in one batch shares the same
      // supervisor_employee_id (resolved once from the filer, not per
      // employee), so this is representative of the whole batch and gives a
      // clean top-level 403 instead of a batch of individually-forbidden
      // outcomes.
      const first = pendingRows.rows[0]
      if (!first) throw new Error('pendingRows.rows was non-empty but has no first element')
      const approverKind = await resolveDayOffSwapApprover(
        actor,
        {
          status: 'pending',
          currentStage: first.current_stage,
          supervisorEmployeeId: first.supervisor_employee_id === null ? null : Number(first.supervisor_employee_id),
        },
        pool
      )
      if (approverKind === null) return fail(res, 403, 'คุณไม่มีสิทธิ์อนุมัติคำขอกลุ่มนี้', 'FORBIDDEN')

      const actorInfo = await describeActor(actor, pool)
      if (!actorInfo) return fail(res, 403, 'คุณไม่มีสิทธิ์อนุมัติคำขอกลุ่มนี้', 'FORBIDDEN')

      const outcomes = await withTransaction(async (client) => {
        const results: DayOffSwapRequestBatchDecisionOutcome[] = []
        for (const { id: idText, employee_id: employeeIdText } of pendingRows.rows) {
          const id = Number(idText)
          const employeeId = Number(employeeIdText)
          await client.query('SAVEPOINT batch_day_off_swap_approve')
          try {
            const { rows } = await client.query<{ work_date: string; off_date: string; status: string }>(
              `SELECT work_date, off_date, status FROM day_off_swap_requests WHERE id = $1 FOR UPDATE`,
              [id]
            )
            const row = rows[0]
            if (!row) throw new Error(`day off swap request ${id} vanished mid-batch`)
            if (row.status !== 'pending') {
              results.push({ requestId: id, employeeId, kind: 'stale', message: 'คำขอนี้ถูกดำเนินการไปแล้ว' })
              await client.query('RELEASE SAVEPOINT batch_day_off_swap_approve')
              continue
            }

            // Same live re-validation as the single-request approve route —
            // see its own comment for why the row's own snapshot isn't
            // enough.
            const today = toThailandDateString(new Date())
            if (row.work_date < today || row.off_date < today) {
              results.push({
                requestId: id,
                employeeId,
                kind: 'stale',
                message: 'วันที่ขอสลับผ่านไปแล้ว ไม่สามารถอนุมัติได้',
              })
              await client.query('RELEASE SAVEPOINT batch_day_off_swap_approve')
              continue
            }
            const [workDay, offDay] = await buildCalendarDaysForDates(
              employeeId,
              [row.work_date, row.off_date],
              client
            )
            const workOk = workDay && (workDay.status === 'holiday' || workDay.status === 'weekly_off')
            const offOk = offDay && offDay.status === 'workday'
            if (!workOk || !offOk) {
              results.push({
                requestId: id,
                employeeId,
                kind: 'stale',
                message: 'ข้อมูลวันหยุด/กะการทำงานของพนักงานเปลี่ยนไปตั้งแต่ยื่นคำขอ',
              })
              await client.query('RELEASE SAVEPOINT batch_day_off_swap_approve')
              continue
            }
            if ((await getShiftIdForDate(employeeId, row.work_date, client)) === null) {
              results.push({
                requestId: id,
                employeeId,
                kind: 'stale',
                message: 'พนักงานคนนี้ยังไม่มีกะถาวรที่กำหนดไว้',
              })
              await client.query('RELEASE SAVEPOINT batch_day_off_swap_approve')
              continue
            }

            if (approverKind === 'supervisor') {
              await client.query(
                `UPDATE day_off_swap_requests
                 SET current_stage = 'hr', supervisor_approved_by_oid = $2,
                     supervisor_approved_by_name = $3, supervisor_approved_at = now(), updated_at = now()
                 WHERE id = $1`,
                [id, actorInfo.oid, actorInfo.name]
              )

              await recordAudit(client, {
                actor,
                action: 'day_off_swap_request.supervisor_approve',
                entityId: id,
                detail: { batchId },
              })

              results.push({ requestId: id, employeeId, kind: 'ok' })
              await client.query('RELEASE SAVEPOINT batch_day_off_swap_approve')
              continue
            }

            await client.query(
              `UPDATE day_off_swap_requests
               SET status = 'approved', current_stage = NULL, decided_by_oid = $2, decided_by_name = $3,
                   decided_at = now(), updated_at = now()
               WHERE id = $1`,
              [id, actorInfo.oid, actorInfo.name]
            )

            await recordAudit(client, {
              actor,
              action: 'day_off_swap_request.approve',
              entityId: id,
              detail: { employeeId, workDate: row.work_date, offDate: row.off_date, batchId },
            })

            results.push({ requestId: id, employeeId, kind: 'ok' })
            await client.query('RELEASE SAVEPOINT batch_day_off_swap_approve')
          } catch (err) {
            await client.query('ROLLBACK TO SAVEPOINT batch_day_off_swap_approve')
            results.push({
              requestId: id,
              employeeId,
              kind: 'stale',
              message: err instanceof Error ? err.message : 'unexpected error',
            })
          }
        }
        return results
      })

      const body: DayOffSwapRequestBatchActionResponse = { outcomes }
      res.json(body)
    } catch (err) {
      handleUnexpected(res, err)
    }
  }
)

// Rejects every still-pending row of a batch with one click and one shared
// reason — the batch-detail mirror of POST /day-off-swap-requests/:id/reject.
dayOffSwapRequestsRouter.post(
  '/day-off-swap-requests/batch/:batchId/reject',
  canReadAdmin,
  async (req: Request, res: Response) => {
    const actor = actorOf(req)
    if (!actor) return fail(res, 500, 'server misconfigured')

    const batchId = req.params['batchId']
    if (typeof batchId !== 'string' || batchId === '') return fail(res, 400, 'batchId is required')

    const body = req.body as Partial<DayOffSwapRequestRejectRequest> | null
    const reason = requiredString((body ?? {}) as Record<string, unknown>, 'reason', 1000)
    if (reason === null) return fail(res, 400, 'reason is required and must be 1000 characters or fewer')

    try {
      const pendingRows = await pool.query<{
        id: string
        employee_id: string
        current_stage: string | null
        supervisor_employee_id: string | null
      }>(
        `SELECT id, employee_id, current_stage, supervisor_employee_id
         FROM day_off_swap_requests WHERE batch_id = $1 AND status = 'pending'`,
        [batchId]
      )
      if (pendingRows.rows.length === 0) return fail(res, 404, `no pending requests in batch ${batchId}`)

      // Same one-check-for-the-whole-batch reasoning as the approve route.
      const first = pendingRows.rows[0]
      if (!first) throw new Error('pendingRows.rows was non-empty but has no first element')
      const approverKind = await resolveDayOffSwapApprover(
        actor,
        {
          status: 'pending',
          currentStage: first.current_stage,
          supervisorEmployeeId: first.supervisor_employee_id === null ? null : Number(first.supervisor_employee_id),
        },
        pool
      )
      if (approverKind === null) return fail(res, 403, 'คุณไม่มีสิทธิ์ปฏิเสธคำขอกลุ่มนี้', 'FORBIDDEN')

      const actorInfo = await describeActor(actor, pool)
      if (!actorInfo) return fail(res, 403, 'คุณไม่มีสิทธิ์ปฏิเสธคำขอกลุ่มนี้', 'FORBIDDEN')

      const outcomes = await withTransaction(async (client) => {
        const results: DayOffSwapRequestBatchDecisionOutcome[] = []
        for (const { id: idText, employee_id: employeeIdText } of pendingRows.rows) {
          const id = Number(idText)
          const employeeId = Number(employeeIdText)
          await client.query('SAVEPOINT batch_day_off_swap_reject')
          try {
            const { rows } = await client.query<{ status: string }>(
              `SELECT status FROM day_off_swap_requests WHERE id = $1 FOR UPDATE`,
              [id]
            )
            const row = rows[0]
            if (!row) throw new Error(`day off swap request ${id} vanished mid-batch`)
            if (row.status !== 'pending') {
              results.push({ requestId: id, employeeId, kind: 'stale', message: 'คำขอนี้ถูกดำเนินการไปแล้ว' })
              await client.query('RELEASE SAVEPOINT batch_day_off_swap_reject')
              continue
            }

            await client.query(
              `UPDATE day_off_swap_requests
               SET status = 'rejected', current_stage = NULL, decided_by_oid = $2, decided_by_name = $3,
                   decided_at = now(), decision_reason = $4, updated_at = now()
               WHERE id = $1`,
              [id, actorInfo.oid, actorInfo.name, reason]
            )

            await recordAudit(client, {
              actor,
              action: 'day_off_swap_request.reject',
              entityId: id,
              detail: { reason, batchId, decidedAsSupervisor: approverKind === 'supervisor' },
            })

            results.push({ requestId: id, employeeId, kind: 'ok' })
            await client.query('RELEASE SAVEPOINT batch_day_off_swap_reject')
          } catch (err) {
            await client.query('ROLLBACK TO SAVEPOINT batch_day_off_swap_reject')
            results.push({
              requestId: id,
              employeeId,
              kind: 'stale',
              message: err instanceof Error ? err.message : 'unexpected error',
            })
          }
        }
        return results
      })

      const body: DayOffSwapRequestBatchActionResponse = { outcomes }
      res.json(body)
    } catch (err) {
      handleUnexpected(res, err)
    }
  }
)
