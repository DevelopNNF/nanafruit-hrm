// Letting HR attach an already-recorded punch to a work-date by hand, for the
// case matching (attendanceMatchingQueries.ts) was never going to solve on
// its own: a punch that landed outside MATCH_BUFFER_MINUTES with no approved
// OT to widen the search for it (unapproved overtime that ran late, most
// commonly). The mechanism is the same confirmed_work_date column the
// attendance import's punch editor already uses (see
// attendanceMatchingQueries.ts's header comment) — this just opens a second
// way to set it, from the day-to-day attendance report instead of the import
// flow.
//
// Deliberately does not touch workedMinutes/OT eligibility itself: confirming
// a punch only changes which raw event recomputeAttendanceDaily sees as the
// day's actual check-in/out. computeAttendanceDay still caps workedMinutes to
// expectedWorkIntervals (the shift's own hours), and computeOvertimeForDay
// still returns 0 whenever no OT request is approved — so this can fix a
// wrongly-short "worked minutes"/incomplete-day verdict, but can never cause
// unapproved overtime to get paid.

import type pg from 'pg'
import type { AttendanceEventType, PayrollPeriodStatus } from '@hrm/shared'
import { pool } from './db.js'
import { addDays } from './shiftAssignmentQueries.js'
import { matchAttendanceForDates, thailandDateTime } from './attendanceMatchingQueries.js'

type Queryable = Pick<pg.Pool, 'query'>

export type RawPunch = {
  id: number
  eventType: AttendanceEventType
  /** ISO 8601. */
  eventTime: string
  source: string
}

export type CandidatePunch = RawPunch & {
  /** The work-date this punch is currently serving as an ordinary
   *  buffer-matched check-in/out, if any other than the one being asked
   *  about — null when nothing currently uses it at all. Confirming a
   *  candidate that has one moves the punch off that date; the confirm-punch
   *  route always recomputes workDate ±1, which covers every date a
   *  candidate here could ever belong to (see the search window below), so
   *  that date's own row stays correct afterward. This is what makes an
   *  overnight shift's tail — a punch that lands inside the *next* day's own
   *  morning shift window and gets claimed there instead — visible and
   *  reassignable rather than silently hidden. */
  claimedByWorkDate: string | null
}

/**
 * Excludes a punch that is already this exact work-date's own current
 * check-in/out (pointless to re-suggest — picking it again is a no-op), and
 * annotates every remaining one with whichever OTHER work-date currently
 * claims it via ordinary buffer matching. Split out from findCandidatePunches
 * so the rule is testable without a database.
 */
export function buildCandidateList(
  events: RawPunch[],
  owningWorkDateByEventId: Map<number, string>,
  workDate: string
): CandidatePunch[] {
  const candidates: CandidatePunch[] = []
  for (const event of events) {
    const owner = owningWorkDateByEventId.get(event.id) ?? null
    if (owner === workDate) continue
    candidates.push({ ...event, claimedByWorkDate: owner })
  }
  return candidates
}

/**
 * Raw attendance_events punches near `workDate` that can be confirmed as its
 * real check-in/out: not already this date's own pick, and not confirmed to
 * a *different* date already (moving a punch off a date it was deliberately
 * confirmed to is a separate, more dangerous operation this endpoint does
 * not attempt). A punch a NEIGHBOURING day currently claims through ordinary
 * buffer matching is still offered — see CandidatePunch.claimedByWorkDate —
 * because that claim is exactly the kind of mistake this feature exists to
 * fix: an overnight shift's true tail landing inside the following day's own
 * shift buffer and getting misread as that day's check-in instead.
 *
 * The search window is [workDate-1, workDate+2) — one full day either side
 * of workDate itself — generous enough to catch a punch that ran hours past
 * a shift's end (or started hours before it) without pulling in unrelated
 * activity from further away. Ownership is resolved via matchAttendanceForDates
 * over the same three dates, rather than re-deriving the buffer math here, so
 * the two can never disagree about what counts as "currently matched".
 */
export async function findCandidatePunches(
  employeeId: number,
  workDate: string,
  db: Queryable = pool
): Promise<CandidatePunch[]> {
  const previousDate = addDays(workDate, -1)
  const nextDate = addDays(workDate, 1)
  const matched = await matchAttendanceForDates(employeeId, [previousDate, workDate, nextDate], db)

  const owningWorkDateByEventId = new Map<number, string>()
  for (const day of matched) {
    if (day.actualCheckInEventId !== null) owningWorkDateByEventId.set(day.actualCheckInEventId, day.workDate)
    if (day.actualCheckOutEventId !== null) owningWorkDateByEventId.set(day.actualCheckOutEventId, day.workDate)
  }

  const { rows } = await db.query<{ id: string; event_type: string; event_time: string; source: string }>(
    `SELECT id, event_type, event_time, source FROM attendance_events
     WHERE employee_id = $1 AND event_time >= $2 AND event_time < $3
       AND (confirmed_work_date IS NULL OR confirmed_work_date = $4)
     ORDER BY event_time ASC`,
    [
      employeeId,
      thailandDateTime(previousDate, '00:00:00').toISOString(),
      thailandDateTime(addDays(nextDate, 1), '00:00:00').toISOString(),
      workDate,
    ]
  )

  const events: RawPunch[] = rows.map((row) => ({
    id: Number(row.id),
    eventType: row.event_type as AttendanceEventType,
    eventTime: new Date(row.event_time).toISOString(),
    source: row.source,
  }))

  return buildCandidateList(events, owningWorkDateByEventId, workDate)
}

/** The payroll_periods.status covering one employee's work-date, or null when
 *  they aren't in a payroll group yet or no (non-voided) period covers this
 *  date — either way, nothing to protect. Joins through
 *  employment_details.payroll_group_id rather than payroll_entries: a period
 *  can exist and be locked before it's ever been calculated for this
 *  specific employee. */
export async function resolvePayrollPeriodStatus(
  employeeId: number,
  workDate: string,
  db: Queryable = pool
): Promise<PayrollPeriodStatus | null> {
  const { rows } = await db.query<{ status: string }>(
    `SELECT p.status
     FROM payroll_periods p
     JOIN employment_details ed ON ed.payroll_group_id = p.payroll_group_id
     WHERE ed.employee_id = $1 AND p.period_start <= $2 AND p.period_end >= $2 AND p.status <> 'voided'`,
    [employeeId, workDate]
  )
  const row = rows[0]
  return row ? (row.status as PayrollPeriodStatus) : null
}

/** Whether a payroll period's status should block editing the attendance it
 *  was calculated from. `draft`/`calculating` (and no period at all, `null`)
 *  are still fair game; anything further along (`review`/`approved`/`paid`/
 *  `closed`) must be reopened first — same boundary
 *  calculatePayrollEntries already enforces before letting a period
 *  recalculate (payrollEntryQueries.ts). */
export function isPeriodLockedForEdit(status: PayrollPeriodStatus | null): boolean {
  return status !== null && status !== 'draft' && status !== 'calculating'
}
