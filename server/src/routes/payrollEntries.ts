import { Router } from 'express'
import type { Request, Response } from 'express'
import {
  ROLES,
  type AuthUser,
  type PayrollEntryListResponse,
  type PayrollEntryResponse,
} from '@hrm/shared'
import { withTransaction } from '../db.js'
import { requireRole } from '../auth/middleware.js'
import { fail, handleUnexpected } from '../http.js'
import {
  findPayrollEntryById,
  listPayrollEntriesForPeriod,
  setEntryReviewed,
} from '../payrollEntryQueries.js'

export const payrollEntriesRouter = Router()

// Every figure on an entry is still written exclusively by
// POST /payroll-periods/:id/calculate — reviewed_at is the one field this
// router can change directly, since marking a payslip looked-at isn't
// correcting a figure. Same read/write split as payrollPeriods.ts — any HRM
// role may look at a payslip, only payroll marks one reviewed.
const canRead = requireRole(...ROLES)
const canWritePayroll = requireRole('HRM.Payroll', 'HRM.Admin')

function actorOf(req: Request): AuthUser | null {
  return req.auth ?? null
}

function parseId(value: string | string[] | undefined): number | null {
  if (typeof value !== 'string') return null
  const id = Number(value)
  return Number.isInteger(id) && id > 0 ? id : null
}

payrollEntriesRouter.get(
  '/payroll-periods/:id/entries',
  canRead,
  async (req: Request, res: Response) => {
    const periodId = parseId(req.params['id'])
    if (periodId === null) return fail(res, 400, 'id must be a positive integer')

    try {
      const payrollEntries = await listPayrollEntriesForPeriod(periodId)
      const body: PayrollEntryListResponse = { payrollEntries }
      res.json(body)
    } catch (err) {
      handleUnexpected(res, err)
    }
  }
)

payrollEntriesRouter.get('/payroll-entries/:id', canRead, async (req: Request, res: Response) => {
  const id = parseId(req.params['id'])
  if (id === null) return fail(res, 400, 'id must be a positive integer')

  try {
    const payrollEntry = await findPayrollEntryById(id)
    if (!payrollEntry) return fail(res, 404, `no payroll entry with id ${id}`)

    const body: PayrollEntryResponse = { payrollEntry }
    res.json(body)
  } catch (err) {
    handleUnexpected(res, err)
  }
})

// The one write this router has: HR confirming they looked at this payslip,
// ahead of approving the period it belongs to. Only legal while that period
// is 'review' — enforced inside setEntryReviewed, not here, since it needs
// the same row lock as the write.
payrollEntriesRouter.patch(
  '/payroll-entries/:id/review',
  canWritePayroll,
  async (req: Request, res: Response) => {
    const actor = actorOf(req)
    if (!actor) return fail(res, 500, 'server misconfigured')

    const id = parseId(req.params['id'])
    if (id === null) return fail(res, 400, 'id must be a positive integer')

    if (
      typeof req.body !== 'object' ||
      req.body === null ||
      typeof (req.body as Record<string, unknown>)['reviewed'] !== 'boolean'
    ) {
      return fail(res, 400, 'reviewed must be a boolean')
    }
    const reviewed = (req.body as { reviewed: boolean }).reviewed

    try {
      const result = await withTransaction((client) => setEntryReviewed(id, reviewed, actor, client))

      if (result.kind === 'not_found') return fail(res, 404, `no payroll entry with id ${id}`)
      if (result.kind === 'conflict') return fail(res, 409, result.message)

      const payrollEntry = await findPayrollEntryById(id)
      if (!payrollEntry) throw new Error('payroll entry vanished after its own review update')

      const body: PayrollEntryResponse = { payrollEntry }
      res.json(body)
    } catch (err) {
      handleUnexpected(res, err)
    }
  }
)
