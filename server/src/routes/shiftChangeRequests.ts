import { Router } from 'express'
import type { Request, Response } from 'express'
import {
  ROLES,
  SHIFT_CHANGE_REQUEST_STATUSES,
  type AuthUser,
  type ShiftChangeAttachmentPresignResponse,
  type ShiftChangeAttachmentResponse,
  type ShiftChangeRequestDetailResponse,
  type ShiftChangeRequestInput,
  type ShiftChangeRequestListResponse,
  type ShiftChangeRequestMineResponse,
  type ShiftChangeRequestRejectRequest,
  type ShiftChangeRequestResponse,
  type ShiftChangeRequestStatus,
} from '@hrm/shared'
import { pool, withTransaction } from '../db.js'
import { requireRole } from '../auth/middleware.js'
import { recordAudit } from '../audit.js'
import { fail, handleUnexpected } from '../http.js'
import { findEmployeeById } from '../employeeQueries.js'
import { findShiftById } from '../shiftQueries.js'
import {
  createShiftChange,
  getShiftIdForDate,
  toThailandDateString,
} from '../shiftAssignmentQueries.js'
import {
  SELECT_SHIFT_CHANGE_REQUEST,
  findShiftChangeRequestById,
  hasConflictingShiftChangeRequest,
  listShiftChangeRequests,
  listShiftChangeRequestsForEmployee,
  rowToShiftChangeRequest,
  type ShiftChangeRequestRow,
} from '../shiftChangeRequestQueries.js'
import {
  deleteAttachmentObject,
  headAttachment,
  presignAttachmentUpload,
  presignAttachmentView,
} from '../storage/shiftChangeAttachments.js'

export const shiftChangeRequestsRouter = Router()

// Same split as time corrections/leave requests: any HRM role may look at the
// review queue, only HR and Admin may decide it.
const canReadAdmin = requireRole(...ROLES)
const canDecide = requireRole('HRM.HR', 'HRM.Admin')

function actorOf(req: Request): AuthUser | null {
  return req.auth ?? null
}

/** POST /shift-change-requests and its /me, /:id, /:id/cancel,
 *  /:id/attachment/* siblings are for the employee arm of AuthUser only — an
 *  admin token has no employeeId to submit, edit or cancel a request as,
 *  same reasoning as leaveRequests.ts. */
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
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  )
}

function parseShiftChangeRequestInput(body: unknown): ParseResult<ShiftChangeRequestInput> {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, message: 'body must be a JSON object' }
  }
  const raw = body as Record<string, unknown>

  const requestedDateRaw = raw['requestedDate']
  if (typeof requestedDateRaw !== 'string' || !isCalendarDate(requestedDateRaw)) {
    return { ok: false, message: 'requestedDate is required and must be a date as YYYY-MM-DD' }
  }

  const newShiftIdRaw = raw['newShiftId']
  if (typeof newShiftIdRaw !== 'number' || !Number.isInteger(newShiftIdRaw) || newShiftIdRaw <= 0) {
    return { ok: false, message: 'newShiftId is required and must be a positive integer' }
  }

  const reason = requiredString(raw, 'reason', 1000)
  if (reason === null) return { ok: false, message: 'reason is required and must be 1000 characters or fewer' }

  return { ok: true, value: { requestedDate: requestedDateRaw, newShiftId: newShiftIdRaw, reason } }
}

function parseStatusFilter(
  value: string | string[] | undefined
): ParseResult<ShiftChangeRequestStatus | undefined> {
  if (value === undefined) return { ok: true, value: undefined }
  if (typeof value !== 'string' || !SHIFT_CHANGE_REQUEST_STATUSES.includes(value as ShiftChangeRequestStatus)) {
    return { ok: false, message: `status must be one of: ${SHIFT_CHANGE_REQUEST_STATUSES.join(', ')}` }
  }
  return { ok: true, value: value as ShiftChangeRequestStatus }
}

/**
 * Structural + reference validation shared by create and edit: the shift
 * must exist and be active, the date can't be in the past or before the
 * employee was hired, and it can't collide with another live request of the
 * employee's own. Returns a fail() reason rather than calling fail() itself,
 * so both call sites can label the 404/409 the same way their own route
 * already does.
 */
async function validateShiftChangeRequestInput(
  employeeId: number,
  input: ShiftChangeRequestInput,
  excludeId: number | null
): Promise<
  | { kind: 'ok'; hireDate: string }
  | { kind: 'employee-not-found' }
  | { kind: 'shift-not-found' }
  | { kind: 'shift-inactive' }
  | { kind: 'backdated' }
  | { kind: 'before-hire' }
  | { kind: 'conflict' }
> {
  const employee = await findEmployeeById(employeeId)
  if (!employee) return { kind: 'employee-not-found' }

  const shift = await findShiftById(input.newShiftId)
  if (!shift) return { kind: 'shift-not-found' }
  if (!shift.isActive) return { kind: 'shift-inactive' }

  // No backdating: attendance already snapshots the shift that applied at
  // clock-in time, same rule as POST /api/employees/:id/shift-changes.
  const today = toThailandDateString(new Date())
  if (input.requestedDate < today) return { kind: 'backdated' }
  if (input.requestedDate < employee.employment.hireDate) return { kind: 'before-hire' }

  const conflicting = await hasConflictingShiftChangeRequest(employeeId, input.requestedDate, excludeId)
  if (conflicting) return { kind: 'conflict' }

  return { kind: 'ok', hireDate: employee.employment.hireDate }
}

function validationFail(
  res: Response,
  outcome:
    | { kind: 'employee-not-found' }
    | { kind: 'shift-not-found' }
    | { kind: 'shift-inactive' }
    | { kind: 'backdated' }
    | { kind: 'before-hire' }
    | { kind: 'conflict' }
): void {
  if (outcome.kind === 'employee-not-found') return fail(res, 404, 'employee not found')
  if (outcome.kind === 'shift-not-found') return fail(res, 400, 'no shift with the given newShiftId')
  if (outcome.kind === 'shift-inactive') return fail(res, 400, 'กะที่เลือกไม่เปิดใช้งานแล้ว')
  if (outcome.kind === 'backdated') {
    return fail(res, 400, 'requestedDate ต้องเป็นวันนี้หรือวันในอนาคตเท่านั้น ไม่สามารถขอเปลี่ยนกะย้อนหลังได้')
  }
  if (outcome.kind === 'before-hire') return fail(res, 400, 'requestedDate ต้องไม่ก่อนวันที่เริ่มงาน')
  if (outcome.kind === 'conflict') {
    return fail(res, 409, 'มีคำขอเปลี่ยนกะอื่นสำหรับวันที่นี้ที่ยังรออนุมัติหรืออนุมัติแล้วอยู่แล้ว')
  }
}

shiftChangeRequestsRouter.post('/shift-change-requests', async (req: Request, res: Response) => {
  const employeeId = requireEmployeeId(req, res)
  if (employeeId === null) return

  const parsed = parseShiftChangeRequestInput(req.body)
  if (!parsed.ok) return fail(res, 400, parsed.message)
  const input = parsed.value

  try {
    const outcome = await validateShiftChangeRequestInput(employeeId, input, null)
    if (outcome.kind !== 'ok') return validationFail(res, outcome)

    const currentShiftId = await getShiftIdForDate(employeeId, input.requestedDate)

    const request = await withTransaction(async (client) => {
      const { rows } = await client.query<{ id: string; created_at: string; updated_at: string }>(
        `INSERT INTO shift_change_requests
           (employee_id, requested_date, current_shift_id, new_shift_id, reason)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, created_at, updated_at`,
        [employeeId, input.requestedDate, currentShiftId, input.newShiftId, input.reason]
      )
      const created = rows[0]
      if (!created) throw new Error('insert into shift_change_requests returned no row')

      await recordAudit(client, {
        actor: { kind: 'employee', employeeId },
        action: 'shift_change_request.create',
        entityId: Number(created.id),
        detail: { requestedDate: input.requestedDate, newShiftId: input.newShiftId },
      })

      const { rows: selectRows } = await client.query<ShiftChangeRequestRow>(
        `${SELECT_SHIFT_CHANGE_REQUEST} WHERE scr.id = $1`,
        [created.id]
      )
      const row = selectRows[0]
      if (!row) throw new Error('re-select of shift_change_requests returned no row')
      return rowToShiftChangeRequest(row)
    })

    const body: ShiftChangeRequestResponse = { request }
    res.status(201).json(body)
  } catch (err) {
    handleUnexpected(res, err)
  }
})

shiftChangeRequestsRouter.get('/shift-change-requests/me', async (req: Request, res: Response) => {
  const employeeId = requireEmployeeId(req, res)
  if (employeeId === null) return

  try {
    const requests = await listShiftChangeRequestsForEmployee(employeeId)
    const body: ShiftChangeRequestMineResponse = { requests }
    res.json(body)
  } catch (err) {
    handleUnexpected(res, err)
  }
})

// Editable only while pending — replaces the whole request rather than
// patching one field, same body shape as creation.
shiftChangeRequestsRouter.put('/shift-change-requests/:id', async (req: Request, res: Response) => {
  const employeeId = requireEmployeeId(req, res)
  if (employeeId === null) return

  const id = parseId(req.params['id'])
  if (id === null) return fail(res, 400, 'id must be a positive integer')

  const parsed = parseShiftChangeRequestInput(req.body)
  if (!parsed.ok) return fail(res, 400, parsed.message)
  const input = parsed.value

  try {
    const outcome = await validateShiftChangeRequestInput(employeeId, input, id)
    if (outcome.kind !== 'ok') return validationFail(res, outcome)

    const currentShiftId = await getShiftIdForDate(employeeId, input.requestedDate)

    const result = await withTransaction(async (client) => {
      const { rows } = await client.query<{ employee_id: string; status: string }>(
        `SELECT employee_id, status FROM shift_change_requests WHERE id = $1 FOR UPDATE`,
        [id]
      )
      const row = rows[0]
      if (!row) return { kind: 'not_found' as const }
      if (Number(row.employee_id) !== employeeId) return { kind: 'not_found' as const }
      if (row.status !== 'pending') return { kind: 'conflict' as const }

      await client.query(
        `UPDATE shift_change_requests
         SET requested_date = $2, current_shift_id = $3, new_shift_id = $4, reason = $5, updated_at = now()
         WHERE id = $1`,
        [id, input.requestedDate, currentShiftId, input.newShiftId, input.reason]
      )

      await recordAudit(client, {
        actor: { kind: 'employee', employeeId },
        action: 'shift_change_request.update',
        entityId: id,
        detail: { requestedDate: input.requestedDate, newShiftId: input.newShiftId },
      })

      const { rows: selectRows } = await client.query<ShiftChangeRequestRow>(
        `${SELECT_SHIFT_CHANGE_REQUEST} WHERE scr.id = $1`,
        [id]
      )
      const updated = selectRows[0]
      if (!updated) throw new Error('re-select of shift_change_requests returned no row')
      return { kind: 'ok' as const, request: rowToShiftChangeRequest(updated) }
    })

    if (result.kind === 'not_found') return fail(res, 404, `no shift change request with id ${id}`)
    if (result.kind === 'conflict') return fail(res, 409, 'คำขอนี้ถูกดำเนินการไปแล้ว ไม่สามารถแก้ไขได้')

    const body: ShiftChangeRequestResponse = { request: result.request }
    res.json(body)
  } catch (err) {
    handleUnexpected(res, err)
  }
})

shiftChangeRequestsRouter.post('/shift-change-requests/:id/cancel', async (req: Request, res: Response) => {
  const employeeId = requireEmployeeId(req, res)
  if (employeeId === null) return

  const id = parseId(req.params['id'])
  if (id === null) return fail(res, 400, 'id must be a positive integer')

  try {
    const result = await withTransaction(async (client) => {
      const { rows } = await client.query<{ employee_id: string; status: string }>(
        `SELECT employee_id, status FROM shift_change_requests WHERE id = $1 FOR UPDATE`,
        [id]
      )
      const row = rows[0]
      if (!row) return { kind: 'not_found' as const }
      if (Number(row.employee_id) !== employeeId) return { kind: 'not_found' as const }
      if (row.status !== 'pending') return { kind: 'conflict' as const }

      await client.query(
        `UPDATE shift_change_requests SET status = 'cancelled', updated_at = now() WHERE id = $1`,
        [id]
      )

      await recordAudit(client, {
        actor: { kind: 'employee', employeeId },
        action: 'shift_change_request.cancel',
        entityId: id,
        detail: {},
      })

      const { rows: selectRows } = await client.query<ShiftChangeRequestRow>(
        `${SELECT_SHIFT_CHANGE_REQUEST} WHERE scr.id = $1`,
        [id]
      )
      const updated = selectRows[0]
      if (!updated) throw new Error('re-select of shift_change_requests returned no row')
      return { kind: 'ok' as const, request: rowToShiftChangeRequest(updated) }
    })

    if (result.kind === 'not_found') return fail(res, 404, `no shift change request with id ${id}`)
    if (result.kind === 'conflict') return fail(res, 409, 'คำขอนี้ถูกดำเนินการไปแล้ว ไม่สามารถยกเลิกได้')

    const body: ShiftChangeRequestResponse = { request: result.request }
    res.json(body)
  } catch (err) {
    handleUnexpected(res, err)
  }
})

shiftChangeRequestsRouter.get('/shift-change-requests', canReadAdmin, async (req: Request, res: Response) => {
  const statusResult = parseStatusFilter(req.query['status'] as string | string[] | undefined)
  if (!statusResult.ok) return fail(res, 400, statusResult.message)

  try {
    const requests = await listShiftChangeRequests({ status: statusResult.value })
    const body: ShiftChangeRequestListResponse = { requests }
    res.json(body)
  } catch (err) {
    handleUnexpected(res, err)
  }
})

shiftChangeRequestsRouter.get('/shift-change-requests/:id', canReadAdmin, async (req: Request, res: Response) => {
  const id = parseId(req.params['id'])
  if (id === null) return fail(res, 400, 'id must be a positive integer')

  try {
    const request = await findShiftChangeRequestById(id)
    if (!request) return fail(res, 404, `no shift change request with id ${id}`)

    const body: ShiftChangeRequestDetailResponse = { request }
    res.json(body)
  } catch (err) {
    handleUnexpected(res, err)
  }
})

shiftChangeRequestsRouter.post(
  '/shift-change-requests/:id/approve',
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
          requested_date: string
          new_shift_id: string
          status: string
        }>(
          `SELECT employee_id, requested_date, new_shift_id, status
           FROM shift_change_requests WHERE id = $1 FOR UPDATE`,
          [id]
        )
        const row = rows[0]
        if (!row) return { kind: 'not_found' as const }
        if (row.status !== 'pending') return { kind: 'conflict' as const, message: 'คำขอนี้ถูกดำเนินการไปแล้ว' }

        // Re-checked here, not just at submission: a request can sit pending
        // long enough for its date to slip into the past.
        const today = toThailandDateString(new Date())
        if (row.requested_date < today) {
          return {
            kind: 'expired' as const,
            message: 'วันที่ขอเปลี่ยนกะผ่านไปแล้ว ไม่สามารถอนุมัติได้ กรุณาปฏิเสธคำขอนี้',
          }
        }

        const employeeId = Number(row.employee_id)

        const outcome = await createShiftChange(client, {
          employeeId,
          shiftId: Number(row.new_shift_id),
          effectiveFrom: row.requested_date,
          effectiveTo: row.requested_date,
          note: `shift change request #${id}`,
          createdByKind: actor.kind,
          createdById: actor.oid,
        })
        if (outcome.kind !== 'ok') return outcome

        await client.query(
          `UPDATE shift_change_requests
           SET status = 'approved', decided_by_oid = $2, decided_by_name = $3,
               decided_at = now(), resulting_assignment_id = $4, updated_at = now()
           WHERE id = $1`,
          [id, actor.oid, actor.name, outcome.assignment.id]
        )

        await recordAudit(client, {
          actor,
          action: 'shift_change_request.approve',
          entityId: id,
          detail: {
            employeeId,
            resultingAssignmentId: outcome.assignment.id,
            requestedDate: row.requested_date,
            newShiftId: Number(row.new_shift_id),
          },
        })

        const request = await findShiftChangeRequestById(id, client)
        if (!request) throw new Error('re-select of shift_change_requests returned no row')
        return { kind: 'ok' as const, request }
      })

      if (result.kind === 'not_found') return fail(res, 404, `no shift change request with id ${id}`)
      if (result.kind === 'conflict' || result.kind === 'expired') return fail(res, 409, result.message)
      if (result.kind === 'no_baseline') {
        return fail(
          res,
          400,
          'พนักงานคนนี้ยังไม่มีกะถาวรที่กำหนดไว้ ไม่สามารถเปลี่ยนกะชั่วคราวได้ กรุณากำหนดกะถาวรก่อน'
        )
      }
      if (result.kind === 'overlap') {
        return fail(
          res,
          409,
          'ช่วงเวลาที่ขอทับกับการเปลี่ยนกะที่ตั้งไว้ล่วงหน้าแล้ว กรุณาตรวจสอบประวัติการเปลี่ยนกะของพนักงานคนนี้'
        )
      }

      const body: ShiftChangeRequestDetailResponse = { request: result.request }
      res.json(body)
    } catch (err) {
      handleUnexpected(res, err)
    }
  }
)

shiftChangeRequestsRouter.post(
  '/shift-change-requests/:id/reject',
  canDecide,
  async (req: Request, res: Response) => {
    const actor = actorOf(req)
    if (!actor || actor.kind !== 'admin') return fail(res, 500, 'server misconfigured')

    const id = parseId(req.params['id'])
    if (id === null) return fail(res, 400, 'id must be a positive integer')

    const body = req.body as Partial<ShiftChangeRequestRejectRequest> | null
    const reason = requiredString((body ?? {}) as Record<string, unknown>, 'reason', 1000)
    if (reason === null) return fail(res, 400, 'reason is required and must be 1000 characters or fewer')

    try {
      const result = await withTransaction(async (client) => {
        const { rows } = await client.query<{ status: string }>(
          `SELECT status FROM shift_change_requests WHERE id = $1 FOR UPDATE`,
          [id]
        )
        const row = rows[0]
        if (!row) return { kind: 'not_found' as const }
        if (row.status !== 'pending') return { kind: 'conflict' as const }

        await client.query(
          `UPDATE shift_change_requests
           SET status = 'rejected', decided_by_oid = $2, decided_by_name = $3,
               decided_at = now(), decision_reason = $4, updated_at = now()
           WHERE id = $1`,
          [id, actor.oid, actor.name, reason]
        )

        await recordAudit(client, {
          actor,
          action: 'shift_change_request.reject',
          entityId: id,
          detail: { reason },
        })

        const request = await findShiftChangeRequestById(id, client)
        if (!request) throw new Error('re-select of shift_change_requests returned no row')
        return { kind: 'ok' as const, request }
      })

      if (result.kind === 'not_found') return fail(res, 404, `no shift change request with id ${id}`)
      if (result.kind === 'conflict') return fail(res, 409, 'คำขอนี้ถูกดำเนินการไปแล้ว')

      const responseBody: ShiftChangeRequestDetailResponse = { request: result.request }
      res.json(responseBody)
    } catch (err) {
      handleUnexpected(res, err)
    }
  }
)

/* Attachment ------------------------------------------------------------
 * Same three-step direct-to-R2 flow as employee photos: presign a PUT,
 * upload straight to R2 from the browser, then tell us it landed. Only the
 * owning employee may attach/replace/remove a photo, and only while the
 * request is still pending — once it's decided, the record is frozen.
 */

async function ownedPendingRequestOr(
  res: Response,
  id: number,
  employeeId: number
): Promise<{ ok: true } | { ok: false }> {
  const { rows } = await pool.query<{ employee_id: string; status: string }>(
    `SELECT employee_id, status FROM shift_change_requests WHERE id = $1`,
    [id]
  )
  const row = rows[0]
  if (!row || Number(row.employee_id) !== employeeId) {
    fail(res, 404, `no shift change request with id ${id}`)
    return { ok: false }
  }
  if (row.status !== 'pending') {
    fail(res, 409, 'คำขอนี้ถูกดำเนินการไปแล้ว ไม่สามารถแก้ไขไฟล์แนบได้')
    return { ok: false }
  }
  return { ok: true }
}

shiftChangeRequestsRouter.post(
  '/shift-change-requests/:id/attachment/presign-upload',
  async (req: Request, res: Response) => {
    const employeeId = requireEmployeeId(req, res)
    if (employeeId === null) return

    const id = parseId(req.params['id'])
    if (id === null) return fail(res, 400, 'id must be a positive integer')

    const raw = req.body as Record<string, unknown>
    const mimeType = typeof raw['mimeType'] === 'string' ? raw['mimeType'] : null
    const sizeBytes = typeof raw['sizeBytes'] === 'number' ? raw['sizeBytes'] : null
    if (mimeType === null || sizeBytes === null) {
      return fail(res, 400, 'mimeType (string) and sizeBytes (number) are required')
    }

    try {
      const owned = await ownedPendingRequestOr(res, id, employeeId)
      if (!owned.ok) return

      const presigned = await presignAttachmentUpload(id, mimeType, sizeBytes)
      if (!presigned.ok) return fail(res, 400, presigned.message)

      const body: ShiftChangeAttachmentPresignResponse = {
        uploadUrl: presigned.uploadUrl,
        key: presigned.key,
      }
      res.json(body)
    } catch (err) {
      handleUnexpected(res, err)
    }
  }
)

shiftChangeRequestsRouter.post(
  '/shift-change-requests/:id/attachment/complete',
  async (req: Request, res: Response) => {
    const employeeId = requireEmployeeId(req, res)
    if (employeeId === null) return

    const id = parseId(req.params['id'])
    if (id === null) return fail(res, 400, 'id must be a positive integer')

    const raw = req.body as Record<string, unknown>
    const key = typeof raw['key'] === 'string' ? raw['key'] : null
    if (key === null || !key.startsWith(`shift-change-requests/${id}/`)) {
      return fail(res, 400, `key must be a string under shift-change-requests/${id}/`)
    }

    try {
      const exists = await headAttachment(key)
      if (!exists) {
        return fail(res, 400, 'no object found at that key — the upload may not have finished')
      }

      const result = await withTransaction(async (client) => {
        const { rows } = await client.query<{ employee_id: string; status: string; attachment_key: string | null }>(
          `SELECT employee_id, status, attachment_key FROM shift_change_requests WHERE id = $1 FOR UPDATE`,
          [id]
        )
        const row = rows[0]
        if (!row || Number(row.employee_id) !== employeeId) return { kind: 'not_found' as const }
        if (row.status !== 'pending') return { kind: 'conflict' as const }

        await client.query(`UPDATE shift_change_requests SET attachment_key = $2, updated_at = now() WHERE id = $1`, [
          id,
          key,
        ])

        await recordAudit(client, {
          actor: { kind: 'employee', employeeId },
          action: 'shift_change_request.update',
          entityId: id,
          detail: { attachmentKey: key },
        })

        return { kind: 'ok' as const, previousKey: row.attachment_key }
      })

      if (result.kind === 'not_found') return fail(res, 404, `no shift change request with id ${id}`)
      if (result.kind === 'conflict') return fail(res, 409, 'คำขอนี้ถูกดำเนินการไปแล้ว ไม่สามารถแก้ไขไฟล์แนบได้')

      if (result.previousKey !== null && result.previousKey !== key) {
        await deleteAttachmentObject(result.previousKey)
      }

      const request = await findShiftChangeRequestById(id)
      if (!request) throw new Error('shift change request vanished after attachment update')

      const body: ShiftChangeRequestDetailResponse = { request }
      res.json(body)
    } catch (err) {
      handleUnexpected(res, err)
    }
  }
)

// Readable by the owning employee or any HRM role — the same detail an
// admin sees in the review queue, the employee sees on their own history.
shiftChangeRequestsRouter.get(
  '/shift-change-requests/:id/attachment',
  async (req: Request, res: Response) => {
    const auth = req.auth
    if (!auth) return fail(res, 500, 'server misconfigured')

    const id = parseId(req.params['id'])
    if (id === null) return fail(res, 400, 'id must be a positive integer')

    try {
      const { rows } = await pool.query<{ employee_id: string; attachment_key: string | null }>(
        `SELECT employee_id, attachment_key FROM shift_change_requests WHERE id = $1`,
        [id]
      )
      const row = rows[0]
      if (!row) return fail(res, 404, `no shift change request with id ${id}`)

      if (auth.kind === 'employee' && auth.employeeId !== Number(row.employee_id)) {
        return fail(res, 404, `no shift change request with id ${id}`)
      }
      if (auth.kind === 'admin' && auth.roles.length === 0) {
        return fail(res, 403, 'this account has no HRM role assigned — contact IT', 'FORBIDDEN')
      }

      const url = row.attachment_key === null ? null : await presignAttachmentView(row.attachment_key)
      const body: ShiftChangeAttachmentResponse = { url }
      res.json(body)
    } catch (err) {
      handleUnexpected(res, err)
    }
  }
)

shiftChangeRequestsRouter.delete(
  '/shift-change-requests/:id/attachment',
  async (req: Request, res: Response) => {
    const employeeId = requireEmployeeId(req, res)
    if (employeeId === null) return

    const id = parseId(req.params['id'])
    if (id === null) return fail(res, 400, 'id must be a positive integer')

    try {
      const result = await withTransaction(async (client) => {
        const { rows } = await client.query<{ employee_id: string; status: string; attachment_key: string | null }>(
          `SELECT employee_id, status, attachment_key FROM shift_change_requests WHERE id = $1 FOR UPDATE`,
          [id]
        )
        const row = rows[0]
        if (!row || Number(row.employee_id) !== employeeId) return { kind: 'not_found' as const }
        if (row.status !== 'pending') return { kind: 'conflict' as const }
        if (row.attachment_key === null) return { kind: 'no_attachment' as const }

        await client.query(`UPDATE shift_change_requests SET attachment_key = NULL, updated_at = now() WHERE id = $1`, [
          id,
        ])

        await recordAudit(client, {
          actor: { kind: 'employee', employeeId },
          action: 'shift_change_request.update',
          entityId: id,
          detail: { attachmentKey: null },
        })

        return { kind: 'ok' as const, deletedKey: row.attachment_key }
      })

      if (result.kind === 'not_found') return fail(res, 404, `no shift change request with id ${id}`)
      if (result.kind === 'conflict') return fail(res, 409, 'คำขอนี้ถูกดำเนินการไปแล้ว ไม่สามารถแก้ไขไฟล์แนบได้')
      if (result.kind === 'no_attachment') return res.status(204).end()

      await deleteAttachmentObject(result.deletedKey)
      res.status(204).end()
    } catch (err) {
      handleUnexpected(res, err)
    }
  }
)
