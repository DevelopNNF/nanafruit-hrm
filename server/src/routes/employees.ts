import { Router } from 'express'
import type { Request, Response } from 'express'
import {
  EMPLOYEE_STATUSES,
  EMPLOYMENT_TYPES,
  ROLES,
  TITLES,
  type Employee,
  type EmployeeInput,
  type EmployeeListResponse,
  type AuthUser,
  type EmployeeResponse,
  type LinkCodeResponse,
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

  const jobTitle = requiredString(emp, 'jobTitle')
  if (jobTitle === null) {
    return { ok: false, message: 'employment.jobTitle is required' }
  }

  const title = requiredString(raw, 'title')
  if (title === null || !(TITLES as readonly string[]).includes(title)) {
    return { ok: false, message: `title must be one of: ${TITLES.join(', ')}` }
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

  // nickname is the only optional field: absent, null and '' all mean "none".
  const nicknameRaw = raw['nickname']
  const nickname =
    typeof nicknameRaw === 'string' && nicknameRaw.trim() !== ''
      ? nicknameRaw.trim()
      : null

  return {
    ok: true,
    value: {
      employeeCode: fields.employeeCode as string,
      title: title as EmployeeInput['title'],
      firstNameTh: fields.firstNameTh as string,
      lastNameTh: fields.lastNameTh as string,
      firstNameEn: fields.firstNameEn as string,
      lastNameEn: fields.lastNameEn as string,
      nickname,
      employment: {
        status: status as EmployeeInput['employment']['status'],
        hireDate,
        employmentType: employmentType as EmployeeInput['employment']['employmentType'],
        jobTitle,
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
            first_name_en, last_name_en, nickname)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id`,
        [
          input.employeeCode,
          input.title,
          input.firstNameTh,
          input.lastNameTh,
          input.firstNameEn,
          input.lastNameEn,
          input.nickname,
        ]
      )
      const created = rows[0]
      if (!created) throw new Error('insert into employees returned no id')

      await client.query(
        `INSERT INTO employment_details
           (employee_id, status, hire_date, employment_type, job_title)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          created.id,
          input.employment.status,
          input.employment.hireDate,
          input.employment.employmentType,
          input.employment.jobTitle,
        ]
      )

      await recordAudit(client, {
        actor,
        action: 'employee.create',
        entityId: Number(created.id),
        detail: { employeeCode: input.employeeCode },
      })

      return { ...input, id: Number(created.id) } satisfies Employee
    })

    const body: EmployeeResponse = { employee }
    res.status(201).json(body)
  } catch (err) {
    if (isUniqueViolation(err)) {
      return fail(res, 409, `employee code ${input.employeeCode} is already taken`)
    }
    handleUnexpected(res, err)
  }
})

// PUT, not PATCH: the body is a complete employee, so this replaces rather than
// merges. Partial updates can get their own PATCH if a caller ever needs one.
employeesRouter.put('/employees/:id', canWrite, async (req: Request, res: Response) => {
  const actor = actorOf(req)
  if (!actor) return fail(res, 500, 'server misconfigured')

  const id = parseId(req.params['id'])
  if (id === null) return fail(res, 400, 'id must be a positive integer')

  const parsed = parseEmployeeInput(req.body)
  if (!parsed.ok) return fail(res, 400, parsed.message)
  const input = parsed.value

  try {
    const updated = await withTransaction(async (client) => {
      const { rowCount } = await client.query(
        `UPDATE employees SET
           employee_code = $2, title = $3,
           first_name_th = $4, last_name_th = $5,
           first_name_en = $6, last_name_en = $7,
           nickname = $8, updated_at = now()
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
        ]
      )
      if (rowCount === 0) return false

      await client.query(
        `UPDATE employment_details SET
           status = $2, hire_date = $3, employment_type = $4,
           job_title = $5, updated_at = now()
         WHERE employee_id = $1`,
        [
          id,
          input.employment.status,
          input.employment.hireDate,
          input.employment.employmentType,
          input.employment.jobTitle,
        ]
      )

      await recordAudit(client, {
        actor,
        action: 'employee.update',
        entityId: id,
        detail: { employeeCode: input.employeeCode },
      })
      return true
    })

    if (!updated) return fail(res, 404, `no employee with id ${id}`)

    const body: EmployeeResponse = { employee: { ...input, id } }
    res.json(body)
  } catch (err) {
    if (isUniqueViolation(err)) {
      return fail(res, 409, `employee code ${input.employeeCode} is already taken`)
    }
    handleUnexpected(res, err)
  }
})

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
