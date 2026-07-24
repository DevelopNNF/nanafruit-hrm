import { Router } from 'express'
import type { Request, Response } from 'express'
import {
  ROLES,
  type AuthUser,
  type LeaveTypeInput,
  type LeaveTypeListResponse,
  type LeaveTypeResponse,
} from '@hrm/shared'
import { pool, withTransaction } from '../db.js'
import { requireRole } from '../auth/middleware.js'
import { recordAudit } from '../audit.js'
import { fail, handleUnexpected } from '../http.js'
import {
  SELECT_LEAVE_TYPE,
  findLeaveTypeById,
  rowToLeaveType,
  type LeaveTypeRow,
} from '../leaveTypeQueries.js'

export const leaveTypesRouter = Router()

// Same split as jobs/shifts/locations: any HRM role can read the leave type
// list, only HR and Admin can change it.
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

function requiredBoolean(source: Record<string, unknown>, key: string): boolean | null {
  const value = source[key]
  return typeof value === 'boolean' ? value : null
}

const GENDER_OPTIONS = ['all', 'male', 'female'] as const

function parseLeaveTypeInput(body: unknown): ParseResult<LeaveTypeInput> {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, message: 'body must be a JSON object' }
  }
  const raw = body as Record<string, unknown>

  const leaveCode = requiredString(raw, 'leaveCode')
  if (leaveCode === null) return { ok: false, message: 'leaveCode is required' }

  const leaveName = requiredString(raw, 'leaveName')
  if (leaveName === null) return { ok: false, message: 'leaveName is required' }

  const booleanFields = [
    'isPaid',
    'allowHalfDay',
    'allowHourly',
    'isCountHoliday',
    'isCountWeekend',
    'isActive',
  ] as const
  const booleans: Record<(typeof booleanFields)[number], boolean> = {} as never
  for (const key of booleanFields) {
    const value = requiredBoolean(raw, key)
    if (value === null) return { ok: false, message: `${key} must be a boolean` }
    booleans[key] = value
  }

  const minLeaveDaysRaw = raw['minLeaveDays']
  if (typeof minLeaveDaysRaw !== 'number' || !Number.isFinite(minLeaveDaysRaw) || minLeaveDaysRaw <= 0) {
    return { ok: false, message: 'minLeaveDays must be a positive number' }
  }

  const maxLeaveDaysRaw = raw['maxLeaveDays']
  let maxLeaveDays: number | null
  if (maxLeaveDaysRaw === null || maxLeaveDaysRaw === undefined) {
    maxLeaveDays = null
  } else if (typeof maxLeaveDaysRaw === 'number' && Number.isFinite(maxLeaveDaysRaw)) {
    maxLeaveDays = maxLeaveDaysRaw
  } else {
    return { ok: false, message: 'maxLeaveDays must be a number or null' }
  }
  if (maxLeaveDays !== null && maxLeaveDays < minLeaveDaysRaw) {
    return { ok: false, message: 'maxLeaveDays must be greater than or equal to minLeaveDays' }
  }

  const advanceNoticeDaysRaw = raw['advanceNoticeDays']
  if (
    typeof advanceNoticeDaysRaw !== 'number' ||
    !Number.isInteger(advanceNoticeDaysRaw) ||
    advanceNoticeDaysRaw < 0
  ) {
    return { ok: false, message: 'advanceNoticeDays must be a non-negative integer' }
  }

  const genderRaw = raw['gender']
  if (typeof genderRaw !== 'string' || !(GENDER_OPTIONS as readonly string[]).includes(genderRaw)) {
    return { ok: false, message: `gender must be one of: ${GENDER_OPTIONS.join(', ')}` }
  }

  const sortOrderRaw = raw['sortOrder']
  if (typeof sortOrderRaw !== 'number' || !Number.isInteger(sortOrderRaw)) {
    return { ok: false, message: 'sortOrder must be an integer' }
  }

  const defaultDaysPerYearRaw = raw['defaultDaysPerYear']
  let defaultDaysPerYear: number | null
  if (defaultDaysPerYearRaw === null || defaultDaysPerYearRaw === undefined) {
    defaultDaysPerYear = null
  } else if (
    typeof defaultDaysPerYearRaw === 'number' &&
    Number.isFinite(defaultDaysPerYearRaw) &&
    defaultDaysPerYearRaw > 0
  ) {
    defaultDaysPerYear = defaultDaysPerYearRaw
  } else {
    return { ok: false, message: 'defaultDaysPerYear must be a positive number or null' }
  }

  return {
    ok: true,
    value: {
      leaveCode,
      leaveName,
      isPaid: booleans.isPaid,
      allowHalfDay: booleans.allowHalfDay,
      allowHourly: booleans.allowHourly,
      minLeaveDays: minLeaveDaysRaw,
      maxLeaveDays,
      advanceNoticeDays: advanceNoticeDaysRaw,
      gender: genderRaw as LeaveTypeInput['gender'],
      isCountHoliday: booleans.isCountHoliday,
      isCountWeekend: booleans.isCountWeekend,
      defaultDaysPerYear,
      sortOrder: sortOrderRaw,
      isActive: booleans.isActive,
    },
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

leaveTypesRouter.get('/leave-types', canRead, async (_req: Request, res: Response) => {
  try {
    const { rows } = await pool.query<LeaveTypeRow>(
      `${SELECT_LEAVE_TYPE} ORDER BY sort_order, leave_name`
    )
    const body: LeaveTypeListResponse = { leaveTypes: rows.map(rowToLeaveType) }
    res.json(body)
  } catch (err) {
    handleUnexpected(res, err)
  }
})

leaveTypesRouter.get('/leave-types/:id', canRead, async (req: Request, res: Response) => {
  const id = parseId(req.params['id'])
  if (id === null) return fail(res, 400, 'id must be a positive integer')

  try {
    const leaveType = await findLeaveTypeById(id)
    if (!leaveType) return fail(res, 404, `no leave type with id ${id}`)

    const body: LeaveTypeResponse = { leaveType }
    res.json(body)
  } catch (err) {
    handleUnexpected(res, err)
  }
})

leaveTypesRouter.post('/leave-types', canWrite, async (req: Request, res: Response) => {
  const actor = actorOf(req)
  if (!actor) return fail(res, 500, 'server misconfigured')

  const parsed = parseLeaveTypeInput(req.body)
  if (!parsed.ok) return fail(res, 400, parsed.message)
  const input = parsed.value

  try {
    const leaveType = await withTransaction(async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO master_leave_types
           (leave_code, leave_name, is_paid, allow_half_day, allow_hourly,
            min_leave_days, max_leave_days, advance_notice_days, gender,
            is_count_holiday, is_count_weekend, default_days_per_year, sort_order, is_active)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         RETURNING id`,
        [
          input.leaveCode,
          input.leaveName,
          input.isPaid,
          input.allowHalfDay,
          input.allowHourly,
          input.minLeaveDays,
          input.maxLeaveDays,
          input.advanceNoticeDays,
          input.gender,
          input.isCountHoliday,
          input.isCountWeekend,
          input.defaultDaysPerYear,
          input.sortOrder,
          input.isActive,
        ]
      )
      const created = rows[0]
      if (!created) throw new Error('insert into master_leave_types returned no id')

      await recordAudit(client, {
        actor,
        action: 'leave_type.create',
        entityId: Number(created.id),
        detail: { leaveCode: input.leaveCode },
      })

      return { ...input, id: Number(created.id) } satisfies LeaveTypeResponse['leaveType']
    })

    const body: LeaveTypeResponse = { leaveType }
    res.status(201).json(body)
  } catch (err) {
    if (isUniqueViolation(err)) {
      return fail(res, 409, `leave code "${input.leaveCode}" is already taken`)
    }
    handleUnexpected(res, err)
  }
})

// PUT, not PATCH: the body is a complete leave type, matching jobs/shifts/locations.
leaveTypesRouter.put('/leave-types/:id', canWrite, async (req: Request, res: Response) => {
  const actor = actorOf(req)
  if (!actor) return fail(res, 500, 'server misconfigured')

  const id = parseId(req.params['id'])
  if (id === null) return fail(res, 400, 'id must be a positive integer')

  const parsed = parseLeaveTypeInput(req.body)
  if (!parsed.ok) return fail(res, 400, parsed.message)
  const input = parsed.value

  try {
    const updated = await withTransaction(async (client) => {
      const { rowCount } = await client.query(
        `UPDATE master_leave_types SET
           leave_code = $2, leave_name = $3, is_paid = $4,
           allow_half_day = $5, allow_hourly = $6,
           min_leave_days = $7, max_leave_days = $8, advance_notice_days = $9,
           gender = $10, is_count_holiday = $11, is_count_weekend = $12,
           default_days_per_year = $13, sort_order = $14, is_active = $15, updated_at = now()
         WHERE id = $1`,
        [
          id,
          input.leaveCode,
          input.leaveName,
          input.isPaid,
          input.allowHalfDay,
          input.allowHourly,
          input.minLeaveDays,
          input.maxLeaveDays,
          input.advanceNoticeDays,
          input.gender,
          input.isCountHoliday,
          input.isCountWeekend,
          input.defaultDaysPerYear,
          input.sortOrder,
          input.isActive,
        ]
      )
      if (rowCount === 0) return false

      await recordAudit(client, {
        actor,
        action: 'leave_type.update',
        entityId: id,
        detail: { leaveCode: input.leaveCode },
      })
      return true
    })

    if (!updated) return fail(res, 404, `no leave type with id ${id}`)

    const body: LeaveTypeResponse = { leaveType: { ...input, id } }
    res.json(body)
  } catch (err) {
    if (isUniqueViolation(err)) {
      return fail(res, 409, `leave code "${input.leaveCode}" is already taken`)
    }
    handleUnexpected(res, err)
  }
})
