import { Router } from 'express'
import type { Request, Response } from 'express'
import type pg from 'pg'
import {
  ATTENDANCE_EVENT_TYPES,
  ROLES,
  TIME_CORRECTION_STATUSES,
  type AttendanceEventType,
  type AuthUser,
  type TimeCorrectionAdminInput,
  type TimeCorrectionDetailResponse,
  type TimeCorrectionEligibleEmployeesResponse,
  type TimeCorrectionInput,
  type TimeCorrectionListResponse,
  type TimeCorrectionPendingApprovalResponse,
  type TimeCorrectionMineResponse,
  type TimeCorrectionRejectRequest,
  type TimeCorrectionResponse,
  type TimeCorrectionStage,
  type TimeCorrectionStatus,
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
import { addDays, getShiftIdForDate, toThailandDateString } from '../shiftAssignmentQueries.js'
import { resolveMatchWindow } from '../attendanceMatchingQueries.js'
import { recomputeAttendanceDaily } from '../attendanceDailyQueries.js'
import { narrowToScope, resolveSupervisorScope, scopeAllows } from '../supervisorScope.js'
import {
  SELECT_TIME_CORRECTION,
  findTimeCorrectionById,
  listTimeCorrections,
  listTimeCorrectionsForEmployee,
  listTimeCorrectionsPendingApproval,
  rowToTimeCorrection,
  rowToTimeCorrectionListItem,
  type TimeCorrectionListRow,
  type TimeCorrectionRow,
} from '../timeCorrectionQueries.js'

export const timeCorrectionsRouter = Router()

type Queryable = Pick<pg.Pool, 'query'>

// Any HRM role may look at the review queue. Deciding one is no longer a
// fixed role check — see resolveTimeCorrectionApprover, checked per-request
// once current_stage is loaded, same pattern as leaveRequests.ts.
const canReadAdmin = requireRole(...ROLES)
// Approve/reject only: an employee-kind caller (a LIFF supervisor) always
// passes this gate too — resolveTimeCorrectionApprover still gates what they
// may actually do once the row is loaded, same as an admin with the wrong role.
const canDecideAsAdminOrEmployee = requireRoleOrEmployee(...ROLES)

function actorOf(req: Request): AuthUser | null {
  return req.auth ?? null
}

type TimeCorrectionApproverKind = 'hr' | 'supervisor'

/** Same rule as leaveRequests.ts's resolveLeaveApprover. */
export async function resolveTimeCorrectionApprover(
  actor: AuthUser,
  row: { status: string; currentStage: string | null; supervisorEmployeeId: number | null },
  db: Queryable
): Promise<TimeCorrectionApproverKind | null> {
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

/** TimeCorrectionDetailResponse.canDecide. */
async function computeCanDecide(
  actor: AuthUser | null,
  request: { status: string; currentStage: string | null; supervisorEmployeeId: number | null },
  db: Queryable
): Promise<boolean> {
  if (!actor || request.status !== 'pending') return false
  return (await resolveTimeCorrectionApprover(actor, request, db)) !== null
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

/** Body of POST /time-corrections/admin — same fields as TimeCorrectionInput
 *  plus the target employeeId, which the client must supply since the caller
 *  has no employee session of their own. */
function parseTimeCorrectionAdminInput(body: unknown): ParseResult<TimeCorrectionAdminInput> {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, message: 'body must be a JSON object' }
  }
  const raw = body as Record<string, unknown>
  const employeeIdRaw = raw['employeeId']
  const employeeId =
    typeof employeeIdRaw === 'number' && Number.isInteger(employeeIdRaw) && employeeIdRaw > 0 ? employeeIdRaw : null
  if (employeeId === null) return { ok: false, message: 'employeeId is required and must be a positive integer' }

  const rest = parseTimeCorrectionInput(body)
  if (!rest.ok) return rest
  return { ok: true, value: { employeeId, ...rest.value } }
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

/** Shared by both creation routes below — the actual insert/audit/notify,
 *  once the caller has resolved who the request is for, who is filing it,
 *  and (via supervisorEmployeeId) whose approval chain it follows. */
async function createTimeCorrection(params: {
  employeeId: number
  eventType: AttendanceEventType
  requestedEventTime: string
  reason: string
  supervisorEmployeeId: number | null
  actor: AuthUser
  /** Who filed this on the employee's behalf — null for self-service (the
   *  employee filed their own), set for admin-initiated requests. */
  createdBy: { oid: string; name: string } | null
}) {
  const requiresSupervisorApproval = params.supervisorEmployeeId !== null
  const currentStage: TimeCorrectionStage = requiresSupervisorApproval ? 'supervisor' : 'hr'

  const request = await withTransaction(async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO time_correction_requests
         (employee_id, event_type, requested_event_time, reason,
          requires_supervisor_approval, supervisor_employee_id, current_stage,
          created_by_oid, created_by_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id`,
      [
        params.employeeId,
        params.eventType,
        params.requestedEventTime,
        params.reason,
        requiresSupervisorApproval,
        params.supervisorEmployeeId,
        currentStage,
        params.createdBy?.oid ?? null,
        params.createdBy?.name ?? null,
      ]
    )
    const created = rows[0]
    if (!created) throw new Error('insert into time_correction_requests returned no row')

    await recordAudit(client, {
      actor: params.actor,
      action: 'time_correction.create',
      entityId: Number(created.id),
      detail: {
        eventType: params.eventType,
        requestedEventTime: params.requestedEventTime,
        employeeId: params.employeeId,
      },
    })

    const { rows: selectRows } = await client.query<TimeCorrectionRow>(
      `${SELECT_TIME_CORRECTION} WHERE t.id = $1`,
      [created.id]
    )
    const row = selectRows[0]
    if (!row) throw new Error('re-select of time_correction_requests returned no row')
    return rowToTimeCorrection(row)
  })

  void notify({
    kind: 'created',
    resource: 'time_correction_request',
    requestId: request.id,
    requesterEmployeeId: params.employeeId,
    supervisorEmployeeId: params.supervisorEmployeeId,
  })

  return request
}

timeCorrectionsRouter.post('/time-corrections', async (req: Request, res: Response) => {
  const employeeId = requireEmployeeId(req, res)
  if (employeeId === null) return

  const parsed = parseTimeCorrectionInput(req.body)
  if (!parsed.ok) return fail(res, 400, parsed.message)
  const input = parsed.value

  try {
    const employee = await findEmployeeById(employeeId)
    if (!employee) return fail(res, 404, `no employee with id ${employeeId}`)

    const request = await createTimeCorrection({
      employeeId,
      eventType: input.eventType,
      requestedEventTime: input.requestedEventTime,
      reason: input.reason,
      // Snapshotted at submission — see LeaveRequest's fields of the same
      // name for the full reasoning, which applies unchanged here.
      supervisorEmployeeId: employee.employment.supervisorEmployeeId,
      actor: { kind: 'employee', employeeId },
      createdBy: null,
    })

    const body: TimeCorrectionResponse = { request }
    res.status(201).json(body)
  } catch (err) {
    handleUnexpected(res, err)
  }
})

/** A supervisor/HR/Admin filing a correction on behalf of one employee from
 *  admin/ — the Admin-side counterpart to LIFF's self-service POST above.
 *  Separate endpoint (rather than branching the one above on actor.kind) to
 *  keep each caller's authorization and approval-chain resolution readable
 *  on its own, same reasoning as Bulk OT Request's separate `/bulk` route. */
timeCorrectionsRouter.post('/time-corrections/admin', async (req: Request, res: Response) => {
  const actor = actorOf(req)
  if (!actor) return fail(res, 500, 'server misconfigured')
  if (actor.kind !== 'admin') return fail(res, 403, 'endpoint นี้ใช้ได้เฉพาะบัญชี admin เท่านั้น', 'FORBIDDEN')

  const parsed = parseTimeCorrectionAdminInput(req.body)
  if (!parsed.ok) return fail(res, 400, parsed.message)
  const input = parsed.value

  try {
    const scope = await resolveSupervisorScope(actor)
    if (scope.kind === 'none') {
      return fail(res, 403, 'บัญชีนี้ไม่มีสิทธิ์ขอแก้ไขเวลาแทนพนักงาน', 'FORBIDDEN')
    }
    // Re-checked against the server-resolved scope, not the client's say-so —
    // a supervisor's picker is pre-filtered to their own team, but nothing
    // stops a hand-built request naming someone else's employeeId.
    if (!scopeAllows(scope, input.employeeId)) {
      return fail(res, 403, 'พนักงานคนนี้ไม่อยู่ในสิทธิ์ของผู้ขอ', 'FORBIDDEN')
    }

    const employee = await findEmployeeById(input.employeeId)
    if (!employee) return fail(res, 404, `no employee with id ${input.employeeId}`)

    // Approval chain follows the FILER's own supervisor, not the target
    // employee's — same reasoning as Bulk OT Request (overtimeRequests.ts):
    // filing this on a report's behalf already constitutes the filer's own
    // approval, so routing it back to them would be a self-approval loop. No
    // employee record for the filer (a pure HR/Admin account) is the same as
    // no supervisor: straight to the HR/Admin stage.
    const callerEmployeeId = await findEmployeeIdByEntraUpn(actor.upn)
    const callerEmployee = callerEmployeeId !== null ? await findEmployeeById(callerEmployeeId) : null
    const supervisorEmployeeId = callerEmployee?.employment.supervisorEmployeeId ?? null

    const request = await createTimeCorrection({
      employeeId: input.employeeId,
      eventType: input.eventType,
      requestedEventTime: input.requestedEventTime,
      reason: input.reason,
      supervisorEmployeeId,
      actor,
      createdBy: { oid: actor.oid, name: actor.name },
    })

    const body: TimeCorrectionResponse = { request }
    res.status(201).json(body)
  } catch (err) {
    handleUnexpected(res, err)
  }
})

// Who an admin-side caller may file an on-behalf-of request for — mirrors
// GET /overtime-requests/bulk/eligible-employees minus the weekly-cap/date
// logic, which has no equivalent here. Mounted ahead of GET
// /time-corrections/:id so 'eligible-employees' is never parsed as an id.
timeCorrectionsRouter.get('/time-corrections/eligible-employees', async (req: Request, res: Response) => {
  const auth = actorOf(req)
  if (!auth) return fail(res, 500, 'server misconfigured')

  try {
    const scope = await resolveSupervisorScope(auth)
    if (scope.kind === 'none') {
      return fail(res, 403, 'บัญชีนี้ไม่มีสิทธิ์ขอแก้ไขเวลาแทนพนักงาน', 'FORBIDDEN')
    }

    const candidates = await listActiveEmployeesInScope(scope.kind === 'all' ? null : scope.employeeIds)
    const body: TimeCorrectionEligibleEmployeesResponse = {
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
      const body: TimeCorrectionListResponse = {
        requests: [],
        page: page ?? 1,
        pageSize: pageSize ?? 50,
        total: 0,
      }
      return res.json(body)
    }

    const scopedEmployeeIds = narrowToScope(scope, employeeIds ?? undefined)

    const result = await listTimeCorrections(
      {
        status: statusResult.value,
        ...(scopedEmployeeIds !== undefined && { employeeIds: scopedEmployeeIds }),
      },
      { ...(page !== null && { page }), ...(pageSize !== null && { pageSize }) }
    )
    const body: TimeCorrectionListResponse = result
    res.json(body)
  } catch (err) {
    handleUnexpected(res, err)
  }
})

// A supervisor's inbox — mirrors GET /leave-requests/pending-approval. Mounted
// ahead of GET /time-corrections/:id so 'pending-approval' is never parsed
// as an id.
timeCorrectionsRouter.get(
  '/time-corrections/pending-approval',
  canReadAdmin,
  async (req: Request, res: Response) => {
    const auth = actorOf(req)
    if (!auth) return fail(res, 500, 'server misconfigured')

    try {
      const scope = await resolveSupervisorScope(auth)
      if (scope.kind === 'none') {
        const body: TimeCorrectionPendingApprovalResponse = { requests: [] }
        return res.json(body)
      }

      const requests = await listTimeCorrectionsPendingApproval(
        scope.kind === 'all' ? null : scope.supervisorEmployeeId
      )
      const body: TimeCorrectionPendingApprovalResponse = { requests }
      res.json(body)
    } catch (err) {
      handleUnexpected(res, err)
    }
  }
)

timeCorrectionsRouter.get('/time-corrections/:id', canReadAdmin, async (req: Request, res: Response) => {
  const id = parseId(req.params['id'])
  if (id === null) return fail(res, 400, 'id must be a positive integer')

  const auth = actorOf(req)
  if (!auth) return fail(res, 500, 'server misconfigured')

  try {
    const request = await findTimeCorrectionById(id)
    if (!request) return fail(res, 404, `no time correction request with id ${id}`)

    const canDecide = await computeCanDecide(auth, request, pool)
    const scope = await resolveSupervisorScope(auth)
    if (!scopeAllows(scope, request.employeeId) && !canDecide) {
      return fail(res, 404, `no time correction request with id ${id}`)
    }

    const body: TimeCorrectionDetailResponse = { request, canDecide }
    res.json(body)
  } catch (err) {
    handleUnexpected(res, err)
  }
})

/** The neighboring attendance_events row on one side of a point in time, for
 *  the alternation check below — same "most recent" shape as
 *  findLastAttendanceEvent, but bounded and directional instead of just DESC.
 *
 *  Confined to `window`, the punch-matching range of the work-date the
 *  corrected time falls in (resolveMatchWindow). Searching the employee's
 *  whole history instead would judge the punch against days that can never
 *  contest it: attendance matching is per work-date, taking the first
 *  check_in and last check_out inside one window, so an unpaired punch left
 *  on some other date has no bearing on whether this one is coherent — and
 *  letting it block the correction makes a day missing *both* punches
 *  unrepairable, since whichever half is inserted first sits next to the
 *  neighbouring day's punch of the same type. */
async function neighborEvent(
  client: { query: typeof pool.query },
  employeeId: number,
  eventTime: Date,
  window: { startAt: Date; endAt: Date },
  direction: 'before' | 'after'
): Promise<AttendanceEventType | null> {
  const operator = direction === 'before' ? '<' : '>'
  const order = direction === 'before' ? 'DESC' : 'ASC'
  const { rows } = await client.query<{ event_type: string }>(
    `SELECT event_type FROM attendance_events
     WHERE employee_id = $1 AND event_time ${operator} $2
       AND event_time >= $3 AND event_time <= $4
     ORDER BY event_time ${order} LIMIT 1`,
    [employeeId, eventTime.toISOString(), window.startAt.toISOString(), window.endAt.toISOString()]
  )
  const row = rows[0]
  return row ? (row.event_type as AttendanceEventType) : null
}

/** How far either side of a punch that falls *outside* its work-date's match
 *  window the alternation check still looks. Such a punch is un-matchable by
 *  definition — attendance matching will ignore it — so the day's window says
 *  nothing about it, and only its immediate neighbourhood can. Deliberately
 *  the same 2 hours matching itself tolerates, so the two never disagree
 *  about what counts as "next to". */
const OUT_OF_WINDOW_TOLERANCE_MS = 120 * 60_000

/** The day's match window, widened to cover `eventTime` when the corrected
 *  time lands outside it — otherwise a late check-out with no approved OT
 *  behind it would be compared against a window it isn't in, and a second
 *  copy of the same punch would sail through as having no neighbours at all. */
function scopeFor(window: { startAt: Date; endAt: Date }, eventTime: Date): { startAt: Date; endAt: Date } {
  if (eventTime >= window.startAt && eventTime <= window.endAt) return window
  return {
    startAt: new Date(Math.min(window.startAt.getTime(), eventTime.getTime() - OUT_OF_WINDOW_TOLERANCE_MS)),
    endAt: new Date(Math.max(window.endAt.getTime(), eventTime.getTime() + OUT_OF_WINDOW_TOLERANCE_MS)),
  }
}

timeCorrectionsRouter.post('/time-corrections/:id/approve', canDecideAsAdminOrEmployee, async (req: Request, res: Response) => {
  const actor = actorOf(req)
  if (!actor) return fail(res, 500, 'server misconfigured')

  const id = parseId(req.params['id'])
  if (id === null) return fail(res, 400, 'id must be a positive integer')

  try {
    const result = await withTransaction(async (client) => {
      const { rows } = await client.query<
        TimeCorrectionRow & { current_stage: string | null; supervisor_employee_id: string | null }
      >(
        `SELECT id, employee_id, event_type, requested_event_time, reason, status,
                current_stage, supervisor_employee_id,
                decided_by_name, decided_at, decision_reason, resulting_event_id, created_at
         FROM time_correction_requests WHERE id = $1 FOR UPDATE`,
        [id]
      )
      const row = rows[0]
      if (!row) return { kind: 'not_found' as const }
      if (row.status !== 'pending') return { kind: 'conflict' as const, message: 'คำขอนี้ถูกดำเนินการไปแล้ว' }

      const approverKind = await resolveTimeCorrectionApprover(
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

      const employeeId = Number(row.employee_id)
      const eventType = row.event_type as AttendanceEventType
      const eventTime = new Date(row.requested_event_time)

      // The work-date the corrected time belongs to, and the punch window
      // that date owns — every check below is scoped to it, and so is the
      // recompute at the end.
      const workDate = toThailandDateString(eventTime)
      const window = scopeFor(await resolveMatchWindow(employeeId, workDate, client), eventTime)

      // Sequential, not Promise.all: `client` is a single pg client inside a
      // transaction and cannot run two queries at once — pg serialises them
      // and warns, and pg@9 will make it an error. Same note as
      // resolveExpectedShiftWindows'.
      const prev = await neighborEvent(client, employeeId, eventTime, window, 'before')
      const next = await neighborEvent(client, employeeId, eventTime, window, 'after')

      if (prev === null && eventType === 'check_out') {
        return {
          kind: 'conflict' as const,
          message:
            'ยังไม่มีการลงเวลาเข้างานของวันทำงานนี้ก่อนเวลาที่ขอแก้ไข กรุณาอนุมัติคำขอลงเวลาเข้างานก่อน',
        }
      }
      if (prev !== null && prev === eventType) {
        return {
          kind: 'conflict' as const,
          message:
            'เวลานี้จะทำให้มีการลงเวลาประเภทเดียวกันติดกันกับรายการก่อนหน้าของวันทำงานเดียวกัน กรุณาตรวจสอบเวลาที่ขอแก้ไข',
        }
      }
      if (next !== null && next === eventType) {
        return {
          kind: 'conflict' as const,
          message:
            'เวลานี้จะทำให้มีการลงเวลาประเภทเดียวกันติดกันกับรายการถัดไปของวันทำงานเดียวกัน กรุณาตรวจสอบเวลาที่ขอแก้ไข',
        }
      }

      if (approverKind === 'supervisor') {
        // Forwarding approval only — the request stays pending, now waiting
        // on HR/Admin. No attendance_events row is written here: nothing is
        // decided yet, and that insert (below) is exactly the thing a
        // forwarding step must not do twice.
        await client.query(
          `UPDATE time_correction_requests
           SET current_stage = 'hr', supervisor_approved_by_oid = $2,
               supervisor_approved_by_name = $3, supervisor_approved_at = now(), updated_at = now()
           WHERE id = $1`,
          [id, actorInfo.oid, actorInfo.name]
        )

        await recordAudit(client, {
          actor,
          action: 'time_correction.supervisor_approve',
          entityId: id,
          detail: {},
        })

        const request = await findTimeCorrectionById(id, client)
        if (!request) throw new Error('re-select of time_correction_requests returned no row')
        const canDecide = await computeCanDecide(actor, request, client)
        return { kind: 'ok' as const, request, canDecide }
      }

      const employee = await findEmployeeById(employeeId, client)
      if (!employee) return { kind: 'conflict' as const, message: 'ไม่พบข้อมูลพนักงานของคำขอนี้' }

      // The shift that applied *on the corrected date*, not employee's
      // current one — approval can happen well after the request, and by
      // then the employee may already be on a different shift. See
      // shiftAssignmentQueries.ts's header comment.
      const shiftId = await getShiftIdForDate(employeeId, workDate, client)

      const { rows: insertedRows } = await client.query<{ id: string }>(
        `INSERT INTO attendance_events (employee_id, event_type, event_time, source, shift_id)
         VALUES ($1, $2, $3, 'admin_correction', $4)
         RETURNING id`,
        [employeeId, eventType, row.requested_event_time, shiftId]
      )
      const resultingEventId = Number(insertedRows[0]?.id)
      if (!resultingEventId) throw new Error('insert into attendance_events returned no id')

      await client.query(
        `UPDATE time_correction_requests
         SET status = 'approved', current_stage = NULL, decided_by_oid = $2, decided_by_name = $3,
             decided_at = now(), resulting_event_id = $4, updated_at = now()
         WHERE id = $1`,
        [id, actorInfo.oid, actorInfo.name, resultingEventId]
      )

      await recordAudit(client, {
        actor,
        action: 'time_correction.approve',
        entityId: id,
        detail: { resultingEventId, eventType, requestedEventTime: row.requested_event_time },
      })

      // Recompute immediately instead of waiting for the batch job — same
      // reasoning as overtimeRequests.ts's approve. The job's default window
      // is the last 7 days ending yesterday, and a time correction is
      // routinely filed (and decided) further back than that, so the punch
      // just inserted would otherwise never reach attendance_daily at all.
      //
      // A day either side of workDate because an overnight shift's window
      // reaches into both neighbours: a punch corrected here can change the
      // verdict of the adjacent row too. In the same transaction so the
      // figures can never reflect an approval that then rolled back.
      await recomputeAttendanceDaily(employeeId, addDays(workDate, -1), addDays(workDate, 1), client)

      const request = await findTimeCorrectionById(id, client)
      if (!request) throw new Error('re-select of time_correction_requests returned no row')
      return { kind: 'ok' as const, request, canDecide: false }
    })

    if (result.kind === 'not_found') return fail(res, 404, `no time correction request with id ${id}`)
    if (result.kind === 'forbidden') return fail(res, 403, 'คุณไม่มีสิทธิ์อนุมัติคำขอนี้', 'FORBIDDEN')
    if (result.kind === 'conflict') return fail(res, 409, result.message)

    // status === 'approved' means this was the final decision; anything else
    // ('pending', now at the hr stage) means a supervisor just forwarded it.
    void notify(
      result.request.status === 'approved'
        ? {
            kind: 'approved',
            resource: 'time_correction_request',
            requestId: id,
            requesterEmployeeId: result.request.employeeId,
          }
        : {
            kind: 'supervisor_approved',
            resource: 'time_correction_request',
            requestId: id,
            requesterEmployeeId: result.request.employeeId,
          }
    )

    const body: TimeCorrectionDetailResponse = { request: result.request, canDecide: result.canDecide }
    res.json(body)
  } catch (err) {
    handleUnexpected(res, err)
  }
})

timeCorrectionsRouter.post('/time-corrections/:id/reject', canDecideAsAdminOrEmployee, async (req: Request, res: Response) => {
  const actor = actorOf(req)
  if (!actor) return fail(res, 500, 'server misconfigured')

  const id = parseId(req.params['id'])
  if (id === null) return fail(res, 400, 'id must be a positive integer')

  const body = req.body as Partial<TimeCorrectionRejectRequest> | null
  const reason = requiredString((body ?? {}) as Record<string, unknown>, 'reason', 1000)
  if (reason === null) return fail(res, 400, 'reason is required and must be 1000 characters or fewer')

  try {
    const result = await withTransaction(async (client) => {
      const { rows } = await client.query<{
        status: string
        current_stage: string | null
        supervisor_employee_id: string | null
      }>(
        `SELECT status, current_stage, supervisor_employee_id FROM time_correction_requests WHERE id = $1 FOR UPDATE`,
        [id]
      )
      const row = rows[0]
      if (!row) return { kind: 'not_found' as const }
      if (row.status !== 'pending') return { kind: 'conflict' as const }

      const approverKind = await resolveTimeCorrectionApprover(
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
        `UPDATE time_correction_requests
         SET status = 'rejected', current_stage = NULL, decided_by_oid = $2, decided_by_name = $3,
             decided_at = now(), decision_reason = $4, updated_at = now()
         WHERE id = $1`,
        [id, actorInfo.oid, actorInfo.name, reason]
      )

      await recordAudit(client, {
        actor,
        action: 'time_correction.reject',
        entityId: id,
        detail: { reason, decidedAsSupervisor: approverKind === 'supervisor' },
      })

      const request = await findTimeCorrectionById(id, client)
      if (!request) throw new Error('re-select of time_correction_requests returned no row')
      return { kind: 'ok' as const, request, canDecide: false }
    })

    if (result.kind === 'not_found') return fail(res, 404, `no time correction request with id ${id}`)
    if (result.kind === 'conflict') return fail(res, 409, 'คำขอนี้ถูกดำเนินการไปแล้ว')
    if (result.kind === 'forbidden') return fail(res, 403, 'คุณไม่มีสิทธิ์ปฏิเสธคำขอนี้', 'FORBIDDEN')

    void notify({
      kind: 'rejected',
      resource: 'time_correction_request',
      requestId: id,
      requesterEmployeeId: result.request.employeeId,
      reason,
    })

    const body2: TimeCorrectionDetailResponse = { request: result.request, canDecide: result.canDecide }
    res.json(body2)
  } catch (err) {
    handleUnexpected(res, err)
  }
})
