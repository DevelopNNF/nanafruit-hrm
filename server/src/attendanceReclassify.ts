// Re-deriving already-imported punches' check-in/check-out typing after
// something changes what the classifier would have decided about them.
//
// attendance_events.event_type is written once, at import time, by
// classifyImportedPunches (attendanceImportClassify.ts) — and nothing
// afterwards ever revisits it. recomputeAttendanceDaily only re-reads
// existing events and re-derives which work-date claims which punch; it never
// re-guesses what a punch *is*. A punch classified before its trailing
// overtime was approved can therefore stay permanently mis-typed even after
// resolveOvertimeOwnerDate (attendanceMatchingQueries.ts) correctly moves that
// overtime onto the shift it belongs to — and a mis-typed checkout is never
// picked up by computeOvertimeForDay's actualCheckInAt/actualCheckOutAt
// intersection, silently zeroing the overtime actually paid.
//
// This module closes that gap: re-run the same classifier the import used,
// over the punches whose classification could plausibly have changed, and
// write back only the rows whose type is actually different now.

import type pg from 'pg'
import { resolveExpectedShiftWindows } from './attendanceMatchingQueries.js'
import { classifyImportedPunches, type PunchInput } from './attendanceImportClassify.js'
import { addDays } from './shiftAssignmentQueries.js'

type Queryable = Pick<pg.Pool, 'query'>

/** Thailand runs at a fixed UTC+7 with no DST — same standing assumption as
 *  toThailandDateString (shiftAssignmentQueries.ts) and attendanceMatchingQueries.ts. */
function toThailandPunchInput(instant: Date): PunchInput {
  const bangkok = new Date(instant.getTime() + 7 * 60 * 60 * 1000)
  const iso = bangkok.toISOString()
  return { date: iso.slice(0, 10), time: iso.slice(11, 16) }
}

/**
 * Re-derives event_type for one employee's already-imported punches across
 * [fromDate, toDate], and writes back only the rows whose type actually
 * changed. Callers should run this immediately before recomputeAttendanceDaily
 * over the same (or a wider) range, in the same transaction, so the verdict
 * that gets computed reads the corrected types rather than the stale ones.
 *
 * Only 'fingerprint_import' rows are ever touched — never 'admin_correction':
 * an admin_correction's event_type is a deliberate human choice made when the
 * correction was filed (see timeCorrections.ts' approve route), not a guess
 * this module is entitled to revise.
 *
 * Widened by a day either side for both the punches fetched and the windows
 * they're classified against — the same margin classifyImportedPunches'
 * own header comment requires for a fresh import, because a work session can
 * straddle the edge of [fromDate, toDate] in either direction.
 */
export async function reclassifyAttendanceEvents(
  employeeId: number,
  fromDate: string,
  toDate: string,
  db: Queryable
): Promise<void> {
  const punchFrom = addDays(fromDate, -1)
  const punchTo = addDays(toDate, 1)
  const windowFrom = addDays(punchFrom, -1)
  const windowTo = addDays(punchTo, 1)

  const { rows } = await db.query<{ id: string; event_type: 'check_in' | 'check_out'; event_time: string }>(
    `SELECT id, event_type, event_time FROM attendance_events
     WHERE employee_id = $1 AND source = 'fingerprint_import'
       AND event_time >= $2::date AND event_time < ($3::date + INTERVAL '1 day')
     ORDER BY event_time`,
    [employeeId, punchFrom, punchTo]
  )
  if (rows.length === 0) return

  const windowDates: string[] = []
  for (let d = windowFrom; d <= windowTo; d = addDays(d, 1)) windowDates.push(d)

  const punches: PunchInput[] = rows.map((row) => toThailandPunchInput(new Date(row.event_time)))
  const windows = await resolveExpectedShiftWindows(employeeId, windowDates, db)
  const classified = classifyImportedPunches(punches, windows)

  // Matched by instant, not by array position: classifyImportedPunches
  // returns its own chronological order, not necessarily `rows`' order.
  const newTypeByInstant = new Map(classified.map((c) => [c.eventTime, c.eventType]))

  for (const row of rows) {
    const newType = newTypeByInstant.get(new Date(row.event_time).toISOString())
    if (newType === undefined || newType === row.event_type) continue
    await db.query(`UPDATE attendance_events SET event_type = $2 WHERE id = $1`, [row.id, newType])
  }
}
