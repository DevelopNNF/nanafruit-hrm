// Turning approved overtime plus what was actually punched into the two
// minute buckets attendance_daily stores, and those buckets into money.
//
// Same split as computeAttendanceDay and computeTotalDays: everything here is
// pure and takes fully-resolved input, so the rules that decide what someone
// is paid can be read, reasoned about and tested without a database anywhere
// near them. The DB half is recomputeAttendanceDaily, which calls this.
//
// Nothing here reads the clock or a connection. Given the same inputs it
// returns the same answer forever, which is what makes the batch job safe to
// re-run over a closed period.

import {
  DAY_OFF_NORMAL_MINUTES,
  type CalendarDayStatus,
  type OvertimeGroup,
  type OvertimeRoundingMinutes,
} from '@hrm/shared'

/** Half-open interval of epoch milliseconds. */
type Interval = { start: number; end: number }

export type OvertimeDayInput = {
  /** How the calendar classified the date — decides which pair of rates
   *  applies, and whether the "first 8 hours" split is in play at all. */
  dayStatus: CalendarDayStatus
  /** Approved overtime blocks for this work-date, as ISO instants. */
  overtimeIntervals: { startAt: string; endAt: string }[]
  /** ISO 8601, or null when the punch is missing. */
  actualCheckInAt: string | null
  actualCheckOutAt: string | null
  /** From the employee's overtime group. 0 means no rounding. */
  roundingMinutes: OvertimeRoundingMinutes
}

export type OvertimeDayResult = {
  /** Total approved minutes, before any of the below is considered. */
  approvedMinutes: number
  /** Of those, the minutes the employee was actually present for. Raw —
   *  rounding has not been applied yet. */
  actualMinutes: number
  /** actualMinutes after rounding, split at the 8-hour mark. Their sum is
   *  what gets paid. */
  normalMinutes: number
  extraMinutes: number
}

function toIntervals(ranges: { startAt: string; endAt: string }[]): Interval[] {
  return ranges
    .map((r) => ({ start: Date.parse(r.startAt), end: Date.parse(r.endAt) }))
    .filter((i) => i.end > i.start)
}

function totalMinutes(intervals: Interval[]): number {
  return Math.round(intervals.reduce((sum, i) => sum + (i.end - i.start), 0) / 60_000)
}

/** The parts of `base` that fall inside `clip`. Same intersect-don't-clamp
 *  approach computeAttendanceDay uses for expectedWorkIntervals: an employee
 *  present 08:30-19:00 against approved OT of 18:00-20:00 contributes only
 *  the hour they overlapped, and no rule about which end they fell short at
 *  has to be written down. */
function intersect(base: Interval[], clip: Interval): Interval[] {
  const out: Interval[] = []
  for (const piece of base) {
    const start = Math.max(piece.start, clip.start)
    const end = Math.min(piece.end, clip.end)
    if (end > start) out.push({ start, end })
  }
  return out
}

/** Rounds down to a multiple of `step`. Down, not nearest: rounding up would
 *  pay for minutes nobody worked, and the rounding rule exists to simplify
 *  payroll, not to award a bonus for clocking out at 20:08. */
function roundMinutes(minutes: number, step: OvertimeRoundingMinutes): number {
  if (step === 0) return minutes
  return Math.floor(minutes / step) * step
}

/** Days on which ordinary working hours exist, so that all overtime on them
 *  is by definition outside those hours. */
function isWorkingDay(status: CalendarDayStatus): boolean {
  return status === 'workday' || status === 'swap_workday'
}

/**
 * One work-date's overtime.
 *
 * Pay follows the punches, not the request: approved 18:00-20:00 but clocked
 * out at 19:00 pays one hour. The reverse is also true and matters more —
 * staying until 21:00 on approved 18:00-20:00 still pays two, because the
 * intersection can never exceed what was approved. Overtime nobody approved
 * is not overtime.
 *
 * A missing check-out yields zero rather than the approved figure. The hours
 * cannot be evidenced, and a row that shows approvedMinutes > 0 with
 * actualMinutes = 0 is exactly the row HR needs to see and chase — paying it
 * out silently would hide it.
 *
 * Rounding is applied once, to the day's total, not per block. Rounding each
 * block and summing gives a different (smaller) answer and would reward
 * splitting one evening into three requests.
 *
 * The 8-hour split applies only to days off and holidays. On a working day
 * the ordinary hours were the shift itself, and the route already refuses any
 * OT range that overlaps it, so every approved minute is "นอกเวลา" — there is
 * nothing to split.
 */
export function computeOvertimeForDay(input: OvertimeDayInput): OvertimeDayResult {
  const approved = toIntervals(input.overtimeIntervals)
  const approvedMinutes = totalMinutes(approved)

  if (approvedMinutes === 0) {
    return { approvedMinutes: 0, actualMinutes: 0, normalMinutes: 0, extraMinutes: 0 }
  }

  if (input.actualCheckInAt === null || input.actualCheckOutAt === null) {
    return { approvedMinutes, actualMinutes: 0, normalMinutes: 0, extraMinutes: 0 }
  }

  const present: Interval = {
    start: Date.parse(input.actualCheckInAt),
    end: Date.parse(input.actualCheckOutAt),
  }
  const actualMinutes = totalMinutes(intersect(approved, present))
  const payable = roundMinutes(actualMinutes, input.roundingMinutes)

  if (isWorkingDay(input.dayStatus)) {
    return { approvedMinutes, actualMinutes, normalMinutes: 0, extraMinutes: payable }
  }

  return {
    approvedMinutes,
    actualMinutes,
    normalMinutes: Math.min(payable, DAY_OFF_NORMAL_MINUTES),
    extraMinutes: Math.max(payable - DAY_OFF_NORMAL_MINUTES, 0),
  }
}

/* Money -------------------------------------------------------------------
 * Which multiplier applies, and what it multiplies. Kept apart from the
 * minute arithmetic above because minutes are a fact about the day that never
 * changes, while a wage is a fact about right now — see the note on
 * overtimeAmount.
 */

/** Which of master_overtime_groups' five rates each bucket is paid at, given
 *  how the day was classified. Mirrors the table in migration 040. */
export function overtimeRatesFor(
  status: CalendarDayStatus,
  group: OvertimeGroup
): { normalRate: number; extraRate: number } {
  if (isWorkingDay(status)) {
    // normalMinutes is always 0 here, so normalRate is never actually used —
    // it is set to the same multiplier rather than 0 so that a future change
    // allowing in-hours OT on a workday cannot silently pay it at nothing.
    return { normalRate: group.rateOtWorkday, extraRate: group.rateOtWorkday }
  }
  if (status === 'holiday') {
    return { normalRate: group.rateNormalHoliday, extraRate: group.rateOtHoliday }
  }
  // weekly_off, swap_dayoff — and 'leave', which cannot carry approved OT at
  // all (the route refuses it), so it never reaches here.
  return { normalRate: group.rateNormalDayoff, extraRate: group.rateOtDayoff }
}

/**
 * What one day's overtime is worth.
 *
 * Deliberately computed on read and never stored. employee_finance holds one
 * current wage with no history behind it, so a figure written down in March
 * and read back after a raise would be neither March's truth nor today's — it
 * would just be wrong, with nothing on the row to reveal it. Minutes are
 * stored because they are a fact about what happened; baht is a fact about
 * the wage in force, and that belongs to whoever asks.
 *
 * Returns null when the wage is unknown, which the report renders as "—"
 * rather than 0 — an employee whose finance tab was never filled in has an
 * unanswered question, not a free evening.
 */
export function overtimeAmount(input: {
  normalMinutes: number
  extraMinutes: number
  status: CalendarDayStatus
  group: OvertimeGroup
  hourlyWage: number | null
}): number | null {
  if (input.hourlyWage === null) return null
  const { normalRate, extraRate } = overtimeRatesFor(input.status, input.group)
  const normalHours = input.normalMinutes / 60
  const extraHours = input.extraMinutes / 60
  return (normalHours * normalRate + extraHours * extraRate) * input.hourlyWage
}

/* Payslip buckets -----------------------------------------------------------
 * Which of the five payroll_entry_lines codes (Phase 3) one day's overtime
 * belongs to. Kept apart from overtimeAmount above because a payslip line is
 * a period-long sum across many days, and this is the per-day routing
 * decision that sum is built from — not a third way of pricing a day.
 */

export type OvertimeBucketCode =
  | 'OT_WORKDAY'
  | 'OT_NORMAL_DAYOFF'
  | 'OT_EXTRA_DAYOFF'
  | 'OT_NORMAL_HOLIDAY'
  | 'OT_EXTRA_HOLIDAY'

export type OvertimeBucketShare = {
  code: OvertimeBucketCode
  minutes: number
  rate: number
  /** null when overtimeAmount() could not price this share — the day's
   *  hourlyWage was unresolvable. A caller must treat this as "needs review",
   *  not zero, the same distinction overtimeAmount() itself draws. */
  amount: number | null
}

/**
 * Splits one day's normal/extra overtime minutes into the payslip bucket(s)
 * they belong to. A working day contributes to exactly one bucket
 * (normalMinutes is always 0 there — see isWorkingDay above); a day off or
 * holiday can contribute to two, since a single day can carry both an
 * "in the first 8 hours" and a "past 8 hours" portion.
 *
 * Each bucket's amount comes from calling overtimeAmount() with the other
 * bucket's minutes zeroed out, not from splitting one combined call
 * proportionally afterward — overtimeAmount's formula has no cross-term
 * between normal and extra minutes, so the two amounts always sum to exactly
 * what one combined call would have returned.
 */
export function bucketOvertimeDay(input: {
  status: CalendarDayStatus
  normalMinutes: number
  extraMinutes: number
  group: OvertimeGroup
  hourlyWage: number | null
}): OvertimeBucketShare[] {
  const { status, normalMinutes, extraMinutes, group, hourlyWage } = input
  const rates = overtimeRatesFor(status, group)

  if (isWorkingDay(status)) {
    return [
      {
        code: 'OT_WORKDAY',
        minutes: extraMinutes,
        rate: rates.extraRate,
        amount: overtimeAmount({ normalMinutes: 0, extraMinutes, status, group, hourlyWage }),
      },
    ]
  }

  const normalCode: OvertimeBucketCode = status === 'holiday' ? 'OT_NORMAL_HOLIDAY' : 'OT_NORMAL_DAYOFF'
  const extraCode: OvertimeBucketCode = status === 'holiday' ? 'OT_EXTRA_HOLIDAY' : 'OT_EXTRA_DAYOFF'
  return [
    {
      code: normalCode,
      minutes: normalMinutes,
      rate: rates.normalRate,
      amount: overtimeAmount({ normalMinutes, extraMinutes: 0, status, group, hourlyWage }),
    },
    {
      code: extraCode,
      minutes: extraMinutes,
      rate: rates.extraRate,
      amount: overtimeAmount({ normalMinutes: 0, extraMinutes, status, group, hourlyWage }),
    },
  ]
}
