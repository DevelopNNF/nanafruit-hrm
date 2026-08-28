import { Router } from 'express'
import type { Request, Response } from 'express'
import type pg from 'pg'
import {
  OFF_SITE_WORK_REQUEST_STATUSES,
  ROLES,
  type AuthUser,
  type OffSiteWorkRequestDetailResponse,
  type OffSiteWorkRequestInput,
  type OffSiteWorkRequestListResponse,
  type OffSiteWorkRequestPendingApprovalResponse,
  type OffSiteWorkRequestMineResponse,
  type OffSiteWorkRequestRejectRequest,
  type OffSiteWorkRequestResponse,
  type OffSiteWorkRequestStage,
  type OffSiteWorkRequestStatus,
} from '@hrm/shared'
import { pool, withTransaction } from '../db.js'
import { requireRole, requireRoleOrEmployee } from '../auth/middleware.js'
import { recordAudit } from '../audit.js'
import { fail, handleUnexpected, parseOptionalPositiveInt } from '../http.js'
import { describeActor, findEmployeeById, findEmployeeIdByEntraUpn } from '../employeeQueries.js'
import { notify } from '../notifications/dispatch.js'
import { resolveSupervisorScope } from '../supervisorScope.js'
import {
  SELECT_OFF_SITE_WORK_REQUEST,
  findOffSiteWorkRequestById,
  hasOverlappingLeaveOnDates,
  hasOverlappingOffSiteWorkRequest,
  listOffSiteWorkRequests,
  listOffSiteWorkRequestsForEmployee,
  listOffSiteWorkRequestsPendingApproval,
  rowToOffSiteWorkRequest,
  type OffSiteWorkRequestRow,
} from '../offSiteRequestQueries.js'

export const offSiteRequestsRouter = Router()

type Queryable = Pick<pg.Pool, 'query'>

// Same read/decide split as leaveRequests.ts: any HRM role may look at the
// review queue; deciding one is gated per-request by resolveOffSiteApprover
// once the row (and its current_stage) is loaded.
const canReadAdmin = requireRole(...ROLES)
const canDecideAsAdminOrEmployee = requireRoleOrEmployee(...ROLES)

function actorOf(req: Request): AuthUser | null {
  return req.auth ?? null
}

type OffSiteApproverKind = 'hr' | 'supervisor'

/** Who, if anyone, may decide this request right now — identical rule to
 *  resolveLeaveApprover in leaveRequests.ts. */
export async function resolveOffSiteApprover(
  actor: AuthUser,
  row: { status: string; currentStage: string | null; supervisorEmployeeId: number | null },
  db: Queryable
): Promise<OffSiteApproverKind | null> {
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
  return (await resolveOffSiteApprover(actor, request, db)) !== null
}

/** POST /off-site-work-requests and its /me, /:id/cancel siblings are for the
 *  employee arm of AuthUser only. */
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

function parseDateOnly(value: unknown): string | null {
  if (typeof value !== 'string' || !DATE_ONLY_RE.test(value)) return null
  return Number.isNaN(new Date(`${value}T00:00:00Z`).getTime()) ? null : value
}

function parseCoordinate(value: unknown, min: number, max: number): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) return null
  return value
}

/** Minimum notice this request type requires, per HR's confirmed rule — fixed
 *  at 1 day, unlike leave_requests' per-leave-type advanceNoticeDays, since
 *  there is only ever one kind of off-site request. */
const MIN_ADVANCE_NOTICE_DAYS = 1

function parseOffSiteWorkRequestInput(body: unknown): ParseResult<OffSiteWorkRequestInput> {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, message: 'body must be a JSON object' }
  }
  const raw = body as Record<string, unknown>

  const placeName = requiredString(raw, 'placeName', 200)
  if (placeName === null) return { ok: false, message: 'placeName is required and must be 200 characters or fewer' }

  const latitude = parseCoordinate(raw['latitude'], -90, 90)
  if (latitude === null) return { ok: false, message: 'latitude is required and must be a number between -90 and 90' }

  const longitude = parseCoordinate(raw['longitude'], -180, 180)
  if (longitude === null) return { ok: false, message: 'longitude is required and must be a number between -180 and 180' }

  const startDate = parseDateOnly(raw['startDate'])
  if (startDate === null) return { ok: false, message: 'startDate is required and must be a YYYY-MM-DD date' }

  const endDate = parseDateOnly(raw['endDate'])
  if (endDate === null) return { ok: false, message: 'endDate is required and must be a YYYY-MM-DD date' }

  if (endDate < startDate) return { ok: false, message: 'endDate must not be before startDate' }

  const reason = requiredString(raw, 'reason', 1000)
  if (reason === null) return { ok: false, message: 'reason is required and must be 1000 characters or fewer' }

  return { ok: true, value: { placeName, latitude, longitude, startDate, endDate, reason } }
}

function parseStatusFilter(
  value: string | string[] | undefined
): ParseResult<OffSiteWorkRequestStatus | undefined> {
  if (value === undefined) return { ok: true, value: undefined }
  if (typeof value !== 'string' || !OFF_SITE_WORK_REQUEST_STATUSES.includes(value as OffSiteWorkRequestStatus)) {
    return { ok: false, message: `status must be one of: ${OFF_SITE_WORK_REQUEST_STATUSES.join(', ')}` }
  }
  return { ok: true, value: value as OffSiteWorkRequestStatus }
}

/** 'Today' in Thailand, regardless of the server's own timezone — same
 *  standing assumption as leaveRequests.ts' thailandToday. */
function thailandToday(): string {
  const bangkokNow = new Date(Date.now() + 7 * 60 * 60 * 1000)
  return bangkokNow.toISOString().slice(0, 10)
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

offSiteRequestsRouter.post('/off-site-work-requests', async (req: Request, res: Response) => {
  const employeeId = requireEmployeeId(req, res)
  if (employeeId === null) return

  const parsed = parseOffSiteWorkRequestInput(req.body)
  if (!parsed.ok) return fail(res, 400, parsed.message)
  const input = parsed.value

  try {
    const employee = await findEmployeeById(employeeId)
    if (!employee) return fail(res, 404, `no employee with id ${employeeId}`)

    const minStartDate = addDays(thailandToday(), MIN_ADVANCE_NOTICE_DAYS)
    if (input.startDate < minStartDate) {
      return fail(
        res,
        400,
        `คำขอทำงานนอกสถานที่ต้องแจ้งล่วงหน้าอย่างน้อย ${MIN_ADVANCE_NOTICE_DAYS} วัน — วันที่เร็วที่สุดที่ขอได้คือ ${minStartDate}`
      )
    }

    const [overlappingOffSite, overlappingLeave] = await Promise.all([
      hasOverlappingOffSiteWorkRequest(employeeId, input.startDate, input.endDate),
      hasOverlappingLeaveOnDates(employeeId, input.startDate, input.endDate),
    ])
    if (overlappingOffSite) {
      return fail(res, 409, 'ช่วงวันที่นี้ทับซ้อนกับคำขอทำงานนอกสถานที่อื่นที่ยังรออนุมัติหรืออนุมัติแล้วของคุณ')
    }
    if (overlappingLeave) {
      return fail(res, 409, 'ช่วงวันที่นี้ทับซ้อนกับคำขอลาที่ยังรออนุมัติหรืออนุมัติแล้วของคุณ')
    }

    // Snapshotted from employment_details.supervisor_employee_id, same as
    // leave_requests. No supervisor means the request skips straight to the
    // HR/Admin stage.
    const supervisorEmployeeId = employee.employment.supervisorEmployeeId
    const currentStage: OffSiteWorkRequestStage = supervisorEmployeeId !== null ? 'supervisor' : 'hr'

    const request = await withTransaction(async (client) => {
      const { rows } = await client.query<{ id: string; created_at: string }>(
        `INSERT INTO off_site_work_requests
           (employee_id, place_name, latitude, longitude, start_date, end_date, reason,
            supervisor_employee_id, current_stage)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING id, created_at`,
        [
          employeeId,
          input.placeName,
          input.latitude,
          input.longitude,
          input.startDate,
          input.endDate,
          input.reason,
          supervisorEmployeeId,
          currentStage,
        ]
      )
      const created = rows[0]
      if (!created) throw new Error('insert into off_site_work_requests returned no row')

      await recordAudit(client, {
        actor: { kind: 'employee', employeeId },
        action: 'off_site_work_request.create',
        entityId: Number(created.id),
        detail: { placeName: input.placeName, startDate: input.startDate, endDate: input.endDate },
      })

      return rowToOffSiteWorkRequest({
        id: created.id,
        employee_id: String(employeeId),
        place_name: input.placeName,
        latitude: String(input.latitude),
        longitude: String(input.longitude),
        start_date: input.startDate,
        end_date: input.endDate,
        reason: input.reason,
        status: 'pending',
        supervisor_employee_id: supervisorEmployeeId === null ? null : String(supervisorEmployeeId),
        supervisor_employee_name: employee.employment.supervisorEmployeeName,
        current_stage: currentStage,
        supervisor_approved_by_name: null,
        supervisor_approved_at: null,
        decided_by_name: null,
        decided_at: null,
        decision_reason: null,
        created_at: created.created_at,
      })
    })

    void notify({
      kind: 'created',
      resource: 'off_site_work_request',
      requestId: request.id,
      requesterEmployeeId: employeeId,
      supervisorEmployeeId,
    })

    const body: OffSiteWorkRequestResponse = { request }
    res.status(201).json(body)
  } catch (err) {
    handleUnexpected(res, err)
  }
})

offSiteRequestsRouter.get('/off-site-work-requests/me', async (req: Request, res: Response) => {
  const employeeId = requireEmployeeId(req, res)
  if (employeeId === null) return

  try {
    const requests = await listOffSiteWorkRequestsForEmployee(employeeId)
    const body: OffSiteWorkRequestMineResponse = { requests }
    res.json(body)
  } catch (err) {
    handleUnexpected(res, err)
  }
})

offSiteRequestsRouter.post('/off-site-work-requests/:id/cancel', async (req: Request, res: Response) => {
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
         FROM off_site_work_requests WHERE id = $1 FOR UPDATE`,
        [id]
      )
      const row = rows[0]
      if (!row) return { kind: 'not_found' as const }
      if (Number(row.employee_id) !== employeeId) return { kind: 'not_found' as const }
      // Blocked once the supervisor has already forwarded it — same reasoning
      // as leaveRequests.ts' cancel route.
      if (row.status !== 'pending' || row.supervisor_approved_by_oid !== null) {
        return { kind: 'conflict' as const }
      }

      await client.query(
        `UPDATE off_site_work_requests SET status = 'cancelled', current_stage = NULL, updated_at = now() WHERE id = $1`,
        [id]
      )

      await recordAudit(client, {
        actor: { kind: 'employee', employeeId },
        action: 'off_site_work_request.cancel',
        entityId: id,
        detail: {},
      })

      const { rows: updatedRows } = await client.query<OffSiteWorkRequestRow>(
        `${SELECT_OFF_SITE_WORK_REQUEST} WHERE r.id = $1`,
        [id]
      )
      const updated = updatedRows[0]
      if (!updated) throw new Error('re-select of off_site_work_requests returned no row')
      return {
        kind: 'ok' as const,
        request: rowToOffSiteWorkRequest(updated),
        supervisorEmployeeId: row.supervisor_employee_id === null ? null : Number(row.supervisor_employee_id),
      }
    })

    if (result.kind === 'not_found') return fail(res, 404, `no off-site work request with id ${id}`)
    if (result.kind === 'conflict') return fail(res, 409, 'คำขอนี้ถูกดำเนินการไปแล้ว ไม่สามารถยกเลิกได้')

    void notify({
      kind: 'cancelled',
      resource: 'off_site_work_request',
      requestId: id,
      requesterEmployeeId: employeeId,
      supervisorEmployeeId: result.supervisorEmployeeId,
    })

    const body: OffSiteWorkRequestResponse = { request: result.request }
    res.json(body)
  } catch (err) {
    handleUnexpected(res, err)
  }
})

offSiteRequestsRouter.get('/off-site-work-requests', canReadAdmin, async (req: Request, res: Response) => {
  const statusResult = parseStatusFilter(req.query['status'] as string | string[] | undefined)
  if (!statusResult.ok) return fail(res, 400, statusResult.message)

  const page = parseOptionalPositiveInt(req.query['page'])
  if (page === undefined) return fail(res, 400, 'page must be a positive integer')

  const pageSize = parseOptionalPositiveInt(req.query['pageSize'])
  if (pageSize === undefined) return fail(res, 400, 'pageSize must be a positive integer')

  try {
    const result = await listOffSiteWorkRequests(
      { status: statusResult.value },
      { ...(page !== null && { page }), ...(pageSize !== null && { pageSize }) }
    )
    const body: OffSiteWorkRequestListResponse = result
    res.json(body)
  } catch (err) {
    handleUnexpected(res, err)
  }
})

// A supervisor's inbox — mounted ahead of GET /off-site-work-requests/:id so
// 'pending-approval' is never parsed as an id.
offSiteRequestsRouter.get(
  '/off-site-work-requests/pending-approval',
  canReadAdmin,
  async (req: Request, res: Response) => {
    const auth = actorOf(req)
    if (!auth) return fail(res, 500, 'server misconfigured')

    try {
      const scope = await resolveSupervisorScope(auth)
      if (scope.kind === 'none') {
        const body: OffSiteWorkRequestPendingApprovalResponse = { requests: [] }
        return res.json(body)
      }

      const requests = await listOffSiteWorkRequestsPendingApproval(
        scope.kind === 'all' ? null : scope.supervisorEmployeeId
      )
      const body: OffSiteWorkRequestPendingApprovalResponse = { requests }
      res.json(body)
    } catch (err) {
      handleUnexpected(res, err)
    }
  }
)

offSiteRequestsRouter.get('/off-site-work-requests/:id', canReadAdmin, async (req: Request, res: Response) => {
  const id = parseId(req.params['id'])
  if (id === null) return fail(res, 400, 'id must be a positive integer')

  try {
    const request = await findOffSiteWorkRequestById(id)
    if (!request) return fail(res, 404, `no off-site work request with id ${id}`)

    const canDecide = await computeCanDecide(actorOf(req), request, pool)
    const body: OffSiteWorkRequestDetailResponse = { request, canDecide }
    res.json(body)
  } catch (err) {
    handleUnexpected(res, err)
  }
})

offSiteRequestsRouter.post(
  '/off-site-work-requests/:id/approve',
  canDecideAsAdminOrEmployee,
  async (req: Request, res: Response) => {
    const actor = actorOf(req)
    if (!actor) return fail(res, 500, 'server misconfigured')

    const id = parseId(req.params['id'])
    if (id === null) return fail(res, 400, 'id must be a positive integer')

    try {
      const result = await withTransaction(async (client) => {
        const { rows } = await client.query<{
          status: string
          current_stage: string | null
          supervisor_employee_id: string | null
        }>(
          `SELECT status, current_stage, supervisor_employee_id
           FROM off_site_work_requests WHERE id = $1 FOR UPDATE`,
          [id]
        )
        const row = rows[0]
        if (!row) return { kind: 'not_found' as const }
        if (row.status !== 'pending') return { kind: 'conflict' as const, message: 'คำขอนี้ถูกดำเนินการไปแล้ว' }

        const approverKind = await resolveOffSiteApprover(
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
          // on HR/Admin, same as leaveRequests.ts.
          await client.query(
            `UPDATE off_site_work_requests
             SET current_stage = 'hr', supervisor_approved_by_oid = $2,
                 supervisor_approved_by_name = $3, supervisor_approved_at = now(), updated_at = now()
             WHERE id = $1`,
            [id, actorInfo.oid, actorInfo.name]
          )

          await recordAudit(client, {
            actor,
            action: 'off_site_work_request.supervisor_approve',
            entityId: id,
            detail: {},
          })

          const request = await findOffSiteWorkRequestById(id, client)
          if (!request) throw new Error('re-select of off_site_work_requests returned no row')
          const canDecide = await computeCanDecide(actor, request, client)
          return { kind: 'ok' as const, request, canDecide }
        }

        // HR/Admin's final decision — the request now lets the employee clock
        // in at its own coordinates for [start_date, end_date] (see the
        // geofence branch in POST /attendance/clock).
        await client.query(
          `UPDATE off_site_work_requests
           SET status = 'approved', current_stage = NULL, decided_by_oid = $2, decided_by_name = $3,
               decided_at = now(), updated_at = now()
           WHERE id = $1`,
          [id, actorInfo.oid, actorInfo.name]
        )

        await recordAudit(client, {
          actor,
          action: 'off_site_work_request.approve',
          entityId: id,
          detail: {},
        })

        const request = await findOffSiteWorkRequestById(id, client)
        if (!request) throw new Error('re-select of off_site_work_requests returned no row')
        return { kind: 'ok' as const, request, canDecide: false }
      })

      if (result.kind === 'not_found') return fail(res, 404, `no off-site work request with id ${id}`)
      if (result.kind === 'conflict') return fail(res, 409, result.message)
      if (result.kind === 'forbidden') return fail(res, 403, 'คุณไม่มีสิทธิ์อนุมัติคำขอนี้', 'FORBIDDEN')

      void notify(
        result.request.status === 'approved'
          ? {
              kind: 'approved',
              resource: 'off_site_work_request',
              requestId: id,
              requesterEmployeeId: result.request.employeeId,
            }
          : {
              kind: 'supervisor_approved',
              resource: 'off_site_work_request',
              requestId: id,
              requesterEmployeeId: result.request.employeeId,
            }
      )

      const body: OffSiteWorkRequestDetailResponse = { request: result.request, canDecide: result.canDecide }
      res.json(body)
    } catch (err) {
      handleUnexpected(res, err)
    }
  }
)

offSiteRequestsRouter.post(
  '/off-site-work-requests/:id/reject',
  canDecideAsAdminOrEmployee,
  async (req: Request, res: Response) => {
    const actor = actorOf(req)
    if (!actor) return fail(res, 500, 'server misconfigured')

    const id = parseId(req.params['id'])
    if (id === null) return fail(res, 400, 'id must be a positive integer')

    const body = req.body as Partial<OffSiteWorkRequestRejectRequest> | null
    const reason = requiredString((body ?? {}) as Record<string, unknown>, 'reason', 1000)
    if (reason === null) return fail(res, 400, 'reason is required and must be 1000 characters or fewer')

    try {
      const result = await withTransaction(async (client) => {
        const { rows } = await client.query<{
          status: string
          current_stage: string | null
          supervisor_employee_id: string | null
        }>(
          `SELECT status, current_stage, supervisor_employee_id FROM off_site_work_requests WHERE id = $1 FOR UPDATE`,
          [id]
        )
        const row = rows[0]
        if (!row) return { kind: 'not_found' as const }
        if (row.status !== 'pending') return { kind: 'conflict' as const }

        const approverKind = await resolveOffSiteApprover(
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
          `UPDATE off_site_work_requests
           SET status = 'rejected', current_stage = NULL, decided_by_oid = $2, decided_by_name = $3,
               decided_at = now(), decision_reason = $4, updated_at = now()
           WHERE id = $1`,
          [id, actorInfo.oid, actorInfo.name, reason]
        )

        await recordAudit(client, {
          actor,
          action: 'off_site_work_request.reject',
          entityId: id,
          detail: { reason, decidedAsSupervisor: approverKind === 'supervisor' },
        })

        const request = await findOffSiteWorkRequestById(id, client)
        if (!request) throw new Error('re-select of off_site_work_requests returned no row')
        return { kind: 'ok' as const, request, canDecide: false }
      })

      if (result.kind === 'not_found') return fail(res, 404, `no off-site work request with id ${id}`)
      if (result.kind === 'conflict') return fail(res, 409, 'คำขอนี้ถูกดำเนินการไปแล้ว')
      if (result.kind === 'forbidden') return fail(res, 403, 'คุณไม่มีสิทธิ์ปฏิเสธคำขอนี้', 'FORBIDDEN')

      void notify({
        kind: 'rejected',
        resource: 'off_site_work_request',
        requestId: id,
        requesterEmployeeId: result.request.employeeId,
        reason,
      })

      const responseBody: OffSiteWorkRequestDetailResponse = { request: result.request, canDecide: result.canDecide }
      res.json(responseBody)
    } catch (err) {
      handleUnexpected(res, err)
    }
  }
)
