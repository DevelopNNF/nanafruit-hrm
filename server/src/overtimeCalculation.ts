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

/* Comp-time-off split -------------------------------------------------------
 * Turning a day's already-priced normal/extra minutes into, per individual
 * overtime_requests row, how much converts to accrued comp-time-off versus
 * how much stays payable as money — the piece that lets comp-time be chosen
 * per REQUEST while OT itself is still computed and rounded per DAY (see
 * computeOvertimeForDay above). Everything here is pure, same discipline as
 * the rest of this file: given the same inputs, the same answer forever, so
 * the split frozen onto an approved request (Phase 5) can be trusted not to
 * silently drift if this logic is ever re-run.
 */

export type OvertimeRequestInterval = { requestId: number; startAt: string; endAt: string }

/** Per-request actual (punch-intersected, unrounded) minutes for one day's
 *  approved requests — the same intersect-against-presence math
 *  computeOvertimeForDay applies to the day's MERGED intervals, applied here
 *  to each request's own interval individually so the day's total can later
 *  be distributed back to the requests that make it up (see
 *  allocateOvertimeDayMinutesToRequests below). A request whose interval
 *  never overlapped the actual presence window gets 0, and a missing punch
 *  zeroes every request for the day — both mirror computeOvertimeForDay's
 *  own rules, not a separate policy invented here. */
export function actualMinutesPerRequest(
  requests: OvertimeRequestInterval[],
  actualCheckInAt: string | null,
  actualCheckOutAt: string | null
): Map<number, number> {
  if (actualCheckInAt === null || actualCheckOutAt === null) {
    return new Map(requests.map((r) => [r.requestId, 0]))
  }
  const present: Interval = { start: Date.parse(actualCheckInAt), end: Date.parse(actualCheckOutAt) }
  const result = new Map<number, number>()
  for (const r of requests) {
    result.set(r.requestId, totalMinutes(intersect(toIntervals([r]), present)))
  }
  return result
}

export type OvertimeRequestAllocation = { requestId: number; normalMinutes: number; extraMinutes: number }

/**
 * Distributes a day's already-rounded ot_normal_minutes/ot_extra_minutes
 * (computeOvertimeForDay's output for the day) across that day's individual
 * approved requests, so a per-request choice made later — pay as money vs.
 * accrue as comp-time — can be applied to the right slice of the day.
 *
 * Two passes, both driven by the requests' own raw actual minutes
 * (actualMinutesPerRequest), in start_time order:
 *
 * 1. Rounding down at the day level can drop a few minutes relative to the
 *    sum of each request's raw actual minutes, since rounding applies to the
 *    day's TOTAL, not per request. That loss is taken from the LAST
 *    request(s) of the day, walking backward — an employee's earliest OT
 *    block of the day never loses minutes to rounding, only later ones do.
 * 2. The normal/extra 8-hour threshold is a property of the whole day, so
 *    it's applied to a running total across requests in start_time order —
 *    the same min/max computeOvertimeForDay applies to the day's single
 *    total, just walked incrementally so it lands on the right request.
 *
 * Callers must pass requests already in start_time order; this function
 * doesn't sort them, since that ordering is a property of how they were
 * queried, not something a pure function should assume how to obtain.
 *
 * The two passes together guarantee the returned allocations sum to exactly
 * dayNormalMinutes/dayExtraMinutes — this is the regression guard a caller
 * building payroll from these allocations depends on (see buildOvertimeLines,
 * Phase 6).
 */
export function allocateOvertimeDayMinutesToRequests(input: {
  dayStatus: CalendarDayStatus
  dayNormalMinutes: number
  dayExtraMinutes: number
  requests: { requestId: number; actualMinutes: number }[]
}): OvertimeRequestAllocation[] {
  const { dayStatus, dayNormalMinutes, dayExtraMinutes, requests } = input
  const payableTotal = dayNormalMinutes + dayExtraMinutes
  const totalActual = requests.reduce((sum, r) => sum + r.actualMinutes, 0)

  if (totalActual === 0 || requests.length === 0) {
    return requests.map((r) => ({ requestId: r.requestId, normalMinutes: 0, extraMinutes: 0 }))
  }

  // Pass 1: take the rounding loss off the last request(s), walking backward.
  let remainingLoss = Math.max(0, totalActual - payableTotal)
  const allocatedActual = new Map<number, number>()
  for (let i = requests.length - 1; i >= 0; i--) {
    const r = requests[i]!
    const deduct = Math.min(r.actualMinutes, remainingLoss)
    allocatedActual.set(r.requestId, r.actualMinutes - deduct)
    remainingLoss -= deduct
  }

  // Pass 2: split each request's allocated minutes at the day's 8-hour
  // threshold, walking forward against a running total.
  const workday = isWorkingDay(dayStatus)
  let runningTotal = 0
  return requests.map((r) => {
    const allocated = allocatedActual.get(r.requestId) ?? 0
    if (workday) {
      runningTotal += allocated
      return { requestId: r.requestId, normalMinutes: 0, extraMinutes: allocated }
    }
    const normalHeadroom = Math.max(0, DAY_OFF_NORMAL_MINUTES - runningTotal)
    const normalPortion = Math.min(allocated, normalHeadroom)
    const extraPortion = allocated - normalPortion
    runningTotal += allocated
    return { requestId: r.requestId, normalMinutes: normalPortion, extraMinutes: extraPortion }
  })
}

/** Which of master_overtime_groups' five comp-time CONVERSION rates each
 *  bucket uses — identical selection logic to overtimeRatesFor, over the
 *  group's comp_rate_* columns instead of its money rate_* columns. Callers
 *  must only reach this when group.compTimeEnabled is true (the five comp
 *  rate columns are null otherwise, by the DB CHECK on master_overtime_groups)
 *  — it throws rather than silently coercing null to NaN, since a caller
 *  getting here without checking the flag first is a bug to surface loudly,
 *  not a data question to paper over. */
export function compConversionRatesFor(
  status: CalendarDayStatus,
  group: OvertimeGroup
): { normalRate: number; extraRate: number } {
  if (!group.compTimeEnabled) {
    throw new Error(`compConversionRatesFor called on group ${group.id}, which has compTimeEnabled = false`)
  }
  if (isWorkingDay(status)) {
    if (group.compRateOtWorkday === null) {
      throw new Error(`overtime group ${group.id} is missing compRateOtWorkday`)
    }
    return { normalRate: group.compRateOtWorkday, extraRate: group.compRateOtWorkday }
  }
  if (status === 'holiday') {
    if (group.compRateNormalHoliday === null || group.compRateOtHoliday === null) {
      throw new Error(`overtime group ${group.id} is missing a comp holiday rate`)
    }
    return { normalRate: group.compRateNormalHoliday, extraRate: group.compRateOtHoliday }
  }
  if (group.compRateNormalDayoff === null || group.compRateOtDayoff === null) {
    throw new Error(`overtime group ${group.id} is missing a comp day-off rate`)
  }
  return { normalRate: group.compRateNormalDayoff, extraRate: group.compRateOtDayoff }
}

/** Rounds to the NEAREST multiple of step, always returning a whole number
 *  of minutes — distinct from roundMinutes() above, which always rounds
 *  down. Money rounding discards partial minutes so nobody is paid for time
 *  not worked; an accrual protects no such asymmetry, so nearest is the
 *  natural default for comp-time (see comp_rounding_minutes' migration
 *  comment). Ties round up, matching Math.round's own behavior. */
export function roundMinutesNearest(minutes: number, step: OvertimeRoundingMinutes): number {
  if (step === 0) return Math.round(minutes)
  return Math.round(minutes / step) * step
}

/** One request's allocated normal+extra minutes, converted to candidate
 *  comp-time-off minutes via the group's comp conversion rates, then rounded
 *  by the group's comp_rounding_minutes. "Candidate" because this is before
 *  the annual cap is checked — see splitCompTimeForAnnualCap. */
export function candidateCompAccrualMinutes(input: {
  status: CalendarDayStatus
  allocatedNormalMinutes: number
  allocatedExtraMinutes: number
  group: OvertimeGroup
}): number {
  const { status, allocatedNormalMinutes, allocatedExtraMinutes, group } = input
  const rates = compConversionRatesFor(status, group)
  const raw = allocatedNormalMinutes * rates.normalRate + allocatedExtraMinutes * rates.extraRate
  return roundMinutesNearest(raw, group.compRoundingMinutes)
}

/** Given one request's candidate comp-time accrual and how much this
 *  employee has already accrued this year, splits it at the group's annual
 *  cap (if any): the portion up to the cap accrues, the remainder converts
 *  back to money — priced from the ORIGINAL OT minutes that produced the
 *  overflow share of the candidate accrual (sourceMinutes), not from the
 *  accrual minutes themselves, since comp-time minutes and OT minutes are
 *  different units related only by the group's conversion rate.
 *  moneySourceMinutesFromOverflow is the overflow share of the accrual
 *  converted back through that same ratio — exact only when
 *  candidateAccrualMinutes and sourceMinutes came from the same call to
 *  candidateCompAccrualMinutes for the same request (see the caller,
 *  postCompTimeAccrualForApprovedDay, Phase 5).
 *
 *  Returns the full candidate as accrualMinutes and 0 overflow when the
 *  group has no cap, or when there is enough headroom left this year. */
export function splitCompTimeForAnnualCap(input: {
  candidateAccrualMinutes: number
  sourceMinutes: number
  alreadyAccruedThisYearMinutes: number
  group: OvertimeGroup
}): { accrualMinutes: number; moneySourceMinutesFromOverflow: number } {
  const { candidateAccrualMinutes, sourceMinutes, alreadyAccruedThisYearMinutes, group } = input

  if (!group.compAnnualCapEnabled || group.compAnnualCapMinutes === null) {
    return { accrualMinutes: candidateAccrualMinutes, moneySourceMinutesFromOverflow: 0 }
  }

  const headroom = Math.max(0, group.compAnnualCapMinutes - alreadyAccruedThisYearMinutes)
  const accrualMinutes = Math.min(candidateAccrualMinutes, headroom)
  const overflowAccrualMinutes = candidateAccrualMinutes - accrualMinutes

  if (overflowAccrualMinutes <= 0 || candidateAccrualMinutes === 0) {
    return { accrualMinutes, moneySourceMinutesFromOverflow: 0 }
  }

  // candidateAccrualMinutes and sourceMinutes were produced by the same
  // (possibly blended normal+extra) conversion, so their ratio holds for any
  // sub-portion of the same request — including the overflow share.
  const moneySourceMinutesFromOverflow = Math.round(
    (overflowAccrualMinutes / candidateAccrualMinutes) * sourceMinutes
  )
  return { accrualMinutes, moneySourceMinutesFromOverflow }
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
