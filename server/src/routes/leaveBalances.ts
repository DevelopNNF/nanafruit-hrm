import { Router } from 'express'
import type { Request, Response } from 'express'
import {
  LEAVE_BALANCE_ENTRY_TYPES,
  ROLES,
  type AuthUser,
  type BulkGrantLeaveResponse,
  type LeaveBalanceEntryInput,
  type LeaveBalanceEntryListResponse,
  type LeaveBalanceEntryResponse,
  type LeaveBalanceEntryType,
  type LeaveBalanceSummaryListResponse,
} from '@hrm/shared'
import { pool, withTransaction } from '../db.js'
import { requireRole } from '../auth/middleware.js'
import { recordAudit } from '../audit.js'
import { fail, handleUnexpected } from '../http.js'
import { findEmployeeById } from '../employeeQueries.js'
import { findLeaveTypeById } from '../leaveTypeQueries.js'
import {
  listLeaveBalanceEntries,
  listLeaveBalanceSummaries,
  rowToLeaveBalanceEntry,
  type LeaveBalanceEntryRow,
} from '../leaveBalanceQueries.js'

export const leaveBalancesRouter = Router()

// Same split as every other master/employee resource: any HRM role can look
// at a balance, only HR and Admin can grant, adjust, or bulk-grant.
const canRead = requireRole(...ROLES)
const canWrite = requireRole('HRM.HR', 'HRM.Admin')

function actorOf(req: Request): AuthUser | null {
  return req.auth ?? null
}

/** GET /leave-balances/me is for the employee arm of AuthUser only — an
 *  admin token has no employeeId of its own, same reasoning as
 *  timeCorrections.ts's requireEmployeeId. */
function requireEmployeeId(req: Request, res: Response): number | null {
  const auth = req.auth
  if (!auth) {
    fail(res, 500, 'server misconfigured')
    return null
  }
  if (auth.kind !== 'employee') {
    fail(res, 403, 'this endpoint is for employee accounts', 'FORBIDDEN')
    return null
  }
  return auth.employeeId
}

type ParseResult<T> = { ok: true; value: T } | { ok: false; message: string }

function parseId(value: string | string[] | undefined): number | null {
  if (typeof value !== 'string') return null
  const id = Number(value)
  return Number.isInteger(id) && id > 0 ? id : null
}

/** Years are always passed explicitly (query or body) — no "current year"
 *  default, so a stale client clock never silently reads the wrong year. */
function parseYear(value: unknown): number | null {
  if (typeof value === 'string') {
    const year = Number(value)
    return Number.isInteger(year) && year >= 2000 && year <= 2100 ? year : null
  }
  if (typeof value === 'number' && Number.isInteger(value) && value >= 2000 && value <= 2100) {
    return value
  }
  return null
}

const ENTRY_TYPES_CREATABLE_BY_HAND = LEAVE_BALANCE_ENTRY_TYPES.filter(
  (type) => type !== 'usage'
) as readonly Exclude<LeaveBalanceEntryType, 'usage'>[]

function parseLeaveBalanceEntryInput(body: unknown): ParseResult<LeaveBalanceEntryInput> {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, message: 'body must be a JSON object' }
  }
  const raw = body as Record<string, unknown>

  const leaveTypeId = raw['leaveTypeId']
  if (typeof leaveTypeId !== 'number' || !Number.isInteger(leaveTypeId) || leaveTypeId <= 0) {
    return { ok: false, message: 'leaveTypeId is required and must be a positive integer' }
  }

  const year = parseYear(raw['year'])
  if (year === null) return { ok: false, message: 'year is required and must be an integer year' }

  const entryTypeRaw = raw['entryType']
  if (
    typeof entryTypeRaw !== 'string' ||
    !(ENTRY_TYPES_CREATABLE_BY_HAND as readonly string[]).includes(entryTypeRaw)
  ) {
    return {
      ok: false,
      message: `entryType must be one of: ${ENTRY_TYPES_CREATABLE_BY_HAND.join(', ')}`,
    }
  }
  const entryType = entryTypeRaw as LeaveBalanceEntryInput['entryType']

  const amountDaysRaw = raw['amountDays']
  if (typeof amountDaysRaw !== 'number' || !Number.isFinite(amountDaysRaw) || amountDaysRaw === 0) {
    return { ok: false, message: 'amountDays is required and must be a non-zero number' }
  }
  // Mirrors leave_balance_entries_amount_sign — checked here too so the
  // caller gets a clear message instead of a raw constraint-violation error.
  if (entryType !== 'adjustment' && amountDaysRaw <= 0) {
    return { ok: false, message: `amountDays must be positive for entryType "${entryType}"` }
  }

  const reasonRaw = raw['reason']
  const reason = typeof reasonRaw === 'string' && reasonRaw.trim() !== '' ? reasonRaw.trim() : null
  if (entryType === 'adjustment' && reason === null) {
    return { ok: false, message: 'reason is required when entryType is "adjustment"' }
  }

  return { ok: true, value: { leaveTypeId, year, entryType, amountDays: amountDaysRaw, reason } }
}

function isForeignKeyViolation(err: unknown): boolean {
  return (
    typeof err === 'object' && err !== null && (err as { code?: unknown }).code === '23503'
  )
}

/** The liff gauge's data source — this employee's own balance, across every
 *  active leave type, for the year they're currently requesting leave in. */
leaveBalancesRouter.get('/leave-balances/me', async (req: Request, res: Response) => {
  const employeeId = requireEmployeeId(req, res)
  if (employeeId === null) return

  const year = parseYear(req.query['year'])
  if (year === null) return fail(res, 400, 'year query parameter is required')

  try {
    const summaries = await listLeaveBalanceSummaries(employeeId, year)
    const body: LeaveBalanceSummaryListResponse = { summaries }
    res.json(body)
  } catch (err) {
    handleUnexpected(res, err)
  }
})

leaveBalancesRouter.get(
  '/employees/:employeeId/leave-balances',
  canRead,
  async (req: Request, res: Response) => {
    const employeeId = parseId(req.params['employeeId'])
    if (employeeId === null) return fail(res, 400, 'employeeId must be a positive integer')

    const year = parseYear(req.query['year'])
    if (year === null) return fail(res, 400, 'year query parameter is required')

    try {
      const employee = await findEmployeeById(employeeId)
      if (!employee) return fail(res, 404, `no employee with id ${employeeId}`)

      const summaries = await listLeaveBalanceSummaries(employeeId, year)
      const body: LeaveBalanceSummaryListResponse = { summaries }
      res.json(body)
    } catch (err) {
      handleUnexpected(res, err)
    }
  }
)

leaveBalancesRouter.get(
  '/employees/:employeeId/leave-balances/entries',
  canRead,
  async (req: Request, res: Response) => {
    const employeeId = parseId(req.params['employeeId'])
    if (employeeId === null) return fail(res, 400, 'employeeId must be a positive integer')

    const year = parseYear(req.query['year'])
    if (year === null) return fail(res, 400, 'year query parameter is required')

    try {
      const employee = await findEmployeeById(employeeId)
      if (!employee) return fail(res, 404, `no employee with id ${employeeId}`)

      const entries = await listLeaveBalanceEntries(employeeId, year)
      const body: LeaveBalanceEntryListResponse = { entries }
      res.json(body)
    } catch (err) {
      handleUnexpected(res, err)
    }
  }
)

leaveBalancesRouter.post(
  '/employees/:employeeId/leave-balances/entries',
  canWrite,
  async (req: Request, res: Response) => {
    const actor = actorOf(req)
    if (!actor || actor.kind !== 'admin') return fail(res, 500, 'server misconfigured')

    const employeeId = parseId(req.params['employeeId'])
    if (employeeId === null) return fail(res, 400, 'employeeId must be a positive integer')

    const parsed = parseLeaveBalanceEntryInput(req.body)
    if (!parsed.ok) return fail(res, 400, parsed.message)
    const input = parsed.value

    try {
      const employee = await findEmployeeById(employeeId)
      if (!employee) return fail(res, 404, `no employee with id ${employeeId}`)

      const leaveType = await findLeaveTypeById(input.leaveTypeId)
      if (!leaveType) return fail(res, 400, `no leave type with id ${input.leaveTypeId}`)

      const entry = await withTransaction(async (client) => {
        const { rows } = await client.query<LeaveBalanceEntryRow>(
          `INSERT INTO leave_balance_entries
             (employee_id, leave_type_id, year, entry_type, amount_days, reason,
              created_by_oid, created_by_name)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           RETURNING id, employee_id, leave_type_id, year, entry_type, amount_days,
                     reason, created_by_name, created_at`,
          [
            employeeId,
            input.leaveTypeId,
            input.year,
            input.entryType,
            input.amountDays,
            input.reason,
            actor.oid,
            actor.name,
          ]
        )
        const row = rows[0]
        if (!row) throw new Error('insert into leave_balance_entries returned no row')
        const created = rowToLeaveBalanceEntry(row)

        await recordAudit(client, {
          actor,
          action: input.entryType === 'adjustment' ? 'leave_balance.adjust' : 'leave_balance.grant',
          entityId: created.id,
          detail: {
            employeeId,
            leaveTypeId: input.leaveTypeId,
            year: input.year,
            entryType: input.entryType,
            amountDays: input.amountDays,
          },
        })

        return created
      })

      const body: LeaveBalanceEntryResponse = { entry }
      res.status(201).json(body)
    } catch (err) {
      if (isForeignKeyViolation(err)) return fail(res, 400, 'invalid reference in entry')
      handleUnexpected(res, err)
    }
  }
)

leaveBalancesRouter.post('/leave-balances/bulk-grant', canWrite, async (req: Request, res: Response) => {
  const actor = actorOf(req)
  if (!actor || actor.kind !== 'admin') return fail(res, 500, 'server misconfigured')

  const body = req.body as { year?: unknown; leaveTypeId?: unknown } | null
  const year = parseYear(body?.year)
  if (year === null) return fail(res, 400, 'year is required and must be an integer year')

  const leaveTypeIdRaw = body?.leaveTypeId
  if (typeof leaveTypeIdRaw !== 'number' || !Number.isInteger(leaveTypeIdRaw) || leaveTypeIdRaw <= 0) {
    return fail(res, 400, 'leaveTypeId is required and must be a positive integer')
  }

  try {
    const leaveType = await findLeaveTypeById(leaveTypeIdRaw)
    if (!leaveType) return fail(res, 400, `no leave type with id ${leaveTypeIdRaw}`)
    if (leaveType.defaultDaysPerYear === null) {
      return fail(
        res,
        400,
        `leave type "${leaveType.leaveName}" has no defaultDaysPerYear configured — set one before bulk-granting`
      )
    }

    const result = await withTransaction(async (client) => {
      const { rows: countRows } = await client.query<{ count: string }>(
        `SELECT count(*) AS count FROM employment_details WHERE status = 'Active'`
      )
      const totalActive = Number(countRows[0]?.count ?? 0)

      // NOT EXISTS rather than ON CONFLICT: there is no unique constraint on
      // (employee_id, leave_type_id, year, entry_type) — a ledger allows more
      // than one 'grant' in principle (e.g. a correction later), but bulk-grant
      // itself should be safe to re-run without doubling everyone up.
      const { rows: insertedRows } = await client.query<{ employee_id: string }>(
        `INSERT INTO leave_balance_entries
           (employee_id, leave_type_id, year, entry_type, amount_days,
            created_by_oid, created_by_name)
         SELECT e.id, $1, $2, 'grant', $3, $4, $5
         FROM employees e
         JOIN employment_details d ON d.employee_id = e.id
         WHERE d.status = 'Active'
           AND NOT EXISTS (
             SELECT 1 FROM leave_balance_entries lbe
             WHERE lbe.employee_id = e.id
               AND lbe.leave_type_id = $1
               AND lbe.year = $2
               AND lbe.entry_type = 'grant'
           )
         RETURNING employee_id`,
        [leaveTypeIdRaw, year, leaveType.defaultDaysPerYear, actor.oid, actor.name]
      )
      const grantedCount = insertedRows.length

      await recordAudit(client, {
        actor,
        action: 'leave_balance.bulk_grant',
        entityId: leaveTypeIdRaw,
        detail: { year, grantedCount, skippedCount: totalActive - grantedCount },
      })

      return { grantedCount, skippedCount: totalActive - grantedCount }
    })

    const responseBody: BulkGrantLeaveResponse = result
    res.status(201).json(responseBody)
  } catch (err) {
    handleUnexpected(res, err)
  }
})
