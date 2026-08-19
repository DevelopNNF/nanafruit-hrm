import { Router } from 'express'
import type { Request, Response } from 'express'
import {
  PAY_DAY_RULES,
  ROLES,
  type AuthUser,
  type PayDayRule,
  type PayrollGroupInput,
  type PayrollGroupListResponse,
  type PayrollGroupResponse,
} from '@hrm/shared'
import { pool, withTransaction } from '../db.js'
import { requireRole } from '../auth/middleware.js'
import { recordAudit } from '../audit.js'
import { fail, handleUnexpected } from '../http.js'
import {
  SELECT_PAYROLL_GROUP,
  findPayrollGroupById,
  rowToPayrollGroup,
  type PayrollGroupRow,
} from '../payrollGroupQueries.js'

export const payrollGroupsRouter = Router()

// Reading is open to every HRM role, like the other masters: a group is a name
// and a cut-off day, not a salary.
//
// Writing is NOT. Every other master lets HR through; this one takes
// HRM.Payroll or HRM.Admin, because changing a group's cut-off day changes
// which days of work land in which pay run. HR keeps hiring, shifts and leave
// without ever holding this.
const canRead = requireRole(...ROLES)
const canWritePayroll = requireRole('HRM.Payroll', 'HRM.Admin')

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

function parsePayrollGroupInput(body: unknown): ParseResult<PayrollGroupInput> {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, message: 'body must be a JSON object' }
  }
  const raw = body as Record<string, unknown>

  const groupCode = requiredString(raw, 'groupCode')
  if (groupCode === null) return { ok: false, message: 'groupCode is required' }

  const groupName = requiredString(raw, 'groupName')
  if (groupName === null) return { ok: false, message: 'groupName is required' }

  // Mirrors the table's CHECK. 28 rather than 31 on purpose — see the
  // migration: a cut-off of the 30th does not exist in February.
  const cutoffDay = raw['cutoffDay']
  if (
    typeof cutoffDay !== 'number' ||
    !Number.isInteger(cutoffDay) ||
    cutoffDay < 1 ||
    cutoffDay > 28
  ) {
    return { ok: false, message: 'cutoffDay must be an integer between 1 and 28' }
  }

  const payDayRuleRaw = raw['payDayRule']
  if (
    typeof payDayRuleRaw !== 'string' ||
    !(PAY_DAY_RULES as readonly string[]).includes(payDayRuleRaw)
  ) {
    return { ok: false, message: `payDayRule must be one of: ${PAY_DAY_RULES.join(', ')}` }
  }
  const payDayRule = payDayRuleRaw as PayDayRule

  // Paired with payDayRule, exactly as the table's CHECK pairs them: a
  // fixed_day group without a day, or a last_day_of_month group carrying one,
  // is a row nobody can read twice the same way.
  const payDayOfMonthRaw = raw['payDayOfMonth'] ?? null
  let payDayOfMonth: number | null = null
  if (payDayRule === 'fixed_day') {
    if (
      typeof payDayOfMonthRaw !== 'number' ||
      !Number.isInteger(payDayOfMonthRaw) ||
      payDayOfMonthRaw < 1 ||
      payDayOfMonthRaw > 31
    ) {
      return {
        ok: false,
        message: 'payDayOfMonth must be an integer between 1 and 31 when payDayRule is fixed_day',
      }
    }
    payDayOfMonth = payDayOfMonthRaw
  } else if (payDayOfMonthRaw !== null) {
    return { ok: false, message: 'payDayOfMonth must be null unless payDayRule is fixed_day' }
  }

  const isActiveRaw = raw['isActive']
  if (typeof isActiveRaw !== 'boolean') {
    return { ok: false, message: 'isActive must be a boolean' }
  }

  return {
    ok: true,
    value: { groupCode, groupName, cutoffDay, payDayRule, payDayOfMonth, isActive: isActiveRaw },
  }
}

function parseId(value: string | string[] | undefined): number | null {
  if (typeof value !== 'string') return null
  const id = Number(value)
  return Number.isInteger(id) && id > 0 ? id : null
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === '23505'
}

payrollGroupsRouter.get('/payroll-groups', canRead, async (_req: Request, res: Response) => {
  try {
    const { rows } = await pool.query<PayrollGroupRow>(
      `${SELECT_PAYROLL_GROUP} ORDER BY group_name`
    )
    const body: PayrollGroupListResponse = { payrollGroups: rows.map(rowToPayrollGroup) }
    res.json(body)
  } catch (err) {
    handleUnexpected(res, err)
  }
})

payrollGroupsRouter.get('/payroll-groups/:id', canRead, async (req: Request, res: Response) => {
  const id = parseId(req.params['id'])
  if (id === null) return fail(res, 400, 'id must be a positive integer')

  try {
    const payrollGroup = await findPayrollGroupById(id)
    if (!payrollGroup) return fail(res, 404, `no payroll group with id ${id}`)

    const body: PayrollGroupResponse = { payrollGroup }
    res.json(body)
  } catch (err) {
    handleUnexpected(res, err)
  }
})

payrollGroupsRouter.post('/payroll-groups', canWritePayroll, async (req: Request, res: Response) => {
  const actor = actorOf(req)
  if (!actor) return fail(res, 500, 'server misconfigured')

  const parsed = parsePayrollGroupInput(req.body)
  if (!parsed.ok) return fail(res, 400, parsed.message)
  const input = parsed.value

  try {
    const payrollGroup = await withTransaction(async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO master_payroll_groups
           (group_code, group_name, cutoff_day, pay_day_rule, pay_day_of_month, is_active)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id`,
        [
          input.groupCode,
          input.groupName,
          input.cutoffDay,
          input.payDayRule,
          input.payDayOfMonth,
          input.isActive,
        ]
      )
      const created = rows[0]
      if (!created) throw new Error('insert into master_payroll_groups returned no id')

      await recordAudit(client, {
        actor,
        action: 'payroll_group.create',
        entityId: Number(created.id),
        detail: { groupCode: input.groupCode, cutoffDay: input.cutoffDay },
      })

      return { ...input, id: Number(created.id) }
    })

    const body: PayrollGroupResponse = { payrollGroup }
    res.status(201).json(body)
  } catch (err) {
    if (isUniqueViolation(err)) {
      return fail(res, 409, `group code "${input.groupCode}" is already taken`)
    }
    handleUnexpected(res, err)
  }
})

// PUT, not PATCH: the body is a complete group, matching every other master.
payrollGroupsRouter.put(
  '/payroll-groups/:id',
  canWritePayroll,
  async (req: Request, res: Response) => {
    const actor = actorOf(req)
    if (!actor) return fail(res, 500, 'server misconfigured')

    const id = parseId(req.params['id'])
    if (id === null) return fail(res, 400, 'id must be a positive integer')

    const parsed = parsePayrollGroupInput(req.body)
    if (!parsed.ok) return fail(res, 400, parsed.message)
    const input = parsed.value

    try {
      const updated = await withTransaction(async (client) => {
        const { rowCount } = await client.query(
          `UPDATE master_payroll_groups SET
             group_code = $2, group_name = $3, cutoff_day = $4, pay_day_rule = $5,
             pay_day_of_month = $6, is_active = $7, updated_at = now()
           WHERE id = $1`,
          [
            id,
            input.groupCode,
            input.groupName,
            input.cutoffDay,
            input.payDayRule,
            input.payDayOfMonth,
            input.isActive,
          ]
        )
        if (rowCount === 0) return false

        await recordAudit(client, {
          actor,
          action: 'payroll_group.update',
          entityId: id,
          detail: { groupCode: input.groupCode, cutoffDay: input.cutoffDay },
        })
        return true
      })

      if (!updated) return fail(res, 404, `no payroll group with id ${id}`)

      const body: PayrollGroupResponse = { payrollGroup: { ...input, id } }
      res.json(body)
    } catch (err) {
      if (isUniqueViolation(err)) {
        return fail(res, 409, `group code "${input.groupCode}" is already taken`)
      }
      handleUnexpected(res, err)
    }
  }
)
