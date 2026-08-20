// Turning a monthly employee's employment window and attendance into a basic
// wage, and a daily employee's late minutes into a deduction. Phase 2 only —
// OT (overtimeCalculation.ts already exists for that) and everything
// statutory are later phases.
//
// Pure. No database, no clock — same reasoning as payrollPeriod.ts and
// wageRate.ts: every payslip prices off this arithmetic, and two
// implementations of "how much does a partial month pay" would be two
// different answers to a question with legal consequences.

/** Labour Protection Act s.68's fixed divisor for a monthly wage — the same
 *  30 wageRate.ts's hourlyWage() divides by, and NOT the period window's own
 *  day count. A 26th-to-25th cycle runs 28, 30 or 31 days depending on the
 *  month; dividing by the window instead of by 30 would pay a full-month
 *  stayer correctly (window ÷ window is always 1) but would over- or
 *  under-pay everyone who joined or left mid-period, and under-pay them by
 *  6.7% in the 28-day March period specifically — see payroll_periods'
 *  migration comment. HR confirmed keeping 30 fixed.
 */
const MONTHLY_WAGE_DIVISOR = 30

/** Rounds to satang, matching money() in overtimeReportQueries.ts and
 *  computeTotalDays' rounding in leaveRequestQueries.ts. Every amount crosses
 *  into a payroll_entry_lines row already rounded, so nothing downstream can
 *  disagree in the third decimal place. */
export function round2(value: number): number {
  return Math.round(value * 100) / 100
}

/** Inclusive calendar-day count of the overlap between a period's window and
 *  an employment's [start, end] — 'YYYY-MM-DD' throughout. `employmentEnd`
 *  null means still employed. Returns 0 when the two ranges do not overlap at
 *  all (should not happen for anyone payroll actually queries, but a pure
 *  function does not get to assume its caller filtered correctly). */
export function employedDayCount(
  periodStart: string,
  periodEnd: string,
  employmentStart: string,
  employmentEnd: string | null
): number {
  const start = periodStart > employmentStart ? periodStart : employmentStart
  const end = employmentEnd === null || periodEnd < employmentEnd ? periodEnd : employmentEnd
  if (end < start) return 0

  const startMs = Date.parse(`${start}T00:00:00Z`)
  const endMs = Date.parse(`${end}T00:00:00Z`)
  return Math.round((endMs - startMs) / 86_400_000) + 1
}

/** Whether an employment covers the entire period window — the test that
 *  decides whether monthlyGrossWage takes the "full wage" branch or the
 *  "prorate by 30" branch. */
export function isFullPeriodEmployment(
  periodStart: string,
  periodEnd: string,
  employmentStart: string,
  employmentEnd: string | null
): boolean {
  return employmentStart <= periodStart && (employmentEnd === null || employmentEnd >= periodEnd)
}

/**
 * A monthly employee's basic wage before any deduction.
 *
 * A full-period stayer is paid the wage exactly, regardless of whether the
 * window they stayed for was 28, 30 or 31 days — that is the entire point of
 * pricing a monthly wage by the month rather than by the day. Only someone
 * who joined or left mid-period is prorated, by `wageAmount / 30 *
 * employedDays`, capped at `wageAmount` so a rounding edge (or a caller
 * passing a bad employedDays) can never pay more than a full month.
 */
export function monthlyGrossWage(
  wageAmount: number,
  isFullPeriod: boolean,
  employedDays: number
): number {
  if (isFullPeriod) return round2(wageAmount)
  const prorated = (wageAmount / MONTHLY_WAGE_DIVISOR) * employedDays
  return round2(Math.min(wageAmount, Math.max(0, prorated)))
}

/** A monthly employee's absence deduction: `wageAmount / 30 * unpaidDays`,
 *  where unpaidDays is absences plus unpaid-leave days — HR's rule that the
 *  two are deducted identically. Same fixed-30 divisor as monthlyGrossWage,
 *  for the same reason, and applied on top of it rather than folded in: a
 *  full-period stayer who was absent two days is priced as (full wage) minus
 *  (2/30 of it), not as a single combined fraction. */
export function monthlyAbsenceDeduction(wageAmount: number, unpaidDays: number): number {
  if (unpaidDays <= 0) return 0
  return round2((wageAmount / MONTHLY_WAGE_DIVISOR) * unpaidDays)
}

/**
 * What a late-arrival or early-departure deduction is worth, given the
 * minutes already past grace and the hourly wage those minutes are priced
 * at.
 *
 * `minutesPastGrace` must already be `max(0, actualMinutes - graceMinutes)`
 * — computing that clamp is the caller's job, against the
 * late_grace_minutes/early_leave_grace_minutes snapshotted onto
 * attendance_daily at compute time (054_add_grace_snapshot_to_attendance_daily.sql),
 * not against master_shifts' current value, which can have changed since.
 *
 * `hourlyWage` is resolved by wageRate.ts's hourlyWage() — never
 * recalculated here. Returns 0 rather than null for a zero or negative input,
 * since "no deduction" and "an unpriceable deduction" are different things a
 * caller with a null hourlyWage must decide between before calling this.
 */
export function lateOrEarlyDeductionAmount(minutesPastGrace: number, hourlyWage: number): number {
  if (minutesPastGrace <= 0 || hourlyWage <= 0) return 0
  return round2((minutesPastGrace / 60) * hourlyWage)
}
