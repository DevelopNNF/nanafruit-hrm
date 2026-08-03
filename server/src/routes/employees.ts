import { Router } from 'express'
import type { Request, Response } from 'express'
import {
  EMPLOYEE_STATUSES,
  EMPLOYMENT_TYPES,
  GENDERS,
  ROLES,
  TITLES,
  type EmployeeInput,
  type EmployeeListResponse,
  type AuthUser,
  type EmployeeBasicInput,
  type EmploymentInput,
  type EmployeePhotoPresignResponse,
  type EmployeePhotoResponse,
  type EmployeeResponse,
  type LinkCodeResponse,
  type ShiftChangeInput,
  type ShiftChangeResponse,
  type ShiftHistoryResponse,
} from '@hrm/shared'
import { LINK_CODE_TTL_MS, generateLinkCode, hashLinkCode } from '../auth/linkCode.js'
import { pool, withTransaction } from '../db.js'
import { requireRole } from '../auth/middleware.js'
import { recordAudit } from '../audit.js'
import { fail, handleUnexpected } from '../http.js'
import {
  SELECT_EMPLOYEE,
  findEmployeeById,
  rowToEmployee,
  type EmployeeRow,
} from '../employeeQueries.js'
import {
  createShiftChange,
  listShiftAssignments,
  toThailandDateString,
} from '../shiftAssignmentQueries.js'
import {
  deletePhotoObject,
  headPhoto,
  presignPhotoUpload,
  presignPhotoView,
} from '../storage/employeePhotos.js'

export const employeesRouter = Router()

// Reading the staff list is what every HRM role is for, so any of them will do.
// Changing it is not: Viewer stops here. Both sit in front of the handlers
// rather than inside them so that a new route cannot forget to ask.
const canRead = requireRole(...ROLES)
const canWrite = requireRole('HRM.HR', 'HRM.Admin')

/**
 * The caller, for the audit log. canWrite has already established that they are
 * an admin — this narrows the type and turns a wiring mistake into a 500 rather
 * than an audit entry attributed to nobody.
 */
function actorOf(req: Request): AuthUser | null {
  return req.auth ?? null
}

type ParseResult<T> = { ok: true; value: T } | { ok: false; message: string }

function requiredString(
  source: Record<string, unknown>,
  key: string
): string | null {
  const value = source[key]
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

function requiredPositiveInt(source: Record<string, unknown>, key: string): number | null {
  const value = source[key]
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null
}

/** Absent and null both mean "no shift assigned". */
function optionalPositiveInt(source: Record<string, unknown>, key: string): number | null | undefined {
  const value = source[key]
  if (value === null || value === undefined) return null
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined
}

/** Shared by parseEmployeeInput (POST) and PATCH /employees/:id/basic. */
function parseEmployeeBasicFields(raw: Record<string, unknown>): ParseResult<EmployeeBasicInput> {
  const fields = {
    employeeCode: requiredString(raw, 'employeeCode'),
    firstNameTh: requiredString(raw, 'firstNameTh'),
    lastNameTh: requiredString(raw, 'lastNameTh'),
    firstNameEn: requiredString(raw, 'firstNameEn'),
    lastNameEn: requiredString(raw, 'lastNameEn'),
  }
  for (const [key, value] of Object.entries(fields)) {
    if (value === null) return { ok: false, message: `${key} is required` }
  }

  const title = requiredString(raw, 'title')
  if (title === null || !(TITLES as readonly string[]).includes(title)) {
    return { ok: false, message: `title must be one of: ${TITLES.join(', ')}` }
  }

  // nickname is the only optional field: absent, null and '' all mean "none".
  const nicknameRaw = raw['nickname']
  const nickname =
    typeof nicknameRaw === 'string' && nicknameRaw.trim() !== ''
      ? nicknameRaw.trim()
      : null

  // gender is optional too, and for the same reason nickname is: HR may not
  // have this on file yet for an employee hired before the field existed.
  // Absent and null both mean "not recorded".
  const genderRaw = raw['gender']
  const genderProvided = genderRaw !== null && genderRaw !== undefined
  if (genderProvided && !(GENDERS as readonly string[]).includes(genderRaw as string)) {
    return { ok: false, message: `gender must be null or one of: ${GENDERS.join(', ')}` }
  }
  const gender = (genderProvided ? genderRaw : null) as EmployeeBasicInput['gender']

  return {
    ok: true,
    value: {
      employeeCode: fields.employeeCode as string,
      title: title as EmployeeBasicInput['title'],
      firstNameTh: fields.firstNameTh as string,
      lastNameTh: fields.lastNameTh as string,
      firstNameEn: fields.firstNameEn as string,
      lastNameEn: fields.lastNameEn as string,
      nickname,
      gender,
    },
  }
}

/** Shared by parseEmployeeInput (POST) and PATCH /employees/:id/employment. */
function parseEmploymentFields(emp: Record<string, unknown>): ParseResult<EmploymentInput> {
  const jobId = requiredPositiveInt(emp, 'jobId')
  if (jobId === null) {
    return { ok: false, message: 'employment.jobId is required and must be a positive integer' }
  }

  const holidayGroupId = optionalPositiveInt(emp, 'holidayGroupId')
  if (holidayGroupId === undefined) {
    return {
      ok: false,
      message: 'employment.holidayGroupId must be a positive integer or null',
    }
  }

  const status = requiredString(emp, 'status')
  if (status === null || !(EMPLOYEE_STATUSES as readonly string[]).includes(status)) {
    return {
      ok: false,
      message: `employment.status must be one of: ${EMPLOYEE_STATUSES.join(', ')}`,
    }
  }

  const employmentType = requiredString(emp, 'employmentType')
  if (
    employmentType === null ||
    !(EMPLOYMENT_TYPES as readonly string[]).includes(employmentType)
  ) {
    return {
      ok: false,
      message: `employment.employmentType must be one of: ${EMPLOYMENT_TYPES.join(', ')}`,
    }
  }

  const hireDate = requiredString(emp, 'hireDate')
  if (hireDate === null || !isCalendarDate(hireDate)) {
    return { ok: false, message: 'employment.hireDate must be a date as YYYY-MM-DD' }
  }

  return {
    ok: true,
    value: {
      status: status as EmploymentInput['status'],
      hireDate,
      employmentType: employmentType as EmploymentInput['employmentType'],
      jobId,
      holidayGroupId,
    },
  }
}

/** Hand-rolled rather than pulling in a schema library for one route. */
function parseEmployeeInput(body: unknown): ParseResult<EmployeeInput> {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, message: 'body must be a JSON object' }
  }
  const raw = body as Record<string, unknown>
  const employmentRaw = raw['employment']
  if (typeof employmentRaw !== 'object' || employmentRaw === null) {
    return { ok: false, message: 'employment is required and must be an object' }
  }
  const emp = employmentRaw as Record<string, unknown>

  const basic = parseEmployeeBasicFields(raw)
  if (!basic.ok) return basic

  const employment = parseEmploymentFields(emp)
  if (!employment.ok) return employment

  // shiftId is only settable here — the employee's first assignment at
  // creation. PATCH /employees/:id/employment has no shiftId at all; shift
  // changes after creation go through POST /employees/:id/shift-changes.
  const shiftId = optionalPositiveInt(emp, 'shiftId')
  if (shiftId === undefined) {
    return { ok: false, message: 'employment.shiftId must be a positive integer or null' }
  }

  return {
    ok: true,
    value: {
      ...basic.value,
      employment: {
        ...employment.value,
        shiftId,
      },
    },
  }
}

/** Rejects both bad formats and real-looking-but-impossible dates like 2024-02-31. */
function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [year, month, day] = value.split('-').map(Number) as [number, number, number]
  const date = new Date(Date.UTC(year, month - 1, day))
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  )
}

// Express types params as string | string[] | undefined (repeated params yield an
// array). Only a single numeric segment is a valid id.
function parseId(value: string | string[] | undefined): number | null {
  if (typeof value !== 'string') return null
  const id = Number(value)
  return Number.isInteger(id) && id > 0 ? id : null
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' && err !== null && (err as { code?: unknown }).code === '23505'
  )
}

function isForeignKeyViolation(err: unknown): boolean {
  return (
    typeof err === 'object' && err !== null && (err as { code?: unknown }).code === '23503'
  )
}

/**
 * job_id, shift_id and holiday_group_id are all FKs on employment_details, so
 * a 23503 needs the constraint name to say which one actually failed rather
 * than guessing. Postgres auto-names a column-level REFERENCES as
 * `<table>_<column>_fkey`.
 */
function fkViolationField(err: unknown): 'job' | 'shift' | 'holidayGroup' | null {
  const constraint =
    typeof err === 'object' && err !== null ? (err as { constraint?: unknown }).constraint : null
  if (constraint === 'employment_details_job_id_fkey') return 'job'
  if (constraint === 'employment_details_shift_id_fkey') return 'shift'
  if (constraint === 'employment_details_holiday_group_id_fkey') return 'holidayGroup'
  if (constraint === 'employee_shift_assignments_shift_id_fkey') return 'shift'
  return null
}

/** Hand-rolled, same style as parseEmployeeInput. */
function parseShiftChangeInput(body: unknown): ParseResult<ShiftChangeInput> {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, message: 'body must be a JSON object' }
  }
  const raw = body as Record<string, unknown>

  const shiftId = optionalPositiveInt(raw, 'shiftId')
  if (shiftId === undefined) {
    return { ok: false, message: 'shiftId must be a positive integer or null' }
  }

  const effectiveFrom = requiredString(raw, 'effectiveFrom')
  if (effectiveFrom === null || !isCalendarDate(effectiveFrom)) {
    return { ok: false, message: 'effectiveFrom must be a date as YYYY-MM-DD' }
  }

  const effectiveToRaw = raw['effectiveTo']
  let effectiveTo: string | null = null
  if (effectiveToRaw !== undefined && effectiveToRaw !== null) {
    if (typeof effectiveToRaw !== 'string' || !isCalendarDate(effectiveToRaw)) {
      return { ok: false, message: 'effectiveTo must be a date as YYYY-MM-DD, or null' }
    }
    effectiveTo = effectiveToRaw
  }
  if (effectiveTo !== null && effectiveTo < effectiveFrom) {
    return { ok: false, message: 'effectiveTo must be on or after effectiveFrom' }
  }

  const noteRaw = raw['note']
  const note = typeof noteRaw === 'string' && noteRaw.trim() !== '' ? noteRaw.trim() : null

  return { ok: true, value: { shiftId, effectiveFrom, effectiveTo, note } }
}

employeesRouter.get('/employees', canRead, async (_req: Request, res: Response) => {
  try {
    const { rows } = await pool.query<EmployeeRow>(
      `${SELECT_EMPLOYEE} ORDER BY e.employee_code`
    )
    const body: EmployeeListResponse = { employees: rows.map(rowToEmployee) }
    res.json(body)
  } catch (err) {
    handleUnexpected(res, err)
  }
})

employeesRouter.get('/employees/:id', canRead, async (req: Request, res: Response) => {
  const id = parseId(req.params['id'])
  if (id === null) return fail(res, 400, 'id must be a positive integer')

  try {
    const employee = await findEmployeeById(id)
    if (!employee) return fail(res, 404, `no employee with id ${id}`)

    const body: EmployeeResponse = { employee }
    res.json(body)
  } catch (err) {
    handleUnexpected(res, err)
  }
})

employeesRouter.post('/employees', canWrite, async (req: Request, res: Response) => {
  const actor = actorOf(req)
  if (!actor) return fail(res, 500, 'server misconfigured')

  const parsed = parseEmployeeInput(req.body)
  if (!parsed.ok) return fail(res, 400, parsed.message)
  const input = parsed.value

  try {
    const employee = await withTransaction(async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO employees
           (employee_code, title, first_name_th, last_name_th,
            first_name_en, last_name_en, nickname, gender)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id`,
        [
          input.employeeCode,
          input.title,
          input.firstNameTh,
          input.lastNameTh,
          input.firstNameEn,
          input.lastNameEn,
          input.nickname,
          input.gender,
        ]
      )
      const created = rows[0]
      if (!created) throw new Error('insert into employees returned no id')

      await client.query(
        `INSERT INTO employment_details
           (employee_id, status, hire_date, employment_type, job_id, shift_id, holiday_group_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          created.id,
          input.employment.status,
          input.employment.hireDate,
          input.employment.employmentType,
          input.employment.jobId,
          input.employment.shiftId,
          input.employment.holidayGroupId,
        ]
      )

      // The employee's first shift assignment, if given one at creation —
      // employment_details.shift_id above is written too (existing columns
      // aren't dropped yet) but nothing reads it as "current" any more; this
      // row is what getShiftIdForDate/currentShiftJoinSql actually resolve.
      if (input.employment.shiftId !== null) {
        await client.query(
          `INSERT INTO employee_shift_assignments
             (employee_id, shift_id, effective_from, created_by_kind, created_by_id)
           VALUES ($1, $2, $3, $4, $5)`,
          [
            created.id,
            input.employment.shiftId,
            input.employment.hireDate,
            actor.kind,
            actor.kind === 'admin' ? actor.oid : String(actor.employeeId),
          ]
        )
      }

      await recordAudit(client, {
        actor,
        action: 'employee.create',
        entityId: Number(created.id),
        detail: { employeeCode: input.employeeCode },
      })

      // Re-read through the join rather than assembling the response from
      // input: input no longer carries jobTitle, only the jobId it was traded
      // in for, and this is the one place that resolves it.
      const employee = await findEmployeeById(Number(created.id), client)
      if (!employee) throw new Error('employee vanished between insert and read-back')
      return employee
    })

    const body: EmployeeResponse = { employee }
    res.status(201).json(body)
  } catch (err) {
    if (isUniqueViolation(err)) {
      return fail(res, 409, `employee code ${input.employeeCode} is already taken`)
    }
    const fkField = fkViolationField(err)
    if (fkField === 'job') return fail(res, 400, `no job with id ${input.employment.jobId}`)
    if (fkField === 'shift') return fail(res, 400, `no shift with id ${input.employment.shiftId}`)
    if (fkField === 'holidayGroup') {
      return fail(res, 400, `no holiday group with id ${input.employment.holidayGroupId}`)
    }
    if (isForeignKeyViolation(err)) return fail(res, 400, 'invalid reference in employment')
    handleUnexpected(res, err)
  }
})

// Two independent PATCHes rather than one full-replace PUT: the admin edit
// screen has separate forms (and separate Save buttons) for basic info and
// employment info, and neither should need to know the other's current
// draft to save.
employeesRouter.patch('/employees/:id/basic', canWrite, async (req: Request, res: Response) => {
  const actor = actorOf(req)
  if (!actor) return fail(res, 500, 'server misconfigured')

  const id = parseId(req.params['id'])
  if (id === null) return fail(res, 400, 'id must be a positive integer')

  if (typeof req.body !== 'object' || req.body === null) {
    return fail(res, 400, 'body must be a JSON object')
  }
  const parsed = parseEmployeeBasicFields(req.body as Record<string, unknown>)
  if (!parsed.ok) return fail(res, 400, parsed.message)
  const input: EmployeeBasicInput = parsed.value

  try {
    const result = await withTransaction(async (client) => {
      const { rowCount } = await client.query(
        `UPDATE employees SET
           employee_code = $2, title = $3,
           first_name_th = $4, last_name_th = $5,
           first_name_en = $6, last_name_en = $7,
           nickname = $8, gender = $9, updated_at = now()
         WHERE id = $1`,
        [
          id,
          input.employeeCode,
          input.title,
          input.firstNameTh,
          input.lastNameTh,
          input.firstNameEn,
          input.lastNameEn,
          input.nickname,
          input.gender,
        ]
      )
      if (rowCount === 0) return 'not-found' as const

      await recordAudit(client, {
        actor,
        action: 'employee.basic_update',
        entityId: id,
        detail: { employeeCode: input.employeeCode },
      })

      // Re-read through the join for the same reason POST does: the response
      // needs jobTitle/shiftName/holidayGroupName, which input never carries.
      const employee = await findEmployeeById(id, client)
      if (!employee) throw new Error('employee vanished during update')
      return employee
    })

    if (result === 'not-found') return fail(res, 404, `no employee with id ${id}`)

    const body: EmployeeResponse = { employee: result }
    res.json(body)
  } catch (err) {
    if (isUniqueViolation(err)) {
      return fail(res, 409, `employee code ${input.employeeCode} is already taken`)
    }
    handleUnexpected(res, err)
  }
})

employeesRouter.patch(
  '/employees/:id/employment',
  canWrite,
  async (req: Request, res: Response) => {
    const actor = actorOf(req)
    if (!actor) return fail(res, 500, 'server misconfigured')

    const id = parseId(req.params['id'])
    if (id === null) return fail(res, 400, 'id must be a positive integer')

    if (typeof req.body !== 'object' || req.body === null) {
      return fail(res, 400, 'body must be a JSON object')
    }
    const parsed = parseEmploymentFields(req.body as Record<string, unknown>)
    if (!parsed.ok) return fail(res, 400, parsed.message)
    const input: EmploymentInput = parsed.value

    try {
      const result = await withTransaction(async (client) => {
        // shift_id is deliberately absent here — shift changes need an
        // effective date and go through POST /employees/:id/shift-changes
        // instead, which is the only writer of employee_shift_assignments
        // (and, since 023, the only thing any read path trusts for "current
        // shift").
        const { rowCount } = await client.query(
          `UPDATE employment_details SET
             status = $2, hire_date = $3, employment_type = $4,
             job_id = $5, holiday_group_id = $6, updated_at = now()
           WHERE employee_id = $1`,
          [
            id,
            input.status,
            input.hireDate,
            input.employmentType,
            input.jobId,
            input.holidayGroupId,
          ]
        )
        if (rowCount === 0) return 'not-found' as const

        await recordAudit(client, {
          actor,
          action: 'employee.employment_update',
          entityId: id,
          detail: { jobId: input.jobId },
        })

        const employee = await findEmployeeById(id, client)
        if (!employee) throw new Error('employee vanished during update')
        return employee
      })

      if (result === 'not-found') return fail(res, 404, `no employee with id ${id}`)

      const body: EmployeeResponse = { employee: result }
      res.json(body)
    } catch (err) {
      const fkField = fkViolationField(err)
      if (fkField === 'job') return fail(res, 400, `no job with id ${input.jobId}`)
      if (fkField === 'holidayGroup') {
        return fail(res, 400, `no holiday group with id ${input.holidayGroupId}`)
      }
      if (isForeignKeyViolation(err)) return fail(res, 400, 'invalid reference in employment')
      handleUnexpected(res, err)
    }
  }
)

employeesRouter.post(
  '/employees/:id/shift-changes',
  canWrite,
  async (req: Request, res: Response) => {
    const actor = actorOf(req)
    if (!actor || actor.kind !== 'admin') return fail(res, 500, 'server misconfigured')

    const id = parseId(req.params['id'])
    if (id === null) return fail(res, 400, 'id must be a positive integer')

    const parsed = parseShiftChangeInput(req.body)
    if (!parsed.ok) return fail(res, 400, parsed.message)
    const input = parsed.value

    // No backdating: attendance already snapshots the shift that applied at
    // clock-in time (see attendance_events' shift_id), so there is nothing
    // for a backdated shift change to correct, only history to rewrite.
    const today = toThailandDateString(new Date())
    if (input.effectiveFrom < today) {
      return fail(
        res,
        400,
        'effectiveFrom ต้องเป็นวันนี้หรือวันในอนาคตเท่านั้น ไม่สามารถเปลี่ยนกะย้อนหลังได้'
      )
    }

    try {
      const result = await withTransaction(async (client) => {
        const employee = await findEmployeeById(id, client)
        if (!employee) return { kind: 'not-found' as const }
        if (input.effectiveFrom < employee.employment.hireDate) {
          return { kind: 'before-hire' as const }
        }

        const outcome = await createShiftChange(client, {
          employeeId: id,
          shiftId: input.shiftId,
          effectiveFrom: input.effectiveFrom,
          effectiveTo: input.effectiveTo ?? null,
          note: input.note ?? null,
          createdByKind: actor.kind,
          createdById: actor.oid,
        })
        if (outcome.kind !== 'ok') return outcome

        await recordAudit(client, {
          actor,
          action: 'employee.shift_change',
          entityId: id,
          detail: {
            employeeCode: employee.employeeCode,
            shiftId: outcome.assignment.shiftId,
            previousShiftId: outcome.previousShiftId,
            effectiveFrom: outcome.assignment.effectiveFrom,
            effectiveTo: outcome.assignment.effectiveTo,
            note: outcome.assignment.note,
          },
        })
        return outcome
      })

      if (result.kind === 'not-found') return fail(res, 404, `no employee with id ${id}`)
      if (result.kind === 'before-hire') {
        return fail(res, 400, 'effectiveFrom ต้องไม่ก่อนวันที่เริ่มงานของพนักงาน')
      }
      if (result.kind === 'no_baseline') {
        return fail(
          res,
          400,
          'พนักงานคนนี้ยังไม่มีกะถาวรที่กำหนดไว้ ไม่สามารถสลับกะชั่วคราวได้ กรุณากำหนดกะถาวรก่อน'
        )
      }
      if (result.kind === 'overlap') {
        return fail(
          res,
          409,
          'ช่วงเวลาที่ระบุทับกับการเปลี่ยนกะที่ตั้งไว้ล่วงหน้าแล้ว กรุณาตรวจสอบประวัติการเปลี่ยนกะ'
        )
      }

      const body: ShiftChangeResponse = { assignment: result.assignment }
      res.status(201).json(body)
    } catch (err) {
      const fkField = fkViolationField(err)
      if (fkField === 'shift') return fail(res, 400, `no shift with id ${input.shiftId}`)
      if (isForeignKeyViolation(err)) return fail(res, 400, 'invalid reference in shift change')
      handleUnexpected(res, err)
    }
  }
)

employeesRouter.get(
  '/employees/:id/shift-history',
  canRead,
  async (req: Request, res: Response) => {
    const id = parseId(req.params['id'])
    if (id === null) return fail(res, 400, 'id must be a positive integer')

    try {
      const employee = await findEmployeeById(id)
      if (!employee) return fail(res, 404, `no employee with id ${id}`)

      const assignments = await listShiftAssignments(id)
      const body: ShiftHistoryResponse = { assignments }
      res.json(body)
    } catch (err) {
      handleUnexpected(res, err)
    }
  }
)

// Step 1 of the upload: hand out a presigned PUT URL. Nothing is written to
// the database here — the employee row only changes once /complete confirms
// the browser's direct-to-R2 upload actually landed, so an abandoned upload
// (tab closed mid-PUT) leaves no bookkeeping behind, just an unreferenced
// object in R2.
employeesRouter.post(
  '/employees/:id/photo/presign-upload',
  canWrite,
  async (req: Request, res: Response) => {
    const id = parseId(req.params['id'])
    if (id === null) return fail(res, 400, 'id must be a positive integer')

    const raw = req.body as Record<string, unknown>
    const mimeType = typeof raw['mimeType'] === 'string' ? raw['mimeType'] : null
    const sizeBytes = typeof raw['sizeBytes'] === 'number' ? raw['sizeBytes'] : null
    if (mimeType === null || sizeBytes === null) {
      return fail(res, 400, 'mimeType (string) and sizeBytes (number) are required')
    }

    try {
      const employee = await findEmployeeById(id)
      if (!employee) return fail(res, 404, `no employee with id ${id}`)

      const presigned = await presignPhotoUpload(id, mimeType, sizeBytes)
      if (!presigned.ok) return fail(res, 400, presigned.message)

      const body: EmployeePhotoPresignResponse = {
        uploadUrl: presigned.uploadUrl,
        key: presigned.key,
      }
      res.json(body)
    } catch (err) {
      handleUnexpected(res, err)
    }
  }
)

// Step 2: the browser tells us its PUT to R2 finished. headPhoto confirms the
// object is actually there before we trust the key — the browser is telling
// the truth as far as it knows, but its PUT could still have failed
// mid-flight without the JS ever seeing an error.
employeesRouter.post(
  '/employees/:id/photo/complete',
  canWrite,
  async (req: Request, res: Response) => {
    const actor = actorOf(req)
    if (!actor) return fail(res, 500, 'server misconfigured')

    const id = parseId(req.params['id'])
    if (id === null) return fail(res, 400, 'id must be a positive integer')

    const raw = req.body as Record<string, unknown>
    const key = typeof raw['key'] === 'string' ? raw['key'] : null
    if (key === null || !key.startsWith(`employees/${id}/photo/`)) {
      return fail(res, 400, `key must be a string under employees/${id}/photo/`)
    }

    try {
      const exists = await headPhoto(key)
      if (!exists) {
        return fail(res, 400, 'no object found at that key — the upload may not have finished')
      }

      const result = await withTransaction(async (client) => {
        const { rows } = await client.query<{ photo_key: string | null }>(
          'SELECT photo_key FROM employees WHERE id = $1 FOR UPDATE',
          [id]
        )
        const row = rows[0]
        if (!row) return 'not-found' as const

        await client.query('UPDATE employees SET photo_key = $2 WHERE id = $1', [id, key])

        await recordAudit(client, {
          actor,
          action: 'employee.photo_update',
          entityId: id,
          detail: { key },
        })

        return { previousKey: row.photo_key }
      })

      if (result === 'not-found') return fail(res, 404, `no employee with id ${id}`)

      // Old object is only worth removing once the new one is committed —
      // best-effort, and never lets R2 cleanup fail a request that otherwise
      // succeeded.
      if (result.previousKey !== null && result.previousKey !== key) {
        await deletePhotoObject(result.previousKey)
      }

      const employee = await findEmployeeById(id)
      if (!employee) throw new Error('employee vanished after photo update')

      const body: EmployeeResponse = { employee }
      res.json(body)
    } catch (err) {
      handleUnexpected(res, err)
    }
  }
)

// Regenerated on every call rather than cached anywhere: the URL is only
// good for a few minutes, so there is nothing worth storing.
employeesRouter.get(
  '/employees/:id/photo',
  canRead,
  async (req: Request, res: Response) => {
    const id = parseId(req.params['id'])
    if (id === null) return fail(res, 400, 'id must be a positive integer')

    try {
      const { rows } = await pool.query<{ photo_key: string | null }>(
        'SELECT photo_key FROM employees WHERE id = $1',
        [id]
      )
      const row = rows[0]
      if (!row) return fail(res, 404, `no employee with id ${id}`)

      const url = row.photo_key === null ? null : await presignPhotoView(row.photo_key)
      const body: EmployeePhotoResponse = { url }
      res.json(body)
    } catch (err) {
      handleUnexpected(res, err)
    }
  }
)

employeesRouter.delete(
  '/employees/:id/photo',
  canWrite,
  async (req: Request, res: Response) => {
    const actor = actorOf(req)
    if (!actor) return fail(res, 500, 'server misconfigured')

    const id = parseId(req.params['id'])
    if (id === null) return fail(res, 400, 'id must be a positive integer')

    try {
      const result = await withTransaction(async (client) => {
        const { rows } = await client.query<{ photo_key: string | null }>(
          'SELECT photo_key FROM employees WHERE id = $1 FOR UPDATE',
          [id]
        )
        const row = rows[0]
        if (!row) return 'not-found' as const
        if (row.photo_key === null) return 'no-photo' as const

        await client.query('UPDATE employees SET photo_key = NULL WHERE id = $1', [id])

        await recordAudit(client, {
          actor,
          action: 'employee.photo_delete',
          entityId: id,
          detail: { key: row.photo_key },
        })

        return { deletedKey: row.photo_key }
      })

      if (result === 'not-found') return fail(res, 404, `no employee with id ${id}`)
      if (result === 'no-photo') return res.status(204).end()

      await deletePhotoObject(result.deletedKey)
      res.status(204).end()
    } catch (err) {
      handleUnexpected(res, err)
    }
  }
)

// Issues a one-time code the employee types into liff/ to claim their record.
// A write, and an identity-granting one, so canWrite rather than canRead.
employeesRouter.post(
  '/employees/:id/link-code',
  canWrite,
  async (req: Request, res: Response) => {
    const id = parseId(req.params['id'])
    if (id === null) return fail(res, 400, 'id must be a positive integer')

    const actor = actorOf(req)
    if (actor?.kind !== 'admin') return fail(res, 500, 'server misconfigured')

    const code = generateLinkCode()
    const expiresAt = new Date(Date.now() + LINK_CODE_TTL_MS)

    try {
      const result = await withTransaction(async (client) => {
        // FOR UPDATE: two HR users issuing at once would otherwise both read
        // "not linked" and both hand out a code for the same person.
        const { rows } = await client.query<{ line_user_id: string | null }>(
          'SELECT line_user_id FROM employees WHERE id = $1 FOR UPDATE',
          [id]
        )
        const employee = rows[0]
        if (!employee) return 'not-found' as const
        // Handing out a code for an employee who already has a LINE account
        // would only ever be the first half of taking their record away from
        // them. Unlinking is a deliberate act and does not have a route yet.
        if (employee.line_user_id !== null) return 'already-linked' as const

        await client.query(
          `INSERT INTO employee_link_codes (code_hash, employee_id, expires_at, created_by)
           VALUES ($1, $2, $3, $4)`,
          [hashLinkCode(code), id, expiresAt, actor.upn]
        )

        // No code in the detail — the audit log would then be holding a live
        // credential in plaintext, which is the thing the hash above avoids.
        await recordAudit(client, {
          actor,
          action: 'employee.link_code_issued',
          entityId: id,
          detail: { expiresAt: expiresAt.toISOString() },
        })
        return 'issued' as const
      })

      if (result === 'not-found') return fail(res, 404, `no employee with id ${id}`)
      if (result === 'already-linked') {
        return fail(res, 409, `employee ${id} is already linked to a LINE account`)
      }

      // The only time the plaintext code exists outside HR's screen. The row
      // holds a hash, so a second GET could not reproduce this if it wanted to.
      const body: LinkCodeResponse = { code, expiresAt: expiresAt.toISOString() }
      res.status(201).json(body)
    } catch (err) {
      handleUnexpected(res, err)
    }
  }
)

employeesRouter.delete('/employees/:id', canWrite, async (req: Request, res: Response) => {
  const actor = actorOf(req)
  if (!actor) return fail(res, 500, 'server misconfigured')

  const id = parseId(req.params['id'])
  if (id === null) return fail(res, 400, 'id must be a positive integer')

  try {
    const deleted = await withTransaction(async (client) => {
      // employment_details and any link codes go with it via ON DELETE CASCADE.
      // RETURNING catches the employee code on its way out: a moment later there
      // is nowhere left to read it from, and it is the only thing that makes the
      // audit entry mean anything to whoever reads it.
      const { rows } = await client.query<{ employee_code: string }>(
        'DELETE FROM employees WHERE id = $1 RETURNING employee_code',
        [id]
      )
      const row = rows[0]
      if (!row) return false

      await recordAudit(client, {
        actor,
        action: 'employee.delete',
        entityId: id,
        detail: { employeeCode: row.employee_code },
      })
      return true
    })

    if (!deleted) return fail(res, 404, `no employee with id ${id}`)
    res.status(204).end()
  } catch (err) {
    handleUnexpected(res, err)
  }
})
