import { Router } from 'express'
import type { Request, Response } from 'express'
import {
  ROLES,
  type AuthUser,
  type PayrollEntryListResponse,
  type PayrollEntryResponse,
  type PayrollSlipListResponse,
  type PayrollSlipSummary,
} from '@hrm/shared'
import { pool, withTransaction } from '../db.js'
import { requireRole } from '../auth/middleware.js'
import { fail, handleUnexpected } from '../http.js'
import { recordAudit } from '../audit.js'
import {
  findPayrollEntryById,
  listPayrollEntriesForPeriod,
  setEntryReviewed,
} from '../payrollEntryQueries.js'
import { findMyVisibleEntryId, findPayslipData, listMyPayrollSlips } from '../payslipData.js'
import { renderPayslipPdf } from '../payslipPdf.js'

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

/** /payroll-entries/me and its /pdf sibling are for the employee arm of
 *  AuthUser only — same shape as requireEmployeeId in routes/attendance.ts,
 *  duplicated locally rather than shared, matching how this codebase treats
 *  small route-guard helpers. No requireRole wrapper on those two routes:
 *  this check is the whole gate, the same way /attendance/me has none either. */
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

/** Who to print as the document's creator — an admin's own display name, or
 *  (for the employee self-service route) the slip owner's own name, since
 *  that route can only ever generate the caller's own slip. */
function generatedByLabel(actor: AuthUser, data: { entry: { employeeName: string } }): string {
  return actor.kind === 'admin' ? actor.name : data.entry.employeeName
}

async function sendPayslipPdf(
  res: Response,
  actor: AuthUser,
  entryId: number
): Promise<void> {
  const data = await findPayslipData(entryId)
  if (!data) {
    fail(res, 404, `no payroll entry with id ${entryId}`)
    return
  }

  const pdf = await renderPayslipPdf(data, generatedByLabel(actor, data))
  await recordAudit(pool, {
    actor,
    action: 'payroll_entry.download_pdf',
    entityId: entryId,
    detail: { periodCode: data.periodCode },
  })

  res.setHeader('Content-Type', 'application/pdf')
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="payslip-${data.entry.employeeCode}-${data.periodCode}.pdf"`
  )
  res.send(pdf)
}

// Declared before '/payroll-entries/:id' on purpose, same reasoning as
// payrollPeriods.ts's '/preview' route — otherwise Express reads "me" as an
// :id value here.
payrollEntriesRouter.get('/payroll-entries/me', async (req: Request, res: Response) => {
  const employeeId = requireEmployeeId(req, res)
  if (employeeId === null) return

  try {
    const rows = await listMyPayrollSlips(employeeId)
    const slips: PayrollSlipSummary[] = rows.map((row) => ({
      entryId: Number(row.entry_id),
      payrollPeriodId: Number(row.payroll_period_id),
      periodCode: row.period_code,
      payDate: row.pay_date,
      netPay: Number(row.net_pay),
    }))
    const body: PayrollSlipListResponse = { slips }
    res.json(body)
  } catch (err) {
    handleUnexpected(res, err)
  }
})

payrollEntriesRouter.get(
  '/payroll-entries/me/:periodId/pdf',
  async (req: Request, res: Response) => {
    const actor = actorOf(req)
    if (!actor) return fail(res, 500, 'server misconfigured')

    const employeeId = requireEmployeeId(req, res)
    if (employeeId === null) return

    const periodId = parseId(req.params['periodId'])
    if (periodId === null) return fail(res, 400, 'periodId must be a positive integer')

    try {
      // Same 404 whether the entry doesn't exist or the period isn't visible
      // to employees yet — the caller must not be able to tell which.
      const entryId = await findMyVisibleEntryId(employeeId, periodId)
      if (entryId === null) return fail(res, 404, `no payslip for period ${periodId}`)

      await sendPayslipPdf(res, actor, entryId)
    } catch (err) {
      handleUnexpected(res, err)
    }
  }
)

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

// HR/payroll may preview or archive a slip at any status — unlike the
// employee-facing route above, there is no visibility gate here, since this
// is exactly the tool someone would use to check a slip before approving it.
payrollEntriesRouter.get(
  '/payroll-entries/:id/pdf',
  canRead,
  async (req: Request, res: Response) => {
    const actor = actorOf(req)
    if (!actor) return fail(res, 500, 'server misconfigured')

    const id = parseId(req.params['id'])
    if (id === null) return fail(res, 400, 'id must be a positive integer')

    try {
      await sendPayslipPdf(res, actor, id)
    } catch (err) {
      handleUnexpected(res, err)
    }
  }
)

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
