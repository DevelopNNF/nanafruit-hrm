import { Router } from 'express'
import type { Request, Response } from 'express'
import {
  EMPLOYEE_STATUSES,
  EMPLOYMENT_TYPES,
  TITLES,
  type ApiError,
  type Employee,
  type EmployeeInput,
  type EmployeeListResponse,
  type EmployeeResponse,
} from '@hrm/shared'
import { pool, withTransaction } from '../db.js'

export const employeesRouter = Router()

// Shape of a row from the employees ⋈ employment_details join. Every employment
// column is nullable here only because the LEFT JOIN says so — see rowToEmployee.
type EmployeeRow = {
  id: string // bigint: pg hands these back as strings to avoid precision loss
  employee_code: string
  title: string
  first_name_th: string
  last_name_th: string
  first_name_en: string
  last_name_en: string
  nickname: string | null
  status: string | null
  hire_date: string | null // 'YYYY-MM-DD' — see the DATE type parser in db.ts
  employment_type: string | null
  job_title: string | null
}

const SELECT_EMPLOYEE = `
  SELECT e.id, e.employee_code, e.title,
         e.first_name_th, e.last_name_th, e.first_name_en, e.last_name_en,
         e.nickname,
         d.status, d.hire_date, d.employment_type, d.job_title
  FROM employees e
  LEFT JOIN employment_details d ON d.employee_id = e.id
`

function rowToEmployee(row: EmployeeRow): Employee {
  // The LEFT JOIN types these as nullable, but every write goes through a
  // transaction that inserts both halves, and the FK cascades on delete. A null
  // here means the data was tampered with outside the API, so fail loudly
  // rather than invent an employment record.
  if (
    row.status === null ||
    row.hire_date === null ||
    row.employment_type === null ||
    row.job_title === null
  ) {
    throw new Error(`employee ${row.id} has no employment_details row`)
  }

  return {
    id: Number(row.id),
    employeeCode: row.employee_code,
    title: row.title as Employee['title'],
    firstNameTh: row.first_name_th,
    lastNameTh: row.last_name_th,
    firstNameEn: row.first_name_en,
    lastNameEn: row.last_name_en,
    nickname: row.nickname,
    employment: {
      status: row.status as Employee['employment']['status'],
      hireDate: row.hire_date,
      employmentType: row.employment_type as Employee['employment']['employmentType'],
      jobTitle: row.job_title,
    },
  }
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

function fail(res: Response, status: number, message: string): void {
  const body: ApiError = { status: 'error', message }
  res.status(status).json(body)
}

/** Every route funnels its unexpected errors here so none of them leak a stack trace. */
function handleUnexpected(res: Response, err: unknown): void {
  console.error(err)
  fail(res, 500, err instanceof Error ? err.message : 'unexpected database error')
}

employeesRouter.get('/employees', async (_req: Request, res: Response) => {
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

employeesRouter.get('/employees/:id', async (req: Request, res: Response) => {
  const id = parseId(req.params['id'])
  if (id === null) return fail(res, 400, 'id must be a positive integer')

  try {
    const { rows } = await pool.query<EmployeeRow>(`${SELECT_EMPLOYEE} WHERE e.id = $1`, [
      id,
    ])
    const row = rows[0]
    if (!row) return fail(res, 404, `no employee with id ${id}`)

    const body: EmployeeResponse = { employee: rowToEmployee(row) }
    res.json(body)
  } catch (err) {
    handleUnexpected(res, err)
  }
})

employeesRouter.post('/employees', async (req: Request, res: Response) => {
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
employeesRouter.put('/employees/:id', async (req: Request, res: Response) => {
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

employeesRouter.delete('/employees/:id', async (req: Request, res: Response) => {
  const id = parseId(req.params['id'])
  if (id === null) return fail(res, 400, 'id must be a positive integer')

  try {
    // employment_details goes with it via ON DELETE CASCADE.
    const { rowCount } = await pool.query('DELETE FROM employees WHERE id = $1', [id])
    if (rowCount === 0) return fail(res, 404, `no employee with id ${id}`)
    res.status(204).end()
  } catch (err) {
    handleUnexpected(res, err)
  }
})
