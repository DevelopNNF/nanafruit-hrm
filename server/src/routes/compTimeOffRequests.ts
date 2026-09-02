import { Router } from 'express'
import type { Request, Response } from 'express'
import {
  COMP_TIME_OFF_REQUEST_STATUSES,
  ROLES,
  computeOvertimeMinutes,
  parseWallClockMinutes,
  type AuthUser,
  type CompTimeBalanceResponse,
  type CompTimeOffRequestDetailResponse,
  type CompTimeOffRequestInput,
  type CompTimeOffRequestListResponse,
  type CompTimeOffRequestMineResponse,
  type CompTimeOffRequestPendingApprovalResponse,
  type CompTimeOffRequestRejectRequest,
  type CompTimeOffRequestResponse,
  type CompTimeOffRequestStage,
  type CompTimeOffRequestStatus,
} from '@hrm/shared'
import type pg from 'pg'
import { pool, withTransaction } from '../db.js'
import { requireRole, requireRoleOrEmployee } from '../auth/middleware.js'
import { recordAudit } from '../audit.js'
import { fail, handleUnexpected, parseOptionalPositiveInt } from '../http.js'
import { describeActor, findEmployeeById, findEmployeeIdByEntraUpn } from '../employeeQueries.js'
import { notify } from '../notifications/dispatch.js'
import { resolveSupervisorScope } from '../supervisorScope.js'
import { toThailandDateString } from '../shiftAssignmentQueries.js'
import { getCompTimeBalance } from '../compTimeQueries.js'
import {
  SELECT_COMP_TIME_OFF_REQUEST,
  findCompTimeOffRequestById,
  listCompTimeOffRequests,
  listCompTimeOffRequestsForEmployee,
  listCompTimeOffRequestsPendingApproval,
  rowToCompTimeOffRequest,
  type CompTimeOffRequestRow,
} from '../compTimeOffRequestQueries.js'

export const compTimeOffRequestsRouter = Router()

type Queryable = Pick<pg.Pool, 'query'>

// Same split as leaveRequests.ts/overtimeRequests.ts: any HRM role may read
// the review queue, deciding one is a per-request check (resolveApprover),
// not a fixed role gate.
const canReadAdmin = requireRole(...ROLES)
const canDecideAsAdminOrEmployee = requireRoleOrEmployee(...ROLES)

function actorOf(req: Request): AuthUser | null {
  return req.auth ?? null
}

type CompTimeApproverKind = 'hr' | 'supervisor'

/** Same rule as resolveOvertimeApprover/resolveLeaveApprover: HR/Admin may
 *  always decide, at any stage; anyone else only while pending at the
 *  'supervisor' stage and only if they are the snapshotted
 *  supervisor_employee_id. */
async function resolveCompTimeApprover(
  actor: AuthUser,
  row: { status: string; currentStage: string | null; supervisorEmployeeId: number | null },
  db: Queryable
): Promise<CompTimeApproverKind | null> {
  if (actor.kind === 'employee') {
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

async function computeCanDecide(
  actor: AuthUser | null,
  request: { status: string; currentStage: string | null; supervisorEmployeeId: number | null },
  db: Queryable
): Promise<boolean> {
  if (!actor || request.status !== 'pending') return false
  return (await resolveCompTimeApprover(actor, request, db)) !== null
}

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

function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [year, month, day] = value.split('-').map(Number) as [number, number, number]
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

/** 'HH:MM' or 'HH:MM:SS' from the client, normalised to 'HH:MM:SS' — same
 *  helper as overtimeRequests.ts's normaliseTime. */
function normaliseTime(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const minutes = parseWallClockMinutes(value)
  if (minutes === null) return null
  const hh = String(Math.floor(minutes / 60)).padStart(2, '0')
  const mm = String(minutes % 60).padStart(2, '0')
  return `${hh}:${mm}:00`
}

function parseCompTimeOffRequestInput(body: unknown): ParseResult<CompTimeOffRequestInput> {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, message: 'body must be a JSON object' }
  }
  const raw = body as Record<string, unknown>

  const offDateRaw = raw['offDate']
  if (typeof offDateRaw !== 'string' || !isCalendarDate(offDateRaw)) {
    return { ok: false, message: 'offDate is required and must be a date as YYYY-MM-DD' }
  }

  const startTime = normaliseTime(raw['startTime'])
  if (startTime === null) return { ok: false, message: 'startTime is required and must be a time as HH:MM' }

  const endTime = normaliseTime(raw['endTime'])
  if (endTime === null) return { ok: false, message: 'endTime is required and must be a time as HH:MM' }

  const reason = requiredString(raw, 'reason', 1000)
  if (reason === null) return { ok: false, message: 'reason is required and must be 1000 characters or fewer' }

  return { ok: true, value: { offDate: offDateRaw, startTime, endTime, reason } }
}

function parseStatusFilter(
  value: string | string[] | undefined
): ParseResult<CompTimeOffRequestStatus | undefined> {
  if (value === undefined) return { ok: true, value: undefined }
  if (
    typeof value !== 'string' ||
    !COMP_TIME_OFF_REQUEST_STATUSES.includes(value as CompTimeOffRequestStatus)
  ) {
    return { ok: false, message: `status must be one of: ${COMP_TIME_OFF_REQUEST_STATUSES.join(', ')}` }
  }
  return { ok: true, value: value as CompTimeOffRequestStatus }
}

function currentThailandYear(): number {
  return Number(toThailandDateString(new Date()).slice(0, 4))
}

type ValidationOutcome =
  | { kind: 'ok'; requestedMinutes: number; availableMinutes: number }
  | { kind: 'employee-not-found' }
  | { kind: 'too-short' }
  | { kind: 'insufficient-balance'; availableMinutes: number; requestedMinutes: number }

/** Structural + balance validation shared by create and edit. requestedMinutes
 *  reuses computeOvertimeMinutes — it's generic wall-clock arithmetic (start,
 *  end, midnight-crossing) with no OT-specific meaning baked in, despite the
 *  name.
 *
 *  Balance is re-checked live rather than trusted from the client for the
 *  same reason validateOvertimeRequestInput re-validates at approval time:
 *  it can have changed (another request approved, a punch correction
 *  clawing back an accrual) since the number was last shown. excludeId lets
 *  an edit check its own new total without double-counting the pending
 *  request it's replacing. */
async function validateCompTimeOffRequestInput(
  employeeId: number,
  input: CompTimeOffRequestInput,
  excludeMinutes: number,
  db: Queryable = pool
): Promise<ValidationOutcome> {
  const employee = await findEmployeeById(employeeId, db)
  if (!employee) return { kind: 'employee-not-found' }

  const requestedMinutes = computeOvertimeMinutes(input.startTime, input.endTime)
  if (requestedMinutes === null || requestedMinutes <= 0) return { kind: 'too-short' }

  const balance = await getCompTimeBalance(employeeId, currentThailandYear(), db)
  const availableMinutes = balance.availableMinutes + excludeMinutes
  if (requestedMinutes > availableMinutes) {
    return { kind: 'insufficient-balance', availableMinutes, requestedMinutes }
  }

  return { kind: 'ok', requestedMinutes, availableMinutes }
}

function describeValidationOutcome(outcome: Exclude<ValidationOutcome, { kind: 'ok' }>): {
  status: number
  message: string
} {
  if (outcome.kind === 'employee-not-found') return { status: 404, message: 'employee not found' }
  if (outcome.kind === 'too-short') return { status: 400, message: 'ช่วงเวลาที่ขอต้องมากกว่า 0 นาที' }
  // outcome.kind === 'insufficient-balance'
  const availableHours = (outcome.availableMinutes / 60).toFixed(1)
  const requestedHours = (outcome.requestedMinutes / 60).toFixed(1)
  return {
    status: 400,
    message: `ยอดวันหยุดสะสมคงเหลือไม่พอ (คงเหลือ ${availableHours} ชั่วโมง, ขอ ${requestedHours} ชั่วโมง)`,
  }
}

function validationFail(res: Response, outcome: Exclude<ValidationOutcome, { kind: 'ok' }>): void {
  const { status, message } = describeValidationOutcome(outcome)
  fail(res, status, message)
}

compTimeOffRequestsRouter.post('/comp-time-off-requests', async (req: Request, res: Response) => {
  const employeeId = requireEmployeeId(req, res)
  if (employeeId === null) return

  const parsed = parseCompTimeOffRequestInput(req.body)
  if (!parsed.ok) return fail(res, 400, parsed.message)
  const input = parsed.value

  try {
    const outcome = await validateCompTimeOffRequestInput(employeeId, input, 0)
    if (outcome.kind !== 'ok') return validationFail(res, outcome)

    const employee = await findEmployeeById(employeeId)
    if (!employee) return fail(res, 404, `no employee with id ${employeeId}`)

    const supervisorEmployeeId = employee.employment.supervisorEmployeeId
    const requiresSupervisorApproval = supervisorEmployeeId !== null
    const currentStage: CompTimeOffRequestStage = requiresSupervisorApproval ? 'supervisor' : 'hr'

    const request = await withTransaction(async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO comp_time_off_requests
           (employee_id, off_date, start_time, end_time, requested_minutes, reason,
            requires_supervisor_approval, supervisor_employee_id, current_stage)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING id`,
        [
          employeeId,
          input.offDate,
          input.startTime,
          input.endTime,
          outcome.requestedMinutes,
          input.reason,
          requiresSupervisorApproval,
          supervisorEmployeeId,
          currentStage,
        ]
      )
      const created = rows[0]
      if (!created) throw new Error('insert into comp_time_off_requests returned no row')

      await recordAudit(client, {
        actor: { kind: 'employee', employeeId },
        action: 'comp_time_off_request.create',
        entityId: Number(created.id),
        detail: { offDate: input.offDate, requestedMinutes: outcome.requestedMinutes },
      })

      const { rows: selectRows } = await client.query<CompTimeOffRequestRow>(
        `${SELECT_COMP_TIME_OFF_REQUEST} WHERE ctr.id = $1`,
        [created.id]
      )
      const row = selectRows[0]
      if (!row) throw new Error('re-select of comp_time_off_requests returned no row')
      return rowToCompTimeOffRequest(row)
    })

    void notify({
      kind: 'created',
      resource: 'comp_time_off_request',
      requestId: request.id,
      requesterEmployeeId: employeeId,
      supervisorEmployeeId,
    })

    const body: CompTimeOffRequestResponse = { request }
    res.status(201).json(body)
  } catch (err) {
    handleUnexpected(res, err)
  }
})

compTimeOffRequestsRouter.get('/comp-time-off-requests/me', async (req: Request, res: Response) => {
  const employeeId = requireEmployeeId(req, res)
  if (employeeId === null) return

  try {
    const requests = await listCompTimeOffRequestsForEmployee(employeeId)
    const body: CompTimeOffRequestMineResponse = { requests }
    res.json(body)
  } catch (err) {
    handleUnexpected(res, err)
  }
})

// The current employee's own comp-time-off balance — wraps getCompTimeBalance
// (compTimeQueries.ts) for the current Thailand year, the same year the
// balance check above and the eventual usage ledger entry both use.
compTimeOffRequestsRouter.get('/comp-time-off-requests/balance', async (req: Request, res: Response) => {
  const employeeId = requireEmployeeId(req, res)
  if (employeeId === null) return

  try {
    const balance = await getCompTimeBalance(employeeId, currentThailandYear())
    const body: CompTimeBalanceResponse = { balance }
    res.json(body)
  } catch (err) {
    handleUnexpected(res, err)
  }
})

// Editable only while pending and not yet forwarded by a supervisor — same
// rule and same reasoning as overtimeRequests.ts's PUT.
compTimeOffRequestsRouter.put('/comp-time-off-requests/:id', async (req: Request, res: Response) => {
  const employeeId = requireEmployeeId(req, res)
  if (employeeId === null) return

  const id = parseId(req.params['id'])
  if (id === null) return fail(res, 400, 'id must be a positive integer')

  const parsed = parseCompTimeOffRequestInput(req.body)
  if (!parsed.ok) return fail(res, 400, parsed.message)
  const input = parsed.value

  try {
    const result = await withTransaction(async (client) => {
      const { rows } = await client.query<{
        employee_id: string
        status: string
        supervisor_approved_by_oid: string | null
        requested_minutes: number
      }>(
        `SELECT employee_id, status, supervisor_approved_by_oid, requested_minutes
         FROM comp_time_off_requests WHERE id = $1 FOR UPDATE`,
        [id]
      )
      const row = rows[0]
      if (!row) return { kind: 'not_found' as const }
      if (Number(row.employee_id) !== employeeId) return { kind: 'not_found' as const }
      if (row.status !== 'pending' || row.supervisor_approved_by_oid !== null) {
        return { kind: 'conflict' as const }
      }

      // excludeMinutes = this request's own current requested_minutes, so
      // editing it (even to ask for more) checks against the balance as if
      // this request weren't already counted in pendingRedemptionMinutes.
      const outcome = await validateCompTimeOffRequestInput(employeeId, input, row.requested_minutes, client)
      if (outcome.kind !== 'ok') return { kind: 'invalid' as const, outcome }

      const employee = await findEmployeeById(employeeId, client)
      if (!employee) return { kind: 'not_found' as const }

      const supervisorEmployeeId = employee.employment.supervisorEmployeeId
      const requiresSupervisorApproval = supervisorEmployeeId !== null
      const currentStage: CompTimeOffRequestStage = requiresSupervisorApproval ? 'supervisor' : 'hr'

      await client.query(
        `UPDATE comp_time_off_requests
         SET off_date = $2, start_time = $3, end_time = $4, requested_minutes = $5, reason = $6,
             requires_supervisor_approval = $7, supervisor_employee_id = $8, current_stage = $9,
             supervisor_approved_by_oid = NULL, supervisor_approved_by_name = NULL, supervisor_approved_at = NULL,
             updated_at = now()
         WHERE id = $1`,
        [
          id,
          input.offDate,
          input.startTime,
          input.endTime,
          outcome.requestedMinutes,
          input.reason,
          requiresSupervisorApproval,
          supervisorEmployeeId,
          currentStage,
        ]
      )

      await recordAudit(client, {
        actor: { kind: 'employee', employeeId },
        action: 'comp_time_off_request.update',
        entityId: id,
        detail: { offDate: input.offDate, requestedMinutes: outcome.requestedMinutes },
      })

      const { rows: selectRows } = await client.query<CompTimeOffRequestRow>(
        `${SELECT_COMP_TIME_OFF_REQUEST} WHERE ctr.id = $1`,
        [id]
      )
      const updated = selectRows[0]
      if (!updated) throw new Error('re-select of comp_time_off_requests returned no row')
      return { kind: 'ok' as const, request: rowToCompTimeOffRequest(updated) }
    })

    if (result.kind === 'not_found') return fail(res, 404, `no comp-time-off request with id ${id}`)
    if (result.kind === 'conflict') return fail(res, 409, 'คำขอนี้ถูกดำเนินการไปแล้ว ไม่สามารถแก้ไขได้')
    if (result.kind === 'invalid') return validationFail(res, result.outcome)

    const body: CompTimeOffRequestResponse = { request: result.request }
    res.json(body)
  } catch (err) {
    handleUnexpected(res, err)
  }
})

compTimeOffRequestsRouter.post('/comp-time-off-requests/:id/cancel', async (req: Request, res: Response) => {
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
         FROM comp_time_off_requests WHERE id = $1 FOR UPDATE`,
        [id]
      )
      const row = rows[0]
      if (!row) return { kind: 'not_found' as const }
      if (Number(row.employee_id) !== employeeId) return { kind: 'not_found' as const }
      if (row.status !== 'pending' || row.supervisor_approved_by_oid !== null) {
        return { kind: 'conflict' as const }
      }

      await client.query(
        `UPDATE comp_time_off_requests SET status = 'cancelled', current_stage = NULL, updated_at = now() WHERE id = $1`,
        [id]
      )

      await recordAudit(client, {
        actor: { kind: 'employee', employeeId },
        action: 'comp_time_off_request.cancel',
        entityId: id,
        detail: {},
      })

      const { rows: selectRows } = await client.query<CompTimeOffRequestRow>(
        `${SELECT_COMP_TIME_OFF_REQUEST} WHERE ctr.id = $1`,
        [id]
      )
      const updated = selectRows[0]
      if (!updated) throw new Error('re-select of comp_time_off_requests returned no row')
      return {
        kind: 'ok' as const,
        request: rowToCompTimeOffRequest(updated),
        supervisorEmployeeId: row.supervisor_employee_id === null ? null : Number(row.supervisor_employee_id),
      }
    })

    if (result.kind === 'not_found') return fail(res, 404, `no comp-time-off request with id ${id}`)
    if (result.kind === 'conflict') return fail(res, 409, 'คำขอนี้ถูกดำเนินการไปแล้ว ไม่สามารถยกเลิกได้')

    void notify({
      kind: 'cancelled',
      resource: 'comp_time_off_request',
      requestId: id,
      requesterEmployeeId: employeeId,
      supervisorEmployeeId: result.supervisorEmployeeId,
    })

    const body: CompTimeOffRequestResponse = { request: result.request }
    res.json(body)
  } catch (err) {
    handleUnexpected(res, err)
  }
})

compTimeOffRequestsRouter.get('/comp-time-off-requests', canReadAdmin, async (req: Request, res: Response) => {
  const statusResult = parseStatusFilter(req.query['status'] as string | string[] | undefined)
  if (!statusResult.ok) return fail(res, 400, statusResult.message)

  const page = parseOptionalPositiveInt(req.query['page'])
  if (page === undefined) return fail(res, 400, 'page must be a positive integer')

  const pageSize = parseOptionalPositiveInt(req.query['pageSize'])
  if (pageSize === undefined) return fail(res, 400, 'pageSize must be a positive integer')

  try {
    const result = await listCompTimeOffRequests(
      { status: statusResult.value },
      { ...(page !== null && { page }), ...(pageSize !== null && { pageSize }) }
    )
    const body: CompTimeOffRequestListResponse = result
    res.json(body)
  } catch (err) {
    handleUnexpected(res, err)
  }
})

compTimeOffRequestsRouter.get(
  '/comp-time-off-requests/pending-approval',
  canReadAdmin,
  async (req: Request, res: Response) => {
    const auth = actorOf(req)
    if (!auth) return fail(res, 500, 'server misconfigured')

    try {
      const scope = await resolveSupervisorScope(auth)
      if (scope.kind === 'none') {
        const body: CompTimeOffRequestPendingApprovalResponse = { requests: [] }
        return res.json(body)
      }

      const requests = await listCompTimeOffRequestsPendingApproval(
        scope.kind === 'all' ? null : scope.supervisorEmployeeId
      )
      const body: CompTimeOffRequestPendingApprovalResponse = { requests }
      res.json(body)
    } catch (err) {
      handleUnexpected(res, err)
    }
  }
)

compTimeOffRequestsRouter.get('/comp-time-off-requests/:id', canReadAdmin, async (req: Request, res: Response) => {
  const id = parseId(req.params['id'])
  if (id === null) return fail(res, 400, 'id must be a positive integer')

  try {
    const request = await findCompTimeOffRequestById(id)
    if (!request) return fail(res, 404, `no comp-time-off request with id ${id}`)

    const canDecide = await computeCanDecide(actorOf(req), request, pool)
    const body: CompTimeOffRequestDetailResponse = { request, canDecide }
    res.json(body)
  } catch (err) {
    handleUnexpected(res, err)
  }
})

compTimeOffRequestsRouter.post(
  '/comp-time-off-requests/:id/approve',
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
          off_date: string
          requested_minutes: number
          status: string
          current_stage: string | null
          supervisor_employee_id: string | null
        }>(
          `SELECT employee_id, off_date, requested_minutes, status, current_stage, supervisor_employee_id
           FROM comp_time_off_requests WHERE id = $1 FOR UPDATE`,
          [id]
        )
        const row = rows[0]
        if (!row) return { kind: 'not_found' as const }
        if (row.status !== 'pending') return { kind: 'conflict' as const, message: 'คำขอนี้ถูกดำเนินการไปแล้ว' }

        const approverKind = await resolveCompTimeApprover(
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
          await client.query(
            `UPDATE comp_time_off_requests
             SET current_stage = 'hr', supervisor_approved_by_oid = $2,
                 supervisor_approved_by_name = $3, supervisor_approved_at = now(), updated_at = now()
             WHERE id = $1`,
            [id, actorInfo.oid, actorInfo.name]
          )

          await recordAudit(client, {
            actor,
            action: 'comp_time_off_request.supervisor_approve',
            entityId: id,
            detail: {},
          })

          const request = await findCompTimeOffRequestById(id, client)
          if (!request) throw new Error('re-select of comp_time_off_requests returned no row')
          const canDecide = await computeCanDecide(actor, request, client)
          return { kind: 'ok' as const, request, canDecide }
        }

        // Final decision: re-check the balance live (it can have moved since
        // submission — another redemption approved, an accrual corrected)
        // before posting the usage entry that actually spends it.
        const employeeId = Number(row.employee_id)
        const year = currentThailandYear()
        const balance = await getCompTimeBalance(employeeId, year, client)
        // This request's own requested_minutes is still counted in
        // pendingRedemptionMinutes at this point (still 'pending' until the
        // UPDATE below), so availableMinutes already excludes it correctly —
        // no manual add-back needed here, unlike the create/edit routes.
        if (row.requested_minutes > balance.availableMinutes) {
          return {
            kind: 'stale' as const,
            message: `ยอดวันหยุดสะสมคงเหลือไม่พอแล้ว (คงเหลือ ${(balance.availableMinutes / 60).toFixed(1)} ชั่วโมง) กรุณาปฏิเสธคำขอนี้`,
          }
        }

        await client.query(
          `INSERT INTO overtime_comp_time_entries
             (employee_id, year, entry_type, amount_minutes, source_redemption_id, created_by_oid, created_by_name)
           VALUES ($1, $2, 'usage', $3, $4, $5, $6)`,
          [employeeId, year, -row.requested_minutes, id, actorInfo.oid, actorInfo.name]
        )

        await client.query(
          `UPDATE comp_time_off_requests
           SET status = 'approved', current_stage = NULL, decided_by_oid = $2, decided_by_name = $3,
               decided_at = now(), updated_at = now()
           WHERE id = $1`,
          [id, actorInfo.oid, actorInfo.name]
        )

        await recordAudit(client, {
          actor,
          action: 'comp_time_off_request.approve',
          entityId: id,
          detail: { requestedMinutes: row.requested_minutes },
        })

        const request = await findCompTimeOffRequestById(id, client)
        if (!request) throw new Error('re-select of comp_time_off_requests returned no row')
        return { kind: 'ok' as const, request, canDecide: false }
      })

      if (result.kind === 'not_found') return fail(res, 404, `no comp-time-off request with id ${id}`)
      if (result.kind === 'conflict') return fail(res, 409, result.message)
      if (result.kind === 'forbidden') return fail(res, 403, 'คุณไม่มีสิทธิ์อนุมัติคำขอนี้', 'FORBIDDEN')
      if (result.kind === 'stale') return fail(res, 409, result.message)

      void notify(
        result.request.status === 'approved'
          ? {
              kind: 'approved',
              resource: 'comp_time_off_request',
              requestId: id,
              requesterEmployeeId: result.request.employeeId,
            }
          : {
              kind: 'supervisor_approved',
              resource: 'comp_time_off_request',
              requestId: id,
              requesterEmployeeId: result.request.employeeId,
            }
      )

      const body: CompTimeOffRequestDetailResponse = { request: result.request, canDecide: result.canDecide }
      res.json(body)
    } catch (err) {
      handleUnexpected(res, err)
    }
  }
)

compTimeOffRequestsRouter.post(
  '/comp-time-off-requests/:id/reject',
  canDecideAsAdminOrEmployee,
  async (req: Request, res: Response) => {
    const actor = actorOf(req)
    if (!actor) return fail(res, 500, 'server misconfigured')

    const id = parseId(req.params['id'])
    if (id === null) return fail(res, 400, 'id must be a positive integer')

    const body = req.body as Partial<CompTimeOffRequestRejectRequest> | null
    const reason = requiredString((body ?? {}) as Record<string, unknown>, 'reason', 1000)
    if (reason === null) return fail(res, 400, 'reason is required and must be 1000 characters or fewer')

    try {
      const result = await withTransaction(async (client) => {
        const { rows } = await client.query<{
          status: string
          current_stage: string | null
          supervisor_employee_id: string | null
        }>(
          `SELECT status, current_stage, supervisor_employee_id FROM comp_time_off_requests WHERE id = $1 FOR UPDATE`,
          [id]
        )
        const row = rows[0]
        if (!row) return { kind: 'not_found' as const }
        if (row.status !== 'pending') return { kind: 'conflict' as const }

        const approverKind = await resolveCompTimeApprover(
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
          `UPDATE comp_time_off_requests
           SET status = 'rejected', current_stage = NULL, decided_by_oid = $2, decided_by_name = $3,
               decided_at = now(), decision_reason = $4, updated_at = now()
           WHERE id = $1`,
          [id, actorInfo.oid, actorInfo.name, reason]
        )

        await recordAudit(client, {
          actor,
          action: 'comp_time_off_request.reject',
          entityId: id,
          detail: { reason, decidedAsSupervisor: approverKind === 'supervisor' },
        })

        const request = await findCompTimeOffRequestById(id, client)
        if (!request) throw new Error('re-select of comp_time_off_requests returned no row')
        return { kind: 'ok' as const, request, canDecide: false }
      })

      if (result.kind === 'not_found') return fail(res, 404, `no comp-time-off request with id ${id}`)
      if (result.kind === 'conflict') return fail(res, 409, 'คำขอนี้ถูกดำเนินการไปแล้ว')
      if (result.kind === 'forbidden') return fail(res, 403, 'คุณไม่มีสิทธิ์ปฏิเสธคำขอนี้', 'FORBIDDEN')

      void notify({
        kind: 'rejected',
        resource: 'comp_time_off_request',
        requestId: id,
        requesterEmployeeId: result.request.employeeId,
        reason,
      })

      const responseBody: CompTimeOffRequestDetailResponse = { request: result.request, canDecide: result.canDecide }
      res.json(responseBody)
    } catch (err) {
      handleUnexpected(res, err)
    }
  }
)
