import { Router } from 'express'
import type { Request, Response } from 'express'
import {
  ROLES,
  WORKDAYS_MASK,
  type AuthUser,
  type ShiftInput,
  type ShiftListResponse,
  type ShiftResponse,
} from '@hrm/shared'
import { pool, withTransaction } from '../db.js'
import { requireRole } from '../auth/middleware.js'
import { recordAudit } from '../audit.js'
import { fail, handleUnexpected } from '../http.js'
import { SELECT_SHIFT, findShiftById, rowToShift, type ShiftRow } from '../shiftQueries.js'

export const shiftsRouter = Router()

// Same split as jobs: any HRM role can read the shift list, only HR and
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

// Accepts 'HH:MM' or 'HH:MM:SS'; the leading part is what <input type="time">
// sends, the trailing seconds is what a full round-trip through Postgres `time`
// hands back — either is a valid wall-clock time to store.
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)(:[0-5]\d)?$/

function requiredTime(source: Record<string, unknown>, key: string): string | null {
  const value = source[key]
  if (typeof value !== 'string' || !TIME_RE.test(value)) return null
  return value
}

/** Absent, null and '' all mean "no time" for the optional break fields. */
function optionalTime(source: Record<string, unknown>, key: string): string | null | undefined {
  const value = source[key]
  if (value === null || value === undefined || value === '') return null
  return typeof value === 'string' && TIME_RE.test(value) ? value : undefined
}

function parseShiftInput(body: unknown): ParseResult<ShiftInput> {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, message: 'body must be a JSON object' }
  }
  const raw = body as Record<string, unknown>

  const shiftCode = requiredString(raw, 'shiftCode')
  if (shiftCode === null) return { ok: false, message: 'shiftCode is required' }

  const shiftName = requiredString(raw, 'shiftName')
  if (shiftName === null) return { ok: false, message: 'shiftName is required' }

  const shiftStartTime = requiredTime(raw, 'shiftStartTime')
  if (shiftStartTime === null) {
    return { ok: false, message: 'shiftStartTime is required and must be HH:MM' }
  }

  const shiftEndTime = requiredTime(raw, 'shiftEndTime')
  if (shiftEndTime === null) {
    return { ok: false, message: 'shiftEndTime is required and must be HH:MM' }
  }

  const breakStartTime = optionalTime(raw, 'breakStartTime')
  if (breakStartTime === undefined) {
    return { ok: false, message: 'breakStartTime must be HH:MM or null' }
  }

  const breakEndTime = optionalTime(raw, 'breakEndTime')
  if (breakEndTime === undefined) {
    return { ok: false, message: 'breakEndTime must be HH:MM or null' }
  }

  if ((breakStartTime === null) !== (breakEndTime === null)) {
    return { ok: false, message: 'breakStartTime and breakEndTime must both be set, or both be empty' }
  }
  // A shift's break doesn't cross midnight even when the shift itself does,
  // so a plain string comparison is enough here.
  if (breakStartTime !== null && breakEndTime !== null && breakStartTime >= breakEndTime) {
    return { ok: false, message: 'breakStartTime must be before breakEndTime' }
  }

  const workdaysRaw = raw['workdays']
  if (
    typeof workdaysRaw !== 'number' ||
    !Number.isInteger(workdaysRaw) ||
    workdaysRaw < 0 ||
    workdaysRaw > WORKDAYS_MASK
  ) {
    return { ok: false, message: `workdays must be an integer between 0 and ${WORKDAYS_MASK}` }
  }

  const isActiveRaw = raw['isActive']
  if (typeof isActiveRaw !== 'boolean') {
    return { ok: false, message: 'isActive must be a boolean' }
  }

  return {
    ok: true,
    value: {
      shiftCode,
      shiftName,
      shiftStartTime,
      shiftEndTime,
      breakStartTime,
      breakEndTime,
      workdays: workdaysRaw,
      isActive: isActiveRaw,
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

shiftsRouter.get('/shifts', canRead, async (_req: Request, res: Response) => {
  try {
    const { rows } = await pool.query<ShiftRow>(`${SELECT_SHIFT} ORDER BY shift_code`)
    const body: ShiftListResponse = { shifts: rows.map(rowToShift) }
    res.json(body)
  } catch (err) {
    handleUnexpected(res, err)
  }
})

shiftsRouter.get('/shifts/:id', canRead, async (req: Request, res: Response) => {
  const id = parseId(req.params['id'])
  if (id === null) return fail(res, 400, 'id must be a positive integer')

  try {
    const shift = await findShiftById(id)
    if (!shift) return fail(res, 404, `no shift with id ${id}`)

    const body: ShiftResponse = { shift }
    res.json(body)
  } catch (err) {
    handleUnexpected(res, err)
  }
})

shiftsRouter.post('/shifts', canWrite, async (req: Request, res: Response) => {
  const actor = actorOf(req)
  if (!actor) return fail(res, 500, 'server misconfigured')

  const parsed = parseShiftInput(req.body)
  if (!parsed.ok) return fail(res, 400, parsed.message)
  const input = parsed.value

  try {
    const shift = await withTransaction(async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO master_shifts
           (shift_code, shift_name, shift_start_time, shift_end_time,
            break_start_time, break_end_time, workdays, is_active)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id`,
        [
          input.shiftCode,
          input.shiftName,
          input.shiftStartTime,
          input.shiftEndTime,
          input.breakStartTime,
          input.breakEndTime,
          input.workdays,
          input.isActive,
        ]
      )
      const created = rows[0]
      if (!created) throw new Error('insert into master_shifts returned no id')

      await recordAudit(client, {
        actor,
        action: 'shift.create',
        entityId: Number(created.id),
        detail: { shiftCode: input.shiftCode },
      })

      return { ...input, id: Number(created.id) } satisfies ShiftResponse['shift']
    })

    const body: ShiftResponse = { shift }
    res.status(201).json(body)
  } catch (err) {
    if (isUniqueViolation(err)) {
      return fail(res, 409, `shift code "${input.shiftCode}" is already taken`)
    }
    handleUnexpected(res, err)
  }
})

// PUT, not PATCH: the body is a complete shift, matching jobs and employees.
shiftsRouter.put('/shifts/:id', canWrite, async (req: Request, res: Response) => {
  const actor = actorOf(req)
  if (!actor) return fail(res, 500, 'server misconfigured')

  const id = parseId(req.params['id'])
  if (id === null) return fail(res, 400, 'id must be a positive integer')

  const parsed = parseShiftInput(req.body)
  if (!parsed.ok) return fail(res, 400, parsed.message)
  const input = parsed.value

  try {
    const updated = await withTransaction(async (client) => {
      const { rowCount } = await client.query(
        `UPDATE master_shifts SET
           shift_code = $2, shift_name = $3, shift_start_time = $4, shift_end_time = $5,
           break_start_time = $6, break_end_time = $7, workdays = $8, is_active = $9,
           updated_at = now()
         WHERE id = $1`,
        [
          id,
          input.shiftCode,
          input.shiftName,
          input.shiftStartTime,
          input.shiftEndTime,
          input.breakStartTime,
          input.breakEndTime,
          input.workdays,
          input.isActive,
        ]
      )
      if (rowCount === 0) return false

      await recordAudit(client, {
        actor,
        action: 'shift.update',
        entityId: id,
        detail: { shiftCode: input.shiftCode },
      })
      return true
    })

    if (!updated) return fail(res, 404, `no shift with id ${id}`)

    const body: ShiftResponse = { shift: { ...input, id } }
    res.json(body)
  } catch (err) {
    if (isUniqueViolation(err)) {
      return fail(res, 409, `shift code "${input.shiftCode}" is already taken`)
    }
    handleUnexpected(res, err)
  }
})
