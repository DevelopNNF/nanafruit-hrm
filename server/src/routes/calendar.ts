import { Router } from 'express'
import type { Request, Response } from 'express'
import type { MonthCalendarResponse } from '@hrm/shared'
import { fail, handleUnexpected } from '../http.js'
import { buildMonthCalendar } from '../calendarQueries.js'

export const calendarRouter = Router()

// Same shape as attendance's /me: an employee's own calendar only — an
// admin token has no employeeId to look up a calendar for.
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

calendarRouter.get('/calendar/me', async (req: Request, res: Response) => {
  const employeeId = requireEmployeeId(req, res)
  if (employeeId === null) return

  const year = parseYear(req.query['year'])
  if (year === null) return fail(res, 400, 'year must be a 4-digit number')

  const month = parseMonth(req.query['month'])
  if (month === null) return fail(res, 400, 'month must be a number between 1 and 12')

  try {
    const days = await buildMonthCalendar(employeeId, year, month)
    const body: MonthCalendarResponse = { days }
    res.json(body)
  } catch (err) {
    handleUnexpected(res, err)
  }
})
