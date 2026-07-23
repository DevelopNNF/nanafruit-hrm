import { Router } from 'express'
import type { Request, Response } from 'express'
import {
  ROLES,
  type AuthUser,
  type HolidayInput,
  type HolidayListResponse,
  type HolidayResponse,
} from '@hrm/shared'
import { pool, withTransaction } from '../db.js'
import { requireRole } from '../auth/middleware.js'
import { recordAudit } from '../audit.js'
import { fail, handleUnexpected } from '../http.js'
import { SELECT_HOLIDAY, rowToHoliday, type HolidayRow } from '../holidayQueries.js'

export const holidaysRouter = Router()

// Same split as holiday groups: any HRM role can read, only HR and Admin
// can change.
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

function parseHolidayInput(body: unknown): ParseResult<HolidayInput> {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, message: 'body must be a JSON object' }
  }
  const raw = body as Record<string, unknown>

  const holidayName = requiredString(raw, 'holidayName')
  if (holidayName === null) return { ok: false, message: 'holidayName is required' }

  const holidayDate = requiredString(raw, 'holidayDate')
  if (holidayDate === null || !isCalendarDate(holidayDate)) {
    return { ok: false, message: 'holidayDate must be a date as YYYY-MM-DD' }
  }

  return { ok: true, value: { holidayName, holidayDate } }
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

function isForeignKeyViolation(err: unknown): boolean {
  return (
    typeof err === 'object' && err !== null && (err as { code?: unknown }).code === '23503'
  )
}

// Scoped to a group rather than a flat /holidays list: a holiday only ever
// makes sense in the context of which calendar it belongs to, same as how
// time-correction requests are always read per employee, never globally
// unscoped.
holidaysRouter.get(
  '/holiday-groups/:groupId/holidays',
  canRead,
  async (req: Request, res: Response) => {
    const groupId = parseId(req.params['groupId'])
    if (groupId === null) return fail(res, 400, 'groupId must be a positive integer')

    try {
      const { rows } = await pool.query<HolidayRow>(
        `${SELECT_HOLIDAY} WHERE group_id = $1 ORDER BY holiday_date`,
        [groupId]
      )
      const body: HolidayListResponse = { holidays: rows.map(rowToHoliday) }
      res.json(body)
    } catch (err) {
      handleUnexpected(res, err)
    }
  }
)

holidaysRouter.post(
  '/holiday-groups/:groupId/holidays',
  canWrite,
  async (req: Request, res: Response) => {
    const actor = actorOf(req)
    if (!actor) return fail(res, 500, 'server misconfigured')

    const groupId = parseId(req.params['groupId'])
    if (groupId === null) return fail(res, 400, 'groupId must be a positive integer')

    const parsed = parseHolidayInput(req.body)
    if (!parsed.ok) return fail(res, 400, parsed.message)
    const input = parsed.value

    try {
      const holiday = await withTransaction(async (client) => {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO master_holidays (group_id, holiday_name, holiday_date)
           VALUES ($1, $2, $3)
           RETURNING id`,
          [groupId, input.holidayName, input.holidayDate]
        )
        const created = rows[0]
        if (!created) throw new Error('insert into master_holidays returned no id')

        await recordAudit(client, {
          actor,
          action: 'holiday.create',
          entityId: Number(created.id),
          detail: { groupId, holidayDate: input.holidayDate },
        })

        return {
          ...input,
          id: Number(created.id),
          groupId,
        } satisfies HolidayResponse['holiday']
      })

      const body: HolidayResponse = { holiday }
      res.status(201).json(body)
    } catch (err) {
      if (isUniqueViolation(err)) {
        return fail(res, 409, `${input.holidayDate} is already a holiday in this group`)
      }
      if (isForeignKeyViolation(err)) return fail(res, 400, `no holiday group with id ${groupId}`)
      handleUnexpected(res, err)
    }
  }
)

// PUT, not PATCH: the body is a complete holiday. groupId is not part of the
// route or body here — which group a holiday belongs to is fixed at
// creation, so :id alone identifies the row to update.
holidaysRouter.put('/holidays/:id', canWrite, async (req: Request, res: Response) => {
  const actor = actorOf(req)
  if (!actor) return fail(res, 500, 'server misconfigured')

  const id = parseId(req.params['id'])
  if (id === null) return fail(res, 400, 'id must be a positive integer')

  const parsed = parseHolidayInput(req.body)
  if (!parsed.ok) return fail(res, 400, parsed.message)
  const input = parsed.value

  try {
    const result = await withTransaction(async (client) => {
      const { rows } = await client.query<{ group_id: string }>(
        `UPDATE master_holidays SET
           holiday_name = $2, holiday_date = $3, updated_at = now()
         WHERE id = $1
         RETURNING group_id`,
        [id, input.holidayName, input.holidayDate]
      )
      const row = rows[0]
      if (!row) return 'not-found' as const

      await recordAudit(client, {
        actor,
        action: 'holiday.update',
        entityId: id,
        detail: { holidayDate: input.holidayDate },
      })
      return Number(row.group_id)
    })

    if (result === 'not-found') return fail(res, 404, `no holiday with id ${id}`)

    const body: HolidayResponse = { holiday: { ...input, id, groupId: result } }
    res.json(body)
  } catch (err) {
    if (isUniqueViolation(err)) {
      return fail(res, 409, `${input.holidayDate} is already a holiday in this group`)
    }
    handleUnexpected(res, err)
  }
})

// A real DELETE, unlike every other master table here: no foreign key points
// at a single master_holidays row (employment_details points at the group,
// never a date), so there is no "retire, don't delete" discipline to keep.
holidaysRouter.delete('/holidays/:id', canWrite, async (req: Request, res: Response) => {
  const actor = actorOf(req)
  if (!actor) return fail(res, 500, 'server misconfigured')

  const id = parseId(req.params['id'])
  if (id === null) return fail(res, 400, 'id must be a positive integer')

  try {
    const deleted = await withTransaction(async (client) => {
      const { rows } = await client.query<{ holiday_date: string }>(
        'DELETE FROM master_holidays WHERE id = $1 RETURNING holiday_date',
        [id]
      )
      const row = rows[0]
      if (!row) return false

      await recordAudit(client, {
        actor,
        action: 'holiday.delete',
        entityId: id,
        detail: { holidayDate: row.holiday_date },
      })
      return true
    })

    if (!deleted) return fail(res, 404, `no holiday with id ${id}`)
    res.status(204).end()
  } catch (err) {
    handleUnexpected(res, err)
  }
})
