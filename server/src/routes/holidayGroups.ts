import { Router } from 'express'
import type { Request, Response } from 'express'
import {
  ROLES,
  type AuthUser,
  type HolidayGroupInput,
  type HolidayGroupListResponse,
  type HolidayGroupResponse,
} from '@hrm/shared'
import { pool, withTransaction } from '../db.js'
import { requireRole } from '../auth/middleware.js'
import { recordAudit } from '../audit.js'
import { fail, handleUnexpected } from '../http.js'
import {
  SELECT_HOLIDAY_GROUP,
  findHolidayGroupById,
  rowToHolidayGroup,
  type HolidayGroupRow,
} from '../holidayGroupQueries.js'

export const holidayGroupsRouter = Router()

// Same split as jobs/shifts/locations/leave types: any HRM role can read the
// group list, only HR and Admin can change it.
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

function parseHolidayGroupInput(body: unknown): ParseResult<HolidayGroupInput> {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, message: 'body must be a JSON object' }
  }
  const raw = body as Record<string, unknown>

  const groupCode = requiredString(raw, 'groupCode')
  if (groupCode === null) return { ok: false, message: 'groupCode is required' }

  const groupName = requiredString(raw, 'groupName')
  if (groupName === null) return { ok: false, message: 'groupName is required' }

  const isActiveRaw = raw['isActive']
  if (typeof isActiveRaw !== 'boolean') {
    return { ok: false, message: 'isActive must be a boolean' }
  }

  return { ok: true, value: { groupCode, groupName, isActive: isActiveRaw } }
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

holidayGroupsRouter.get('/holiday-groups', canRead, async (_req: Request, res: Response) => {
  try {
    const { rows } = await pool.query<HolidayGroupRow>(
      `${SELECT_HOLIDAY_GROUP} ORDER BY group_name`
    )
    const body: HolidayGroupListResponse = { holidayGroups: rows.map(rowToHolidayGroup) }
    res.json(body)
  } catch (err) {
    handleUnexpected(res, err)
  }
})

holidayGroupsRouter.get('/holiday-groups/:id', canRead, async (req: Request, res: Response) => {
  const id = parseId(req.params['id'])
  if (id === null) return fail(res, 400, 'id must be a positive integer')

  try {
    const holidayGroup = await findHolidayGroupById(id)
    if (!holidayGroup) return fail(res, 404, `no holiday group with id ${id}`)

    const body: HolidayGroupResponse = { holidayGroup }
    res.json(body)
  } catch (err) {
    handleUnexpected(res, err)
  }
})

holidayGroupsRouter.post('/holiday-groups', canWrite, async (req: Request, res: Response) => {
  const actor = actorOf(req)
  if (!actor) return fail(res, 500, 'server misconfigured')

  const parsed = parseHolidayGroupInput(req.body)
  if (!parsed.ok) return fail(res, 400, parsed.message)
  const input = parsed.value

  try {
    const holidayGroup = await withTransaction(async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO master_holiday_groups (group_code, group_name, is_active)
         VALUES ($1, $2, $3)
         RETURNING id`,
        [input.groupCode, input.groupName, input.isActive]
      )
      const created = rows[0]
      if (!created) throw new Error('insert into master_holiday_groups returned no id')

      await recordAudit(client, {
        actor,
        action: 'holiday_group.create',
        entityId: Number(created.id),
        detail: { groupCode: input.groupCode },
      })

      return { ...input, id: Number(created.id) } satisfies HolidayGroupResponse['holidayGroup']
    })

    const body: HolidayGroupResponse = { holidayGroup }
    res.status(201).json(body)
  } catch (err) {
    if (isUniqueViolation(err)) {
      return fail(res, 409, `group code "${input.groupCode}" is already taken`)
    }
    handleUnexpected(res, err)
  }
})

// PUT, not PATCH: the body is a complete group, matching jobs/shifts/locations.
holidayGroupsRouter.put('/holiday-groups/:id', canWrite, async (req: Request, res: Response) => {
  const actor = actorOf(req)
  if (!actor) return fail(res, 500, 'server misconfigured')

  const id = parseId(req.params['id'])
  if (id === null) return fail(res, 400, 'id must be a positive integer')

  const parsed = parseHolidayGroupInput(req.body)
  if (!parsed.ok) return fail(res, 400, parsed.message)
  const input = parsed.value

  try {
    const updated = await withTransaction(async (client) => {
      const { rowCount } = await client.query(
        `UPDATE master_holiday_groups SET
           group_code = $2, group_name = $3, is_active = $4, updated_at = now()
         WHERE id = $1`,
        [id, input.groupCode, input.groupName, input.isActive]
      )
      if (rowCount === 0) return false

      await recordAudit(client, {
        actor,
        action: 'holiday_group.update',
        entityId: id,
        detail: { groupCode: input.groupCode },
      })
      return true
    })

    if (!updated) return fail(res, 404, `no holiday group with id ${id}`)

    const body: HolidayGroupResponse = { holidayGroup: { ...input, id } }
    res.json(body)
  } catch (err) {
    if (isUniqueViolation(err)) {
      return fail(res, 409, `group code "${input.groupCode}" is already taken`)
    }
    handleUnexpected(res, err)
  }
})
