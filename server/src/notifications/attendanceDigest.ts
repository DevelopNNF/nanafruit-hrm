// The once-a-day attendance/absence summary — a digest, not a push per
// event, per the confirmed scope: only absent-outright and late/left-early
// past grace, grouped so each supervisor hears about their own team and HR
// hears about everyone. See notify() for why this is two kinds of event
// (attendance_digest_supervisor / attendance_digest_hr) rather than one:
// they land on different channels (LINE vs email) with different content.
//
// Called once per real calendar day that just closed, from whichever entry
// point (CLI or the cron route) is running attendanceDailyJob's DEFAULT
// window — see the callers' own comments for why an explicit --from/--to
// range does not trigger this. Sending is not idempotent the way the
// attendance_daily upsert is: running this twice for the same date sends the
// digest twice. That's an accepted gap for the fire-and-forget MVP, not
// something this file guards against.

import type pg from 'pg'
import { pool } from '../db.js'
import { listAttendanceIssuesForDate, type AttendanceIssue } from '../attendanceDailyQueries.js'
import { notify } from './dispatch.js'

type Queryable = Pick<pg.Pool, 'query'>

function groupBySupervisor(issues: AttendanceIssue[]): Map<number, AttendanceIssue[]> {
  const groups = new Map<number, AttendanceIssue[]>()
  for (const issue of issues) {
    if (issue.supervisorEmployeeId === null) continue
    const group = groups.get(issue.supervisorEmployeeId)
    if (group) group.push(issue)
    else groups.set(issue.supervisorEmployeeId, [issue])
  }
  return groups
}

/**
 * Awaits every notify() call it fires rather than firing them loose
 * (`void notify(...)`) the way route handlers do: this function is itself
 * the thing a caller fires-and-forgets (the cron route) or awaits before
 * exiting (the CLI, which closes the pool right after — see its own
 * comment). Either way, whoever calls this needs "done" to actually mean
 * every push/email attempt has finished, not just been started.
 */
export async function sendAttendanceDigest(workDate: string, db: Queryable = pool): Promise<void> {
  const issues = await listAttendanceIssuesForDate(workDate, db)
  if (issues.length === 0) return

  const bySupervisor = groupBySupervisor(issues)
  const sends: Promise<void>[] = []
  for (const [supervisorEmployeeId, teamIssues] of bySupervisor) {
    sends.push(
      notify({ kind: 'attendance_digest_supervisor', workDate, supervisorEmployeeId, issues: teamIssues }, db)
    )
  }
  // Everyone, including anyone with no supervisor to hear it from above —
  // HR's copy is company-wide by design, not just the leftovers.
  sends.push(notify({ kind: 'attendance_digest_hr', workDate, issues }, db))

  await Promise.all(sends)
}
