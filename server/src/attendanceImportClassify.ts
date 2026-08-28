// Deciding which of an imported employee's punches are check-ins and which are
// check-outs.
//
// A fingerprint terminal records instants, not intentions: its export says
// "07:47, 12:01, 12:45, 17:03" and nothing about which of those is arriving and
// which is leaving. The obvious rule — alternate within the day's cell,
// starting with a check-in — is right for a day shift and wrong for every night
// shift, because the terminal files a punch under the calendar day it happened
// on, not under the work-date it belongs to. A 16:30-02:00 shift shows up as:
//
//     cell for day D    02:00  16:34  21:04  21:56
//     cell for day D+1  01:58  16:25  21:01  21:59
//
// where the leading 02:00 is the *previous* work-date's check-out. Alternating
// within the cell would call it a check-in and get all four wrong.
//
// So the shift decides, not the cell. Punches are grouped into the work-date
// whose expected window (widened by MATCH_BUFFER_MINUTES) contains them, and
// only then alternated inside that group. The grouping is deliberately the same
// one matchAttendanceForDates uses when it later reads these events back —
// same buffer, same "earlier work-date claims first" tie-break — because the
// two disagreeing is exactly how a punch ends up written as one day's check-out
// and looked for on another.
//
// Punches that land in no window at all (no shift assigned, a holiday, someone
// clocking on a day off) still have to be imported: they are raw facts, and the
// daily job classifies the day as unscheduled work on its own. Those fall back
// to alternating within the Thailand calendar day, and are flagged so the
// preview can tell HR the shift was not what decided them.

import type { ExpectedShiftWindow } from './attendanceMatchingQueries.js'
import { MATCH_BUFFER_MINUTES, matchSpanOf } from './attendanceMatchingQueries.js'
import { toThailandDateString } from './shiftAssignmentQueries.js'

/** A punch as the sheet stated it — Thailand wall-clock, see
 *  attendanceImportParse.ts. */
export type PunchInput = { date: string; time: string }

export type ClassifiedPunch = {
  /** ISO 8601 UTC, the instant that goes into attendance_events.event_time. */
  eventTime: string
  eventType: 'check_in' | 'check_out'
  /** The work-date this punch was attributed to. For an overnight shift this
   *  is not necessarily the calendar day the punch happened on. */
  workDate: string
  /** False when no expected shift window claimed this punch and the calendar
   *  day fallback decided it instead. */
  matchedShift: boolean
}

/** Thailand runs at a fixed UTC+7 with no DST — the same standing assumption
 *  attendanceMatchingQueries makes. */
function thailandInstant(date: string, time: string): Date {
  return new Date(`${date}T${time}:00+07:00`)
}

function shiftMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60_000)
}

/** In, out, in, out… An odd count leaves the session ending on a check-in,
 *  which is the honest reading of someone who never clocked out — the daily
 *  job reports that day as incomplete rather than inventing a departure. */
function alternate(index: number): 'check_in' | 'check_out' {
  return index % 2 === 0 ? 'check_in' : 'check_out'
}

/**
 * Whether a session's punches start on a check-out rather than a check-in,
 * decided by which end of the expected window the first one sits nearer to.
 *
 * Normally a session opens with an arrival and this is false. It is not always
 * true, though, and the case that forces the question is the first day of any
 * night-shift export: the cell for that day opens with the *previous*
 * work-date's 02:00 departure, and that previous date's own evening punches are
 * in the file before it — which the file does not have, because the period
 * starts there. That session is then a single small-hours punch, and reading it
 * as an arrival would report someone as having started work at 2am.
 *
 * It also rescues the ordinary case of someone who forgot to clock in and only
 * has a departure to show for the day.
 */
function startsOnCheckOut(first: Date, span: { start: Date; end: Date }): boolean {
  const toStart = Math.abs(first.getTime() - span.start.getTime())
  const toEnd = Math.abs(first.getTime() - span.end.getTime())
  return toEnd < toStart
}

/**
 * Assigns a type and a work-date to every punch.
 *
 * `windows` should cover a day either side of the file's own period: the first
 * day's cell can open with the *previous* work-date's overnight check-out, and
 * a shift starting just after midnight can reach back for a punch late on the
 * last day.
 *
 * Returns one entry per input punch, chronological.
 */
export function classifyImportedPunches(
  punches: PunchInput[],
  windows: ExpectedShiftWindow[]
): ClassifiedPunch[] {
  const instants = punches
    .map((punch) => ({ punch, at: thailandInstant(punch.date, punch.time) }))
    .filter((entry) => !Number.isNaN(entry.at.getTime()))
    .sort((a, b) => a.at.getTime() - b.at.getTime())

  const claimed = new Set<number>() // indices into `instants`
  const classified: ClassifiedPunch[] = []

  // Next alternate() index for a work-date, shared between the matched-session
  // loop and the calendar-day fallback below. A late punch that misses the
  // match buffer (overtime past MATCH_BUFFER_MINUTES) still belongs to the
  // same work-date its session already claimed three punches for — without
  // this, the fallback would start counting that work-date from zero again
  // and read the overtime departure as a fresh check-in.
  const nextIndexByWorkDate = new Map<string, number>()

  // Chronological by when each work-date's punches could start, so an earlier
  // work-date claims a contested punch first — that ordering is what sends the
  // 02:00 punch to the night shift that started the evening before rather than
  // to the one starting that afternoon.
  const spans = windows
    .map((window) => ({ workDate: window.workDate, span: matchSpanOf(window) }))
    .filter((entry): entry is { workDate: string; span: { start: Date; end: Date } } => entry.span !== null)
    .sort((a, b) => a.span.start.getTime() - b.span.start.getTime())

  for (const { workDate, span } of spans) {
    const from = shiftMinutes(span.start, -MATCH_BUFFER_MINUTES)
    const to = shiftMinutes(span.end, MATCH_BUFFER_MINUTES)

    const session: { index: number; at: Date }[] = []
    for (let i = 0; i < instants.length; i++) {
      if (claimed.has(i)) continue
      const entry = instants[i]
      if (!entry) continue
      if (entry.at < from || entry.at > to) continue
      claimed.add(i)
      session.push({ index: i, at: entry.at })
    }
    if (session.length === 0) continue

    const offset = startsOnCheckOut(session[0]!.at, span) ? 1 : 0
    session.forEach((punch, order) => {
      classified.push({
        eventTime: punch.at.toISOString(),
        eventType: alternate(order + offset),
        workDate,
        matchedShift: true,
      })
    })
    nextIndexByWorkDate.set(workDate, offset + session.length)
  }

  // Whatever no window wanted, alternated within its own calendar day —
  // continuing from any matched session's count above for that same
  // work-date, rather than starting over at zero.
  for (let i = 0; i < instants.length; i++) {
    if (claimed.has(i)) continue
    const entry = instants[i]
    if (!entry) continue
    const workDate = toThailandDateString(entry.at)
    const index = nextIndexByWorkDate.get(workDate) ?? 0
    nextIndexByWorkDate.set(workDate, index + 1)
    classified.push({
      eventTime: entry.at.toISOString(),
      eventType: alternate(index),
      workDate,
      matchedShift: false,
    })
  }

  return classified.sort((a, b) => a.eventTime.localeCompare(b.eventTime))
}
