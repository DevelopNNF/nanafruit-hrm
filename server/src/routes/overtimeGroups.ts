import { Router } from 'express'
import type { Request, Response } from 'express'
import {
  OVERTIME_ROUNDING_MINUTES,
  ROLES,
  type AuthUser,
  type OvertimeGroupInput,
  type OvertimeGroupListResponse,
  type OvertimeGroupResponse,
} from '@hrm/shared'
import { pool, withTransaction } from '../db.js'
import { requireRole } from '../auth/middleware.js'
import { recordAudit } from '../audit.js'
import { fail, handleUnexpected } from '../http.js'
import {
  SELECT_OVERTIME_GROUP,
  findOvertimeGroupById,
  rowToOvertimeGroup,
  type OvertimeGroupRow,
} from '../overtimeGroupQueries.js'

export const overtimeGroupsRouter = Router()

// Same split as jobs/shifts/locations/holiday groups: any HRM role can read
// the group list, only HR and Admin can change it.
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

function requiredPositiveNumber(source: Record<string, unknown>, key: string): number | null {
  const value = source[key]
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

const RATE_FIELDS = [
  'rateOtWorkday',
  'rateNormalDayoff',
  'rateOtDayoff',
  'rateNormalHoliday',
  'rateOtHoliday',
] as const

function parseOvertimeGroupInput(body: unknown): ParseResult<OvertimeGroupInput> {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, message: 'body must be a JSON object' }
  }
  const raw = body as Record<string, unknown>

  const groupCode = requiredString(raw, 'groupCode')
  if (groupCode === null) return { ok: false, message: 'groupCode is required' }

  const groupName = requiredString(raw, 'groupName')
  if (groupName === null) return { ok: false, message: 'groupName is required' }

  const rates: Record<(typeof RATE_FIELDS)[number], number> = {} as never
  for (const key of RATE_FIELDS) {
    const value = requiredPositiveNumber(raw, key)
    if (value === null) return { ok: false, message: `${key} is required and must be a positive number` }
    rates[key] = value
  }

  const roundingMinutesRaw = raw['roundingMinutes']
  if (
    typeof roundingMinutesRaw !== 'number' ||
    !(OVERTIME_ROUNDING_MINUTES as readonly number[]).includes(roundingMinutesRaw)
  ) {
    return {
      ok: false,
      message: `roundingMinutes must be one of: ${OVERTIME_ROUNDING_MINUTES.join(', ')}`,
    }
  }

  const isActiveRaw = raw['isActive']
  if (typeof isActiveRaw !== 'boolean') {
    return { ok: false, message: 'isActive must be a boolean' }
  }

  return {
    ok: true,
    value: {
      groupCode,
      groupName,
      rateOtWorkday: rates.rateOtWorkday,
      rateNormalDayoff: rates.rateNormalDayoff,
      rateOtDayoff: rates.rateOtDayoff,
      rateNormalHoliday: rates.rateNormalHoliday,
      rateOtHoliday: rates.rateOtHoliday,
      roundingMinutes: roundingMinutesRaw as OvertimeGroupInput['roundingMinutes'],
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

overtimeGroupsRouter.get('/overtime-groups', canRead, async (_req: Request, res: Response) => {
  try {
    const { rows } = await pool.query<OvertimeGroupRow>(
      `${SELECT_OVERTIME_GROUP} ORDER BY group_name`
    )
    const body: OvertimeGroupListResponse = { overtimeGroups: rows.map(rowToOvertimeGroup) }
    res.json(body)
  } catch (err) {
    handleUnexpected(res, err)
  }
})

overtimeGroupsRouter.get('/overtime-groups/:id', canRead, async (req: Request, res: Response) => {
  const id = parseId(req.params['id'])
  if (id === null) return fail(res, 400, 'id must be a positive integer')

  try {
    const overtimeGroup = await findOvertimeGroupById(id)
    if (!overtimeGroup) return fail(res, 404, `no overtime group with id ${id}`)

    const body: OvertimeGroupResponse = { overtimeGroup }
    res.json(body)
  } catch (err) {
    handleUnexpected(res, err)
  }
})

overtimeGroupsRouter.post('/overtime-groups', canWrite, async (req: Request, res: Response) => {
  const actor = actorOf(req)
  if (!actor) return fail(res, 500, 'server misconfigured')

  const parsed = parseOvertimeGroupInput(req.body)
  if (!parsed.ok) return fail(res, 400, parsed.message)
  const input = parsed.value

  try {
    const overtimeGroup = await withTransaction(async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO master_overtime_groups
           (group_code, group_name, rate_ot_workday, rate_normal_dayoff, rate_ot_dayoff,
            rate_normal_holiday, rate_ot_holiday, rounding_minutes, is_active)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING id`,
        [
          input.groupCode,
          input.groupName,
          input.rateOtWorkday,
          input.rateNormalDayoff,
          input.rateOtDayoff,
          input.rateNormalHoliday,
          input.rateOtHoliday,
          input.roundingMinutes,
          input.isActive,
        ]
      )
      const created = rows[0]
      if (!created) throw new Error('insert into master_overtime_groups returned no id')

      await recordAudit(client, {
        actor,
        action: 'overtime_group.create',
        entityId: Number(created.id),
        detail: { groupCode: input.groupCode },
      })

      return { ...input, id: Number(created.id) } satisfies OvertimeGroupResponse['overtimeGroup']
    })

    const body: OvertimeGroupResponse = { overtimeGroup }
    res.status(201).json(body)
  } catch (err) {
    if (isUniqueViolation(err)) {
      return fail(res, 409, `group code "${input.groupCode}" is already taken`)
    }
    handleUnexpected(res, err)
  }
})

// PUT, not PATCH: the body is a complete group, matching jobs/shifts/locations/holiday groups.
overtimeGroupsRouter.put('/overtime-groups/:id', canWrite, async (req: Request, res: Response) => {
  const actor = actorOf(req)
  if (!actor) return fail(res, 500, 'server misconfigured')

  const id = parseId(req.params['id'])
  if (id === null) return fail(res, 400, 'id must be a positive integer')

  const parsed = parseOvertimeGroupInput(req.body)
  if (!parsed.ok) return fail(res, 400, parsed.message)
  const input = parsed.value

  try {
    const updated = await withTransaction(async (client) => {
      const { rowCount } = await client.query(
        `UPDATE master_overtime_groups SET
           group_code = $2, group_name = $3, rate_ot_workday = $4, rate_normal_dayoff = $5,
           rate_ot_dayoff = $6, rate_normal_holiday = $7, rate_ot_holiday = $8,
           rounding_minutes = $9, is_active = $10, updated_at = now()
         WHERE id = $1`,
        [
          id,
          input.groupCode,
          input.groupName,
          input.rateOtWorkday,
          input.rateNormalDayoff,
          input.rateOtDayoff,
          input.rateNormalHoliday,
          input.rateOtHoliday,
          input.roundingMinutes,
          input.isActive,
        ]
      )
      if (rowCount === 0) return false

      await recordAudit(client, {
        actor,
        action: 'overtime_group.update',
        entityId: id,
        detail: { groupCode: input.groupCode },
      })
      return true
    })

    if (!updated) return fail(res, 404, `no overtime group with id ${id}`)

    const body: OvertimeGroupResponse = { overtimeGroup: { ...input, id } }
    res.json(body)
  } catch (err) {
    if (isUniqueViolation(err)) {
      return fail(res, 409, `group code "${input.groupCode}" is already taken`)
    }
    handleUnexpected(res, err)
  }
})
