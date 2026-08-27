import { Router } from 'express'
import type { Request, Response } from 'express'
import { randomUUID } from 'node:crypto'
import {
  OVERTIME_BACKDATE_LIMIT_DAYS,
  OVERTIME_MAX_MINUTES,
  OVERTIME_MIN_MINUTES,
  OVERTIME_REQUEST_STATUSES,
  OVERTIME_WEEKLY_CAP_MINUTES,
  ROLES,
  computeOvertimeMinutes,
  findOvertimeShiftConflict,
  parseWallClockMinutes,
  type AuthUser,
  type CalendarDay,
  type OvertimeBatchActionResponse,
  type OvertimeBatchDecisionOutcome,
  type OvertimeBatchResponse,
  type OvertimeBulkCreateOutcome,
  type OvertimeBulkCreateResponse,
  type OvertimeBulkRequestInput,
  type OvertimeEligibleEmployeesResponse,
  type OvertimeRequestDetailResponse,
  type OvertimeRequestInput,
  type OvertimeRequestListResponse,
  type OvertimeRequestPendingApprovalResponse,
  type OvertimeRequestMineResponse,
  type OvertimeRequestRejectRequest,
  type OvertimeRequestResponse,
  type OvertimeRequestStage,
  type OvertimeRequestStatus,
  type OvertimeWeeklyCapResponse,
} from '@hrm/shared'
import type pg from 'pg'
import { pool, withTransaction } from '../db.js'
import { requireRole, requireRoleOrEmployee } from '../auth/middleware.js'
import { recordAudit } from '../audit.js'
import { fail, handleUnexpected, parseOptionalPositiveInt } from '../http.js'
import {
  describeActor,
  findEmployeeById,
  findEmployeeIdByEntraUpn,
  listActiveEmployeesForBulkOt,
} from '../employeeQueries.js'
import { notify } from '../notifications/dispatch.js'
import { resolveSupervisorScope, scopeAllows } from '../supervisorScope.js'
import { addDays, toThailandDateString } from '../shiftAssignmentQueries.js'
import { buildCalendarDaysForDates } from '../calendarQueries.js'
import { recomputeAttendanceDaily } from '../attendanceDailyQueries.js'
import {
  approvedOvertimeMinutesInWeek,
  approvedOvertimeMinutesInWeekBulk,
} from '../overtimeReportQueries.js'
import {
  SELECT_OVERTIME_REQUEST,
  findOvertimeRequestById,
  hasOverlappingOvertimeRequest,
  listOvertimeRequests,
  listOvertimeRequestsByBatchId,
  listOvertimeRequestsForEmployee,
  listOvertimeRequestsPendingApproval,
  rowToOvertimeRequest,
  type OvertimeRequestRow,
} from '../overtimeRequestQueries.js'

export const overtimeRequestsRouter = Router()

type Queryable = Pick<pg.Pool, 'query'>

// Any HRM role may look at the review queue. Deciding one is no longer a
// fixed role check — see resolveOvertimeApprover, checked per-request (or,
// for a batch, once against its first pending row, since every row in one
// batch shares the same supervisor_employee_id) once current_stage is loaded.
const canReadAdmin = requireRole(...ROLES)
// Approve/reject only: an employee-kind caller (a LIFF supervisor) always
// passes this gate too — resolveOvertimeApprover still gates what they may
// actually do once the row is loaded, same as an admin with the wrong role.
const canDecideAsAdminOrEmployee = requireRoleOrEmployee(...ROLES)

function actorOf(req: Request): AuthUser | null {
  return req.auth ?? null
}

type OvertimeApproverKind = 'hr' | 'supervisor'

/** Who, if anyone, may decide this request right now — same rule as
 *  leaveRequests.ts's resolveLeaveApprover: HR/Admin always, at any stage;
 *  anyone else only while pending at the 'supervisor' stage and only if they
 *  are the snapshotted supervisor_employee_id. */
export async function resolveOvertimeApprover(
  actor: AuthUser,
  row: { status: string; currentStage: string | null; supervisorEmployeeId: number | null },
  db: Queryable
): Promise<OvertimeApproverKind | null> {
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

/** OvertimeRequestDetailResponse.canDecide. */
async function computeCanDecide(
  actor: AuthUser | null,
  request: { status: string; currentStage: string | null; supervisorEmployeeId: number | null },
  db: Queryable
): Promise<boolean> {
  if (!actor || request.status !== 'pending') return false
  return (await resolveOvertimeApprover(actor, request, db)) !== null
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

/** Same fields as parseOvertimeRequestInput plus employeeIds — POST
 *  /overtime-requests/bulk applies one otDate/startTime/endTime/reason to
 *  every id in the array. Duplicate ids are silently collapsed rather than
 *  rejected: a picker built on a Set (TransferList's selection) cannot
 *  produce them, but a hand-built request could, and there is nothing wrong
 *  with the caller meaning to file the same request for the same person once. */
function parseOvertimeBulkRequestInput(body: unknown): ParseResult<OvertimeBulkRequestInput> {
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

  return { ok: true, value: { otDate: otDateRaw, startTime, endTime, reason, employeeIds } }
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
  /** The requesting employee's own supervisor, at submission/edit time — see
   *  the migration's comment. A Bulk OT Request row overrides this with the
   *  filer's own supervisor instead (resolved once per batch, not here),
   *  since every employee's own supervisor is usually the filer themselves. */
  requiresSupervisorApproval: boolean
  supervisorEmployeeId: number | null
  supervisorEmployeeName: string | null
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
      requiresSupervisorApproval: employee.employment.supervisorEmployeeId !== null,
      supervisorEmployeeId: employee.employment.supervisorEmployeeId,
      supervisorEmployeeName: employee.employment.supervisorEmployeeName,
    },
  }
}

/** The message half of validationFail, pulled out so the bulk-create endpoint
 *  can reuse the same wording for a per-employee 'skipped' outcome without
 *  writing an HTTP response for it — a bulk submission has no single status
 *  code to fail with when some employees pass and some don't. */
function describeValidationOutcome(outcome: Exclude<ValidationOutcome, { kind: 'ok' }>): {
  status: number
  message: string
} {
  if (outcome.kind === 'employee-not-found') return { status: 404, message: 'employee not found' }
  if (outcome.kind === 'no-overtime-group') {
    return {
      status: 400,
      message: 'ยังไม่ได้กำหนดกลุ่มการทำงานล่วงเวลาให้พนักงานคนนี้ จึงยังคำนวณค่า OT ไม่ได้ กรุณาติดต่อ HR',
    }
  }
  if (outcome.kind === 'too-short') {
    return { status: 400, message: `ช่วงเวลาที่ขอต้องยาวอย่างน้อย ${OVERTIME_MIN_MINUTES} นาที` }
  }
  if (outcome.kind === 'too-long') {
    return {
      status: 400,
      message: `ช่วงเวลาที่ขอต้องไม่เกิน ${OVERTIME_MAX_MINUTES / 60} ชั่วโมงต่อหนึ่งคำขอ กรุณาตรวจสอบเวลาเริ่มและเวลาสิ้นสุดอีกครั้ง`,
    }
  }
  if (outcome.kind === 'backdated') {
    return {
      status: 400,
      message: `ขอ OT ย้อนหลังได้ไม่เกิน ${OVERTIME_BACKDATE_LIMIT_DAYS} วัน หากเลยกำหนดแล้วกรุณาติดต่อ HR`,
    }
  }
  if (outcome.kind === 'before-hire') {
    return { status: 400, message: 'otDate ต้องไม่ก่อนวันที่เริ่มงาน' }
  }
  if (outcome.kind === 'on-leave') {
    return { status: 400, message: 'วันที่เลือกเป็นวันลาที่อนุมัติแล้ว ไม่สามารถขอ OT ได้' }
  }
  if (outcome.kind === 'shift-conflict') {
    const { day } = outcome
    return {
      status: 400,
      message: `ช่วงเวลาที่ขอทับกับเวลาทำงานปกติ (${day.shiftName ?? 'กะ'} ${hhmm(day.shiftStartTime ?? '')}-${hhmm(day.shiftEndTime ?? '')} ของวันที่ ${formatThaiDate(day.date)}) กรุณาเลือกช่วงเวลานอกเวลาทำงาน`,
    }
  }
  // outcome.kind === 'overlap'
  return { status: 409, message: 'ช่วงเวลาที่ขอทับกับคำขอ OT อื่นที่ยังรออนุมัติหรืออนุมัติแล้ว' }
}

function validationFail(res: Response, outcome: Exclude<ValidationOutcome, { kind: 'ok' }>): void {
  const { status, message } = describeValidationOutcome(outcome)
  fail(res, status, message)
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

    const currentStage: OvertimeRequestStage = snapshot.requiresSupervisorApproval ? 'supervisor' : 'hr'

    const request = await withTransaction(async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO overtime_requests
           (employee_id, ot_date, start_time, end_time, requested_minutes,
            day_status, day_label, shift_id, shift_start_time, shift_end_time,
            overtime_group_id, reason,
            requires_supervisor_approval, supervisor_employee_id, current_stage)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
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
          snapshot.requiresSupervisorApproval,
          snapshot.supervisorEmployeeId,
          currentStage,
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

    void notify({
      kind: 'created',
      resource: 'overtime_request',
      requestId: request.id,
      requesterEmployeeId: employeeId,
      supervisorEmployeeId: snapshot.supervisorEmployeeId,
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
      const { rows } = await client.query<{
        employee_id: string
        status: string
        supervisor_approved_by_oid: string | null
      }>(
        `SELECT employee_id, status, supervisor_approved_by_oid FROM overtime_requests WHERE id = $1 FOR UPDATE`,
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

      // Re-freezes the supervisor snapshot too, same as every other column
      // here — an edit re-derives everything fresh from current data, so a
      // supervisor assigned (or removed) after the original submission is
      // picked up by the next edit. Any prior supervisor sign-off is reset
      // along with it below: the thing they signed off on (this date/time)
      // no longer exists once edited, so starting the approval over from
      // 'supervisor' (or 'hr', if there's no supervisor at all) is the
      // honest choice rather than carrying a decision made on stale details.
      const currentStage: OvertimeRequestStage = snapshot.requiresSupervisorApproval ? 'supervisor' : 'hr'

      await client.query(
        `UPDATE overtime_requests
         SET ot_date = $2, start_time = $3, end_time = $4, requested_minutes = $5,
             day_status = $6, day_label = $7, shift_id = $8,
             shift_start_time = $9, shift_end_time = $10,
             overtime_group_id = $11, reason = $12,
             requires_supervisor_approval = $13, supervisor_employee_id = $14, current_stage = $15,
             supervisor_approved_by_oid = NULL, supervisor_approved_by_name = NULL, supervisor_approved_at = NULL,
             updated_at = now()
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
          snapshot.requiresSupervisorApproval,
          snapshot.supervisorEmployeeId,
          currentStage,
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
      const { rows } = await client.query<{
        employee_id: string
        status: string
        supervisor_employee_id: string | null
        supervisor_approved_by_oid: string | null
      }>(
        `SELECT employee_id, status, supervisor_employee_id, supervisor_approved_by_oid
         FROM overtime_requests WHERE id = $1 FOR UPDATE`,
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
        `UPDATE overtime_requests SET status = 'cancelled', current_stage = NULL, updated_at = now() WHERE id = $1`,
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
      return {
        kind: 'ok' as const,
        request: rowToOvertimeRequest(updated),
        supervisorEmployeeId: row.supervisor_employee_id === null ? null : Number(row.supervisor_employee_id),
      }
    })

    if (result.kind === 'not_found') return fail(res, 404, `no overtime request with id ${id}`)
    if (result.kind === 'conflict') {
      return fail(res, 409, 'คำขอนี้ถูกดำเนินการไปแล้ว ไม่สามารถยกเลิกได้')
    }

    void notify({
      kind: 'cancelled',
      resource: 'overtime_request',
      requestId: id,
      requesterEmployeeId: employeeId,
      supervisorEmployeeId: result.supervisorEmployeeId,
    })

    const body: OvertimeRequestResponse = { request: result.request }
    res.json(body)
  } catch (err) {
    handleUnexpected(res, err)
  }
})

// --- Bulk OT Request ("การขอล่วงเวลาแบบกลุ่ม") ----------------------------
// A supervisor/HR/Admin filing the same OT window for several employees at
// once from admin/. Every employee still gets an independent
// overtime_requests row with its own day/shift snapshot (see
// validateOvertimeRequestInput — it can differ per employee on the same
// calendar date), tagged with a shared batch_id purely so the admin list/
// detail screens can show and act on the group as one unit. See
// resolveSupervisorScope above for who may reach these two routes and for whom.

overtimeRequestsRouter.get(
  '/overtime-requests/bulk/eligible-employees',
  async (req: Request, res: Response) => {
    const auth = actorOf(req)
    if (!auth) return fail(res, 500, 'server misconfigured')

    const dateRaw = req.query['date']
    if (typeof dateRaw !== 'string' || !isCalendarDate(dateRaw)) {
      return fail(res, 400, 'date is required and must be a date as YYYY-MM-DD')
    }

    try {
      const scope = await resolveSupervisorScope(auth)
      if (scope.kind === 'none') {
        return fail(res, 403, 'บัญชีนี้ไม่มีสิทธิ์ขอ OT แบบกลุ่ม', 'FORBIDDEN')
      }

      const candidates = await listActiveEmployeesForBulkOt(
        scope.kind === 'all' ? null : scope.employeeIds
      )
      const { weekStart, weekEnd, minutesByEmployeeId } = await approvedOvertimeMinutesInWeekBulk(
        candidates.map((c) => c.id),
        dateRaw
      )

      const body: OvertimeEligibleEmployeesResponse = {
        scope: scope.kind === 'all' ? 'all' : 'team',
        employees: candidates.map((c) => ({
          employeeId: c.id,
          employeeCode: c.employeeCode,
          employeeName: c.employeeName,
          departmentName: c.departmentName,
          approvedMinutesThisWeek: minutesByEmployeeId.get(c.id) ?? 0,
        })),
        weekStart,
        weekEnd,
        capMinutes: OVERTIME_WEEKLY_CAP_MINUTES,
      }
      res.json(body)
    } catch (err) {
      handleUnexpected(res, err)
    }
  }
)

// One row inserted per employeeId, each in its own SAVEPOINT so a shift
// conflict or stale scope on one employee can't roll back an otherwise-
// successful batch — same pattern as
// POST /employees/shift-assignments/daily-bulk. Every accepted employee
// shares one batch_id.
overtimeRequestsRouter.post('/overtime-requests/bulk', async (req: Request, res: Response) => {
  const actor = actorOf(req)
  if (!actor || actor.kind !== 'admin') return fail(res, 500, 'server misconfigured')

  const parsed = parseOvertimeBulkRequestInput(req.body)
  if (!parsed.ok) return fail(res, 400, parsed.message)
  const input = parsed.value

  try {
    const scope = await resolveSupervisorScope(actor)
    if (scope.kind === 'none') {
      return fail(res, 403, 'บัญชีนี้ไม่มีสิทธิ์ขอ OT แบบกลุ่ม', 'FORBIDDEN')
    }

    const batchId = randomUUID()

    // Resolved once for the whole batch, not per employee: this request is
    // filed BY the caller ON BEHALF OF everyone in employeeIds, so the
    // approval chain follows the caller's own supervisor (their boss), not
    // each employee's — which is usually the caller themselves, and routing
    // it back to them would be a self-approval loop. See migration 063.
    // No employee record for the caller (an HR/Admin account with none) is
    // the same as no supervisor: straight to the HR/Admin stage.
    const callerEmployeeId = await findEmployeeIdByEntraUpn(actor.upn)
    const callerEmployee = callerEmployeeId !== null ? await findEmployeeById(callerEmployeeId) : null
    const batchSupervisorEmployeeId = callerEmployee?.employment.supervisorEmployeeId ?? null
    const batchRequiresSupervisorApproval = batchSupervisorEmployeeId !== null
    const batchCurrentStage: OvertimeRequestStage = batchRequiresSupervisorApproval ? 'supervisor' : 'hr'

    const outcomes = await withTransaction(async (client) => {
      const results: OvertimeBulkCreateOutcome[] = []
      for (const employeeId of input.employeeIds) {
        await client.query('SAVEPOINT bulk_overtime_request')
        try {
          // Re-checked against the server-resolved scope, not the client's
          // say-so: a supervisor's picker is pre-filtered to their own team,
          // but nothing stops a hand-built request naming someone else's.
          if (!scopeAllows(scope, employeeId)) {
            results.push({
              employeeId,
              kind: 'skipped',
              message: 'พนักงานคนนี้ไม่อยู่ในสิทธิ์ของผู้ขอ',
            })
            await client.query('RELEASE SAVEPOINT bulk_overtime_request')
            continue
          }

          const outcome = await validateOvertimeRequestInput(
            employeeId,
            {
              otDate: input.otDate,
              startTime: input.startTime,
              endTime: input.endTime,
              reason: input.reason,
            },
            null,
            client
          )
          if (outcome.kind !== 'ok') {
            results.push({
              employeeId,
              kind: 'skipped',
              message: describeValidationOutcome(outcome).message,
            })
            await client.query('RELEASE SAVEPOINT bulk_overtime_request')
            continue
          }
          const snapshot = outcome.snapshot

          const { rows } = await client.query<{ id: string }>(
            `INSERT INTO overtime_requests
               (employee_id, ot_date, start_time, end_time, requested_minutes,
                day_status, day_label, shift_id, shift_start_time, shift_end_time,
                overtime_group_id, reason, batch_id, created_by_oid, created_by_name,
                requires_supervisor_approval, supervisor_employee_id, current_stage)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
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
              batchId,
              actor.oid,
              actor.name,
              // The batch-level resolution from above, not
              // snapshot.requiresSupervisorApproval/supervisorEmployeeId —
              // those are this employee's own supervisor, which is the wrong
              // chain for a request filed on their behalf. See this route's
              // comment above the batch resolution.
              batchRequiresSupervisorApproval,
              batchSupervisorEmployeeId,
              batchCurrentStage,
            ]
          )
          const created = rows[0]
          if (!created) throw new Error('insert into overtime_requests returned no row')

          await recordAudit(client, {
            actor,
            action: 'overtime_request.bulk_create',
            entityId: Number(created.id),
            detail: {
              employeeId,
              otDate: input.otDate,
              startTime: input.startTime,
              endTime: input.endTime,
              batchId,
            },
          })

          results.push({ employeeId, kind: 'ok', requestId: Number(created.id) })
          await client.query('RELEASE SAVEPOINT bulk_overtime_request')
        } catch (err) {
          await client.query('ROLLBACK TO SAVEPOINT bulk_overtime_request')
          results.push({
            employeeId,
            kind: 'skipped',
            message: err instanceof Error ? err.message : 'unexpected error',
          })
        }
      }
      return results
    })

    const body: OvertimeBulkCreateResponse = { batchId, outcomes }
    res.status(201).json(body)
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

    const page = parseOptionalPositiveInt(req.query['page'])
    if (page === undefined) return fail(res, 400, 'page must be a positive integer')

    const pageSize = parseOptionalPositiveInt(req.query['pageSize'])
    if (pageSize === undefined) return fail(res, 400, 'pageSize must be a positive integer')

    try {
      const result = await listOvertimeRequests(
        { status: statusResult.value },
        { ...(page !== null && { page }), ...(pageSize !== null && { pageSize }) }
      )
      const body: OvertimeRequestListResponse = result
      res.json(body)
    } catch (err) {
      handleUnexpected(res, err)
    }
  }
)

// A supervisor's inbox — mirrors GET /leave-requests/pending-approval. Mounted
// ahead of GET /overtime-requests/:id so 'pending-approval' is never parsed
// as an id.
overtimeRequestsRouter.get(
  '/overtime-requests/pending-approval',
  canReadAdmin,
  async (req: Request, res: Response) => {
    const auth = actorOf(req)
    if (!auth) return fail(res, 500, 'server misconfigured')

    try {
      const scope = await resolveSupervisorScope(auth)
      if (scope.kind === 'none') {
        const body: OvertimeRequestPendingApprovalResponse = { requests: [] }
        return res.json(body)
      }

      const requests = await listOvertimeRequestsPendingApproval(
        scope.kind === 'all' ? null : scope.supervisorEmployeeId
      )
      const body: OvertimeRequestPendingApprovalResponse = { requests }
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

      const canDecide = await computeCanDecide(actorOf(req), request, pool)
      const body: OvertimeRequestDetailResponse = { request, canDecide }
      res.json(body)
    } catch (err) {
      handleUnexpected(res, err)
    }
  }
)

// The statutory weekly allowance as it stands for this request's employee and
// week. Its own endpoint rather than a field on the detail response: it is
// only meaningful while a decision is pending, and it answers a question
// about the week rather than about the request.
overtimeRequestsRouter.get(
  '/overtime-requests/:id/weekly-cap',
  canReadAdmin,
  async (req: Request, res: Response) => {
    const id = parseId(req.params['id'])
    if (id === null) return fail(res, 400, 'id must be a positive integer')

    try {
      const request = await findOvertimeRequestById(id)
      if (!request) return fail(res, 404, `no overtime request with id ${id}`)

      const week = await approvedOvertimeMinutesInWeek(request.employeeId, request.otDate, id)

      const body: OvertimeWeeklyCapResponse = {
        weekStart: week.weekStart,
        weekEnd: week.weekEnd,
        approvedMinutes: week.minutes,
        requestMinutes: request.requestedMinutes,
        capMinutes: OVERTIME_WEEKLY_CAP_MINUTES,
      }
      res.json(body)
    } catch (err) {
      handleUnexpected(res, err)
    }
  }
)

overtimeRequestsRouter.post(
  '/overtime-requests/:id/approve',
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
          ot_date: string
          start_time: string
          end_time: string
          reason: string
          status: string
          current_stage: string | null
          supervisor_employee_id: string | null
        }>(
          `SELECT employee_id, ot_date, start_time, end_time, reason, status, current_stage, supervisor_employee_id
           FROM overtime_requests WHERE id = $1 FOR UPDATE`,
          [id]
        )
        const row = rows[0]
        if (!row) return { kind: 'not_found' as const }
        if (row.status !== 'pending') {
          return { kind: 'conflict' as const, message: 'คำขอนี้ถูกดำเนินการไปแล้ว' }
        }

        const approverKind = await resolveOvertimeApprover(
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

        // Re-validated here, not just at submission, for BOTH a forwarding
        // approval and a final one: a request can sit pending long enough to
        // fall out of the backdating window, and in the meantime an approved
        // shift change can have moved the employee's shift onto the hours
        // this request claims. Both are checked against live data — the
        // row's own snapshot is what was true when it was filed, which is
        // exactly the thing in question. Forwarding something already stale
        // just pushes the same problem to HR/Admin instead of catching it
        // where it happened.
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

        if (approverKind === 'supervisor') {
          // Forwarding approval only — the request stays pending, now
          // waiting on HR/Admin. No ledger effect, no attendance recompute:
          // nothing is decided yet.
          await client.query(
            `UPDATE overtime_requests
             SET current_stage = 'hr', supervisor_approved_by_oid = $2,
                 supervisor_approved_by_name = $3, supervisor_approved_at = now(), updated_at = now()
             WHERE id = $1`,
            [id, actorInfo.oid, actorInfo.name]
          )

          await recordAudit(client, {
            actor,
            action: 'overtime_request.supervisor_approve',
            entityId: id,
            detail: {},
          })

          const request = await findOvertimeRequestById(id, client)
          if (!request) throw new Error('re-select of overtime_requests returned no row')
          const canDecide = await computeCanDecide(actor, request, client)
          return { kind: 'ok' as const, request, canDecide }
        }

        // HR/Admin's final decision — the ordinary path (current_stage was
        // already 'hr') or an override of a still-pending supervisor stage
        // (confirmed: HR/Admin may act at any stage).
        await client.query(
          `UPDATE overtime_requests
           SET status = 'approved', current_stage = NULL, decided_by_oid = $2, decided_by_name = $3,
               decided_at = now(), updated_at = now()
           WHERE id = $1`,
          [id, actorInfo.oid, actorInfo.name]
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

        // Recompute this date immediately instead of waiting for the batch
        // job. The job's default window is the last 7 days ending yesterday
        // and OT may be filed up to 7 days back, so a request dated at that
        // limit and approved a few days later falls outside every future run
        // and would never be counted at all.
        //
        // Through ot_date + 1 because an overnight block reaches into the
        // next day's row, and in the same transaction so the figures can
        // never reflect an approval that then rolled back.
        await recomputeAttendanceDaily(
          Number(row.employee_id),
          row.ot_date,
          addDays(row.ot_date, 1),
          client
        )

        const request = await findOvertimeRequestById(id, client)
        if (!request) throw new Error('re-select of overtime_requests returned no row')
        return { kind: 'ok' as const, request, canDecide: false }
      })

      if (result.kind === 'not_found') return fail(res, 404, `no overtime request with id ${id}`)
      if (result.kind === 'conflict') return fail(res, 409, result.message)
      if (result.kind === 'forbidden') return fail(res, 403, 'คุณไม่มีสิทธิ์อนุมัติคำขอนี้', 'FORBIDDEN')
      if (result.kind === 'stale') return approvalStaleFail(res, result.outcome)

      // status === 'approved' means this was the final decision; anything
      // else ('pending', now at the hr stage) means a supervisor just
      // forwarded it.
      void notify(
        result.request.status === 'approved'
          ? {
              kind: 'approved',
              resource: 'overtime_request',
              requestId: id,
              requesterEmployeeId: result.request.employeeId,
            }
          : {
              kind: 'supervisor_approved',
              resource: 'overtime_request',
              requestId: id,
              requesterEmployeeId: result.request.employeeId,
            }
      )

      const body: OvertimeRequestDetailResponse = { request: result.request, canDecide: result.canDecide }
      res.json(body)
    } catch (err) {
      handleUnexpected(res, err)
    }
  }
)

overtimeRequestsRouter.post(
  '/overtime-requests/:id/reject',
  canDecideAsAdminOrEmployee,
  async (req: Request, res: Response) => {
    const actor = actorOf(req)
    if (!actor) return fail(res, 500, 'server misconfigured')

    const id = parseId(req.params['id'])
    if (id === null) return fail(res, 400, 'id must be a positive integer')

    const body = req.body as Partial<OvertimeRequestRejectRequest> | null
    const reason = requiredString((body ?? {}) as Record<string, unknown>, 'reason', 1000)
    if (reason === null) {
      return fail(res, 400, 'reason is required and must be 1000 characters or fewer')
    }

    try {
      const result = await withTransaction(async (client) => {
        const { rows } = await client.query<{
          status: string
          current_stage: string | null
          supervisor_employee_id: string | null
        }>(
          `SELECT status, current_stage, supervisor_employee_id FROM overtime_requests WHERE id = $1 FOR UPDATE`,
          [id]
        )
        const row = rows[0]
        if (!row) return { kind: 'not_found' as const }
        if (row.status !== 'pending') return { kind: 'conflict' as const }

        const approverKind = await resolveOvertimeApprover(
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

        // Terminal either way — see leaveRequests.ts's reject route for the
        // full reasoning, which applies unchanged here.
        await client.query(
          `UPDATE overtime_requests
           SET status = 'rejected', current_stage = NULL, decided_by_oid = $2, decided_by_name = $3,
               decided_at = now(), decision_reason = $4, updated_at = now()
           WHERE id = $1`,
          [id, actorInfo.oid, actorInfo.name, reason]
        )

        await recordAudit(client, {
          actor,
          action: 'overtime_request.reject',
          entityId: id,
          detail: { reason, decidedAsSupervisor: approverKind === 'supervisor' },
        })

        const request = await findOvertimeRequestById(id, client)
        if (!request) throw new Error('re-select of overtime_requests returned no row')
        return { kind: 'ok' as const, request, canDecide: false }
      })

      if (result.kind === 'not_found') return fail(res, 404, `no overtime request with id ${id}`)
      if (result.kind === 'conflict') return fail(res, 409, 'คำขอนี้ถูกดำเนินการไปแล้ว')
      if (result.kind === 'forbidden') return fail(res, 403, 'คุณไม่มีสิทธิ์ปฏิเสธคำขอนี้', 'FORBIDDEN')

      void notify({
        kind: 'rejected',
        resource: 'overtime_request',
        requestId: id,
        requesterEmployeeId: result.request.employeeId,
        reason,
      })

      const responseBody: OvertimeRequestDetailResponse = { request: result.request, canDecide: result.canDecide }
      res.json(responseBody)
    } catch (err) {
      handleUnexpected(res, err)
    }
  }
)

// Every row one Bulk OT Request submission created, for the batch detail
// screen. canReadAdmin, same as GET /overtime-requests/:id: viewing is open
// to all four roles, deciding is not.
overtimeRequestsRouter.get(
  '/overtime-requests/batch/:batchId',
  canReadAdmin,
  async (req: Request, res: Response) => {
    const batchId = req.params['batchId']
    if (typeof batchId !== 'string' || batchId === '') {
      return fail(res, 400, 'batchId is required')
    }

    try {
      const requests = await listOvertimeRequestsByBatchId(batchId)
      if (requests.length === 0) return fail(res, 404, `no batch with id ${batchId}`)

      // Every pending row in one batch shares the same supervisor_employee_id
      // (resolved once from the filer, see the bulk-create route), so
      // checking the first one still pending stands in for the whole batch.
      const firstPending = requests.find((r) => r.status === 'pending')
      const canDecideBatch =
        firstPending !== undefined ? await computeCanDecide(actorOf(req), firstPending, pool) : false

      const body: OvertimeBatchResponse = { requests, canDecideBatch }
      res.json(body)
    } catch (err) {
      handleUnexpected(res, err)
    }
  }
)

// Approves every still-pending row of a batch with one click, so a reviewer
// is not clicking "approve" once per employee for a submission that was
// really one decision. Each row still goes through its own SAVEPOINT and its
// own live re-validation (validateOvertimeRequestInput, same as single
// approve) — one employee's shift having changed since filing does not block
// the rest of the group, it just leaves that one row pending, 'stale', for
// the reviewer to look at individually afterwards through the ordinary
// single-request detail page.
overtimeRequestsRouter.post(
  '/overtime-requests/batch/:batchId/approve',
  canReadAdmin,
  async (req: Request, res: Response) => {
    const actor = actorOf(req)
    if (!actor || actor.kind !== 'admin') return fail(res, 500, 'server misconfigured')

    const batchId = req.params['batchId']
    if (typeof batchId !== 'string' || batchId === '') {
      return fail(res, 400, 'batchId is required')
    }

    try {
      const pendingRows = await pool.query<{
        id: string
        employee_id: string
        current_stage: string | null
        supervisor_employee_id: string | null
      }>(
        `SELECT id, employee_id, current_stage, supervisor_employee_id
         FROM overtime_requests WHERE batch_id = $1 AND status = 'pending'`,
        [batchId]
      )
      if (pendingRows.rows.length === 0) {
        return fail(res, 404, `no pending requests in batch ${batchId}`)
      }

      // Checked once against the batch's first pending row rather than per
      // row inside the loop: every row in one batch shares the same
      // supervisor_employee_id (resolved once from the filer, not per
      // employee — see the bulk-create route), so this is representative of
      // the whole batch and gives a clean top-level 403 instead of a batch
      // of individually-forbidden outcomes.
      const first = pendingRows.rows[0]
      if (!first) throw new Error('pendingRows.rows was non-empty but has no first element')
      const approverKind = await resolveOvertimeApprover(
        actor,
        {
          status: 'pending',
          currentStage: first.current_stage,
          supervisorEmployeeId: first.supervisor_employee_id === null ? null : Number(first.supervisor_employee_id),
        },
        pool
      )
      if (approverKind === null) return fail(res, 403, 'คุณไม่มีสิทธิ์อนุมัติคำขอกลุ่มนี้', 'FORBIDDEN')

      const outcomes = await withTransaction(async (client) => {
        const results: OvertimeBatchDecisionOutcome[] = []
        for (const { id: idText, employee_id: employeeIdText } of pendingRows.rows) {
          const id = Number(idText)
          const employeeId = Number(employeeIdText)
          await client.query('SAVEPOINT batch_overtime_approve')
          try {
            const { rows } = await client.query<{
              ot_date: string
              start_time: string
              end_time: string
              reason: string
              status: string
            }>(
              `SELECT ot_date, start_time, end_time, reason, status
               FROM overtime_requests WHERE id = $1 FOR UPDATE`,
              [id]
            )
            const row = rows[0]
            if (!row) throw new Error(`overtime request ${id} vanished mid-batch`)
            if (row.status !== 'pending') {
              results.push({
                requestId: id,
                employeeId,
                kind: 'stale',
                message: 'คำขอนี้ถูกดำเนินการไปแล้ว',
              })
              await client.query('RELEASE SAVEPOINT batch_overtime_approve')
              continue
            }

            // Same live re-validation as the single-request approve route —
            // see its own comment for why the row's own snapshot isn't
            // enough, and for why this runs before a forwarding approval too.
            const outcome = await validateOvertimeRequestInput(
              employeeId,
              {
                otDate: row.ot_date,
                startTime: row.start_time,
                endTime: row.end_time,
                reason: row.reason,
              },
              id,
              client
            )
            if (outcome.kind !== 'ok') {
              results.push({
                requestId: id,
                employeeId,
                kind: 'stale',
                message: describeValidationOutcome(outcome).message,
              })
              await client.query('RELEASE SAVEPOINT batch_overtime_approve')
              continue
            }

            if (approverKind === 'supervisor') {
              await client.query(
                `UPDATE overtime_requests
                 SET current_stage = 'hr', supervisor_approved_by_oid = $2,
                     supervisor_approved_by_name = $3, supervisor_approved_at = now(), updated_at = now()
                 WHERE id = $1`,
                [id, actor.oid, actor.name]
              )

              await recordAudit(client, {
                actor,
                action: 'overtime_request.supervisor_approve',
                entityId: id,
                detail: { batchId },
              })

              results.push({ requestId: id, employeeId, kind: 'ok' })
              await client.query('RELEASE SAVEPOINT batch_overtime_approve')
              continue
            }

            await client.query(
              `UPDATE overtime_requests
               SET status = 'approved', current_stage = NULL, decided_by_oid = $2, decided_by_name = $3,
                   decided_at = now(), updated_at = now()
               WHERE id = $1`,
              [id, actor.oid, actor.name]
            )

            await recordAudit(client, {
              actor,
              action: 'overtime_request.approve',
              entityId: id,
              detail: {
                employeeId,
                otDate: row.ot_date,
                startTime: row.start_time,
                endTime: row.end_time,
                batchId,
              },
            })

            await recomputeAttendanceDaily(
              employeeId,
              row.ot_date,
              addDays(row.ot_date, 1),
              client
            )

            results.push({ requestId: id, employeeId, kind: 'ok' })
            await client.query('RELEASE SAVEPOINT batch_overtime_approve')
          } catch (err) {
            await client.query('ROLLBACK TO SAVEPOINT batch_overtime_approve')
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

      const body: OvertimeBatchActionResponse = { outcomes }
      res.json(body)
    } catch (err) {
      handleUnexpected(res, err)
    }
  }
)

// Rejects every still-pending row of a batch with one click and one shared
// reason — the batch-detail mirror of POST /overtime-requests/:id/reject.
overtimeRequestsRouter.post(
  '/overtime-requests/batch/:batchId/reject',
  canReadAdmin,
  async (req: Request, res: Response) => {
    const actor = actorOf(req)
    if (!actor || actor.kind !== 'admin') return fail(res, 500, 'server misconfigured')

    const batchId = req.params['batchId']
    if (typeof batchId !== 'string' || batchId === '') {
      return fail(res, 400, 'batchId is required')
    }

    const body = req.body as Partial<OvertimeRequestRejectRequest> | null
    const reason = requiredString((body ?? {}) as Record<string, unknown>, 'reason', 1000)
    if (reason === null) {
      return fail(res, 400, 'reason is required and must be 1000 characters or fewer')
    }

    try {
      const pendingRows = await pool.query<{
        id: string
        employee_id: string
        current_stage: string | null
        supervisor_employee_id: string | null
      }>(
        `SELECT id, employee_id, current_stage, supervisor_employee_id
         FROM overtime_requests WHERE batch_id = $1 AND status = 'pending'`,
        [batchId]
      )
      if (pendingRows.rows.length === 0) {
        return fail(res, 404, `no pending requests in batch ${batchId}`)
      }

      // Same one-check-for-the-whole-batch reasoning as the approve route.
      const first = pendingRows.rows[0]
      if (!first) throw new Error('pendingRows.rows was non-empty but has no first element')
      const approverKind = await resolveOvertimeApprover(
        actor,
        {
          status: 'pending',
          currentStage: first.current_stage,
          supervisorEmployeeId: first.supervisor_employee_id === null ? null : Number(first.supervisor_employee_id),
        },
        pool
      )
      if (approverKind === null) return fail(res, 403, 'คุณไม่มีสิทธิ์ปฏิเสธคำขอกลุ่มนี้', 'FORBIDDEN')

      const outcomes = await withTransaction(async (client) => {
        const results: OvertimeBatchDecisionOutcome[] = []
        for (const { id: idText, employee_id: employeeIdText } of pendingRows.rows) {
          const id = Number(idText)
          const employeeId = Number(employeeIdText)
          await client.query('SAVEPOINT batch_overtime_reject')
          try {
            const { rows } = await client.query<{ status: string }>(
              `SELECT status FROM overtime_requests WHERE id = $1 FOR UPDATE`,
              [id]
            )
            const row = rows[0]
            if (!row) throw new Error(`overtime request ${id} vanished mid-batch`)
            if (row.status !== 'pending') {
              results.push({
                requestId: id,
                employeeId,
                kind: 'stale',
                message: 'คำขอนี้ถูกดำเนินการไปแล้ว',
              })
              await client.query('RELEASE SAVEPOINT batch_overtime_reject')
              continue
            }

            await client.query(
              `UPDATE overtime_requests
               SET status = 'rejected', current_stage = NULL, decided_by_oid = $2, decided_by_name = $3,
                   decided_at = now(), decision_reason = $4, updated_at = now()
               WHERE id = $1`,
              [id, actor.oid, actor.name, reason]
            )

            await recordAudit(client, {
              actor,
              action: 'overtime_request.reject',
              entityId: id,
              detail: { reason, batchId, decidedAsSupervisor: approverKind === 'supervisor' },
            })

            results.push({ requestId: id, employeeId, kind: 'ok' })
            await client.query('RELEASE SAVEPOINT batch_overtime_reject')
          } catch (err) {
            await client.query('ROLLBACK TO SAVEPOINT batch_overtime_reject')
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

      const responseBody: OvertimeBatchActionResponse = { outcomes }
      res.json(responseBody)
    } catch (err) {
      handleUnexpected(res, err)
    }
  }
)
