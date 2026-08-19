// Turning a period code into the window of days it covers, and saying which
// status changes are allowed.
//
// Pure. No database, no clock — the same reasoning as wageRate.ts: every phase
// after this one prices against these dates, and two implementations of "when
// does the August period start" would be two different Augusts.

import type { PayDayRule, PayrollPeriodStatus } from '@hrm/shared'

/** The parts of a payroll group this module needs. Deliberately not the whole
 *  PayrollGroup: nothing here should be able to depend on is_active or a name. */
export type PeriodCycle = {
  cutoffDay: number
  payDayRule: PayDayRule
  payDayOfMonth: number | null
}

export type PeriodWindow = {
  /** Both inclusive, 'YYYY-MM-DD'. */
  periodStart: string
  periodEnd: string
  payDate: string
}

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

function iso(year: number, month: number, day: number): string {
  return `${year}-${pad2(month)}-${pad2(day)}`
}

/** Days in a calendar month. `month` is 1-12, not the 0-11 Date uses.
 *  Day 0 of the next month is the last day of this one, and it handles
 *  February in a leap year without a special case. */
export function lastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

/** 'YYYY-MM' -> its parts, or null when it is not that. Rejects month 00 and
 *  13 as well as the wrong shape, so a caller that gets a value back can build
 *  a date from it without checking again. */
export function parsePeriodCode(periodCode: string): { year: number; month: number } | null {
  const match = /^(\d{4})-(\d{2})$/.exec(periodCode)
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  if (month < 1 || month > 12) return null
  return { year, month }
}

/**
 * The window the period identified by `periodCode` covers, on `cycle`.
 *
 * The period code is the month the salary is FOR, and the window ends on that
 * month's cut-off day: '2026-08' with cutoffDay 25 runs 2026-07-26 to
 * 2026-08-25. Both ends inclusive, matching the daterange('[]') the table
 * excludes overlaps on.
 *
 * The window is NOT a fixed length. On a 26th-to-25th cycle 2026 has seven
 * 31-day periods, four 30-day ones, and a 28-day period in March — which is
 * why every later phase must count days from these dates rather than assume
 * 30. (Thirty is still the divisor the Labour Protection Act s.68 uses for a
 * monthly wage; that is a separate constant that happens to share a value with
 * some window lengths, and conflating the two is how a full month of work gets
 * paid 28/30 of a salary.)
 *
 * Returns null only when the period code is malformed; every valid code has a
 * window, because cutoffDay is capped at 28 by the table's CHECK and therefore
 * exists in every month.
 */
export function derivePeriodWindow(periodCode: string, cycle: PeriodCycle): PeriodWindow | null {
  const parsed = parsePeriodCode(periodCode)
  if (parsed === null) return null
  const { year, month } = parsed

  const periodEnd = iso(year, month, cycle.cutoffDay)

  // The day after the previous month's cut-off. Rolling the month back by one
  // through Date rather than by hand is what makes January work: period
  // '2026-01' starts in December 2025.
  const startDate = new Date(Date.UTC(year, month - 2, cycle.cutoffDay + 1))
  const periodStart = iso(
    startDate.getUTCFullYear(),
    startDate.getUTCMonth() + 1,
    startDate.getUTCDate()
  )

  // cutoffDay + 1 can be the 29th of a short February, which Date.UTC rolls
  // forward into March — correct here, since "the day after the 28th" is
  // exactly what a cut-off of 28 means, and the resulting window still starts
  // the day after the previous period ended.

  const monthLength = lastDayOfMonth(year, month)
  const requestedPayDay =
    cycle.payDayRule === 'fixed_day' ? (cycle.payDayOfMonth ?? monthLength) : monthLength

  // Two clamps, both of which stop a group's configuration from producing a
  // date the table would reject with a 500 at period-creation time:
  //   * a fixed pay day of 31 does not exist in February,
  //   * a fixed pay day before the cut-off would pay before the period ends,
  //     which pay_date >= period_end forbids.
  const payDay = Math.min(Math.max(requestedPayDay, cycle.cutoffDay), monthLength)
  const payDate = iso(year, month, payDay)

  return { periodStart, periodEnd, payDate }
}

/** Inclusive day count of a window — 26 Jul to 25 Aug is 31, not 30. */
export function windowDayCount(window: PeriodWindow): number {
  const start = Date.parse(`${window.periodStart}T00:00:00Z`)
  const end = Date.parse(`${window.periodEnd}T00:00:00Z`)
  return Math.round((end - start) / 86_400_000) + 1
}

/**
 * Which status a period may move to from where.
 *
 * Only 'draft' has an outgoing edge that Phase 1 can actually take (to
 * 'voided'); the rest are here because the lifecycle is one table rather than
 * a rule scattered across the routes that will implement each step.
 *
 * 'voided' is reachable from everything up to and including 'approved' —
 * abandoning a run before anyone has been paid is a normal correction. It is
 * NOT reachable from 'paid' or 'closed': money has left the company by then,
 * and the fix for a wrong payment is another payment, recorded, not a period
 * that quietly stops existing.
 */
const TRANSITIONS: Record<PayrollPeriodStatus, readonly PayrollPeriodStatus[]> = {
  draft: ['calculating', 'voided'],
  calculating: ['review', 'draft', 'voided'],
  review: ['approved', 'draft', 'voided'],
  approved: ['paid', 'review', 'voided'],
  paid: ['closed'],
  closed: [],
  voided: [],
}

export function canTransition(from: PayrollPeriodStatus, to: PayrollPeriodStatus): boolean {
  return TRANSITIONS[from].includes(to)
}

/** The statuses a period's dates may still be edited in. Anything past draft
 *  has figures calculated against the window, so moving it silently would
 *  leave those figures describing days the period no longer covers. */
export function isEditableStatus(status: PayrollPeriodStatus): boolean {
  return status === 'draft'
}
