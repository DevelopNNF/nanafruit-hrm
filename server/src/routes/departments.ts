import { Router } from 'express'
import type { Request, Response } from 'express'
import {
  ROLES,
  type AuthUser,
  type DepartmentInput,
  type DepartmentListResponse,
  type DepartmentResponse,
} from '@hrm/shared'
import { pool, withTransaction } from '../db.js'
import { requireRole } from '../auth/middleware.js'
import { recordAudit } from '../audit.js'
import { fail, handleUnexpected } from '../http.js'
import {
  SELECT_DEPARTMENT,
  findDepartmentById,
  rowToDepartment,
  wouldCreateCycle,
  type DepartmentRow,
} from '../departmentQueries.js'

export const departmentsRouter = Router()

// Same split as jobs: any HRM role can read the department list, only HR and
// Admin can change it.
const canRead = requireRole(...ROLES)
const canWrite = requireRole('HRM.HR', 'HRM.Admin')

function actorOf(req: Request): AuthUser | null {
  return req.auth ?? null
}

type ParseResult<T> = { ok: true; value: T } | { ok: false; message: string }

function requiredString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key]
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

/** Absent and null both mean "no parent department". */
function optionalPositiveInt(source: Record<string, unknown>, key: string): number | null | undefined {
  const value = source[key]
  if (value === null || value === undefined) return null
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined
}

function parseDepartmentInput(body: unknown): ParseResult<DepartmentInput> {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, message: 'body must be a JSON object' }
  }
  const raw = body as Record<string, unknown>

  const deptCode = requiredString(raw, 'deptCode')
  if (deptCode === null) return { ok: false, message: 'deptCode is required' }

  const deptName = requiredString(raw, 'deptName')
  if (deptName === null) return { ok: false, message: 'deptName is required' }

  const parentDepartmentId = optionalPositiveInt(raw, 'parentDepartmentId')
  if (parentDepartmentId === undefined) {
    return { ok: false, message: 'parentDepartmentId must be a positive integer or null' }
  }

  const isActiveRaw = raw['isActive']
  if (typeof isActiveRaw !== 'boolean') {
    return { ok: false, message: 'isActive must be a boolean' }
  }

  return {
    ok: true,
    value: { deptCode, deptName, parentDepartmentId, isActive: isActiveRaw },
  }
}

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

departmentsRouter.get('/departments', canRead, async (_req: Request, res: Response) => {
  try {
    const { rows } = await pool.query<DepartmentRow>(`${SELECT_DEPARTMENT} ORDER BY d.dept_name`)
    const body: DepartmentListResponse = { departments: rows.map(rowToDepartment) }
    res.json(body)
  } catch (err) {
    handleUnexpected(res, err)
  }
})

departmentsRouter.get('/departments/:id', canRead, async (req: Request, res: Response) => {
  const id = parseId(req.params['id'])
  if (id === null) return fail(res, 400, 'id must be a positive integer')

  try {
    const department = await findDepartmentById(id)
    if (!department) return fail(res, 404, `no department with id ${id}`)

    const body: DepartmentResponse = { department }
    res.json(body)
  } catch (err) {
    handleUnexpected(res, err)
  }
})

departmentsRouter.post('/departments', canWrite, async (req: Request, res: Response) => {
  const actor = actorOf(req)
  if (!actor) return fail(res, 500, 'server misconfigured')

  const parsed = parseDepartmentInput(req.body)
  if (!parsed.ok) return fail(res, 400, parsed.message)
  const input = parsed.value

  // A brand new row has no id yet, so it can't already be an ancestor of
  // anything — the only thing left to check is that the parent exists,
  // which the FK constraint below already enforces.

  try {
    const department = await withTransaction(async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO master_departments (dept_code, dept_name, parent_department_id, is_active)
         VALUES ($1, $2, $3, $4)
         RETURNING id`,
        [input.deptCode, input.deptName, input.parentDepartmentId, input.isActive]
      )
      const created = rows[0]
      if (!created) throw new Error('insert into master_departments returned no id')

      await recordAudit(client, {
        actor,
        action: 'department.create',
        entityId: Number(created.id),
        detail: { deptCode: input.deptCode },
      })

      const department = await findDepartmentById(Number(created.id), client)
      if (!department) throw new Error('inserted department not found on read-back')
      return department
    })

    const body: DepartmentResponse = { department }
    res.status(201).json(body)
  } catch (err) {
    if (isUniqueViolation(err)) {
      return fail(res, 409, `department code "${input.deptCode}" is already taken`)
    }
    if (isForeignKeyViolation(err)) {
      return fail(res, 400, `no department with id ${input.parentDepartmentId}`)
    }
    handleUnexpected(res, err)
  }
})

// PUT, not PATCH: the body is a complete department, matching jobs.
departmentsRouter.put('/departments/:id', canWrite, async (req: Request, res: Response) => {
  const actor = actorOf(req)
  if (!actor) return fail(res, 500, 'server misconfigured')

  const id = parseId(req.params['id'])
  if (id === null) return fail(res, 400, 'id must be a positive integer')

  const parsed = parseDepartmentInput(req.body)
  if (!parsed.ok) return fail(res, 400, parsed.message)
  const input = parsed.value

  if (input.parentDepartmentId !== null) {
    if (input.parentDepartmentId === id) {
      return fail(res, 400, 'a department cannot be its own parent department')
    }
    try {
      if (await wouldCreateCycle(id, input.parentDepartmentId)) {
        return fail(
          res,
          400,
          'that parent department would create a cycle in the department hierarchy'
        )
      }
    } catch (err) {
      return handleUnexpected(res, err)
    }
  }

  try {
    const updated = await withTransaction(async (client) => {
      const { rowCount } = await client.query(
        `UPDATE master_departments SET
           dept_code = $2, dept_name = $3,
           parent_department_id = $4, is_active = $5, updated_at = now()
         WHERE id = $1`,
        [id, input.deptCode, input.deptName, input.parentDepartmentId, input.isActive]
      )
      if (rowCount === 0) return false

      await recordAudit(client, {
        actor,
        action: 'department.update',
        entityId: id,
        detail: { deptCode: input.deptCode },
      })
      return true
    })

    if (!updated) return fail(res, 404, `no department with id ${id}`)

    const department = await findDepartmentById(id)
    if (!department) return fail(res, 404, `no department with id ${id}`)

    const body: DepartmentResponse = { department }
    res.json(body)
  } catch (err) {
    if (isUniqueViolation(err)) {
      return fail(res, 409, `department code "${input.deptCode}" is already taken`)
    }
    if (isForeignKeyViolation(err)) {
      return fail(res, 400, `no department with id ${input.parentDepartmentId}`)
    }
    handleUnexpected(res, err)
  }
})

function isForeignKeyViolation(err: unknown): boolean {
  return (
    typeof err === 'object' && err !== null && (err as { code?: unknown }).code === '23503'
  )
}
