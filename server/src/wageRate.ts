// Turning what an employee is paid into what one hour of their ordinary work
// is worth.
//
// Its own module, small as it is, because overtime is not the only thing that
// will need it: any future payroll — deductions, unpaid leave, a payslip —
// prices off the same hourly figure, and two implementations of it would be
// two subtly different answers to "what is this person paid per hour", which
// is not a question a company can have two answers to.
//
// Pure. No database, no clock.

import type { WageType } from '@hrm/shared'

/**
 * An employee's wage for one hour of ordinary work, or null when it cannot be
 * derived.
 *
 * Labour Protection Act s.68: overtime is priced off the hourly wage, and for
 * a monthly-paid employee the daily wage is the monthly wage divided by 30 —
 * always 30, regardless of how many days that month has or how many of them
 * were worked. A daily-paid employee already has a daily wage, so only the
 * second division applies to them. Dividing a monthly salary straight by the
 * hours in a month is the classic way to underpay OT, which is why the two
 * cases are separate branches rather than one clever expression.
 *
 * shiftWorkMinutes is that employee's own normal working day net of the
 * unpaid break, taken from the shift in force on the date in question — not a
 * company-wide constant, since a 7.5-hour shift earns a higher hourly rate on
 * the same salary than an 8-hour one does.
 *
 * Returns null rather than dividing by zero or guessing when the shift is
 * missing or the wage is unset. Callers render that as "—": an employee whose
 * finance tab was never filled in has an unanswered question, not a wage of
 * nothing.
 */
export function hourlyWage(input: {
  wageType: WageType
  wageAmount: number
  shiftWorkMinutes: number | null
}): number | null {
  const { wageType, wageAmount, shiftWorkMinutes } = input
  if (shiftWorkMinutes === null || shiftWorkMinutes <= 0) return null
  if (wageAmount <= 0) return null

  const dailyWage = wageType === 'monthly' ? wageAmount / 30 : wageAmount
  return dailyWage / (shiftWorkMinutes / 60)
}
