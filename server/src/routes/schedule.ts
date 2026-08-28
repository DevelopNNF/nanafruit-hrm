import { Router } from 'express'
import type { Request, Response } from 'express'
import { ROLES, type WorkScheduleResponse } from '@hrm/shared'
import { requireRole } from '../auth/middleware.js'
import { fail, handleUnexpected, parseOptionalPositiveInt } from '../http.js'
import { buildMonthScheduleForAllEmployees } from '../scheduleQueries.js'

export const scheduleRouter = Router()

// Same read split as attendance/shifts/jobs: any HRM role may view the grid —
// there is no write route here at all, the grid is read-only.
const canReadAdmin = requireRole(...ROLES)

function parseYear(value: unknown): number | null {
  if (typeof value !== 'string' || !/^\d{4}$/.test(value)) return null
  const year = Number(value)
  return year >= 2000 && year <= 2100 ? year : null
}

function parseMonth(value: unknown): number | null {
  if (typeof value !== 'string' || !/^\d{1,2}$/.test(value)) return null
  const month = Number(value)
  return month >= 1 && month <= 12 ? month : null
}

scheduleRouter.get('/schedule', canReadAdmin, async (req: Request, res: Response) => {
  const year = parseYear(req.query['year'])
  if (year === null) return fail(res, 400, 'year must be a 4-digit number')

  const month = parseMonth(req.query['month'])
  if (month === null) return fail(res, 400, 'month must be a number between 1 and 12')

  const page = parseOptionalPositiveInt(req.query['page'])
  if (page === undefined) return fail(res, 400, 'page must be a positive integer')

  const pageSize = parseOptionalPositiveInt(req.query['pageSize'])
  if (pageSize === undefined) return fail(res, 400, 'pageSize must be a positive integer')

  try {
    const result = await buildMonthScheduleForAllEmployees(year, month, {
      ...(page !== null && { page }),
      ...(pageSize !== null && { pageSize }),
    })
    const body: WorkScheduleResponse = { year, month, ...result }
    res.json(body)
  } catch (err) {
    handleUnexpected(res, err)
  }
})
