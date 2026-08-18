// The admin overtime report. Read-only and admin-only: there is no employee
// arm here, because an employee already sees their own requests through
// GET /overtime-requests/me and has no business reading anyone else's hours
// or anyone's wages.

import { Router } from 'express'
import type { Request, Response } from 'express'
import { ROLES, type OvertimeReportResponse } from '@hrm/shared'
import { requireRole } from '../auth/middleware.js'
import { fail, handleUnexpected } from '../http.js'
import { buildOvertimeReport } from '../overtimeReportQueries.js'

export const overtimeReportRouter = Router()

const canReadAdmin = requireRole(...ROLES)

function isCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  return !Number.isNaN(new Date(`${value}T00:00:00Z`).getTime())
}

function parsePositiveInt(value: unknown): number | null | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') return null
  const n = Number(value)
  return Number.isInteger(n) && n > 0 ? n : null
}

/** A year at a time, so one mistyped date cannot ask for every row in the
 *  table. Payroll periods are months; nobody legitimately reports on more
 *  than a year in one go. */
const MAX_RANGE_DAYS = 366

overtimeReportRouter.get('/overtime-report', canReadAdmin, async (req: Request, res: Response) => {
  const fromDate = req.query['from']
  const toDate = req.query['to']

  if (!isCalendarDate(fromDate)) return fail(res, 400, 'from is required and must be YYYY-MM-DD')
  if (!isCalendarDate(toDate)) return fail(res, 400, 'to is required and must be YYYY-MM-DD')
  if (fromDate > toDate) return fail(res, 400, `from (${fromDate}) must not be after to (${toDate})`)

  const days =
    (Date.parse(`${toDate}T00:00:00Z`) - Date.parse(`${fromDate}T00:00:00Z`)) / 86_400_000 + 1
  if (days > MAX_RANGE_DAYS) {
    return fail(res, 400, `ช่วงวันที่ต้องไม่เกิน ${MAX_RANGE_DAYS} วัน`)
  }

  const employeeId = parsePositiveInt(req.query['employeeId'])
  if (employeeId === null) return fail(res, 400, 'employeeId must be a positive integer')

  const departmentId = parsePositiveInt(req.query['departmentId'])
  if (departmentId === null) return fail(res, 400, 'departmentId must be a positive integer')

  try {
    const report = await buildOvertimeReport({
      fromDate,
      toDate,
      ...(employeeId !== undefined ? { employeeId } : {}),
      ...(departmentId !== undefined ? { departmentId } : {}),
    })
    const body: OvertimeReportResponse = report
    res.json(body)
  } catch (err) {
    handleUnexpected(res, err)
  }
})
