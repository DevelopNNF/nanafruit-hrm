import { Router } from 'express'
import type { Request, Response } from 'express'
import { ROLES, type PayrollEntryListResponse, type PayrollEntryResponse } from '@hrm/shared'
import { requireRole } from '../auth/middleware.js'
import { fail, handleUnexpected } from '../http.js'
import { findPayrollEntryById, listPayrollEntriesForPeriod } from '../payrollEntryQueries.js'

export const payrollEntriesRouter = Router()

// Read-only for now: an entry is written exclusively by
// POST /payroll-periods/:id/calculate. Same read/write split as
// payrollPeriods.ts — any HRM role may look at a payslip, only payroll
// produces one.
const canRead = requireRole(...ROLES)

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
