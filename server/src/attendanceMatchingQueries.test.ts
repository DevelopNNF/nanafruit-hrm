import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  chooseAttendanceWindow,
  computeShiftWindow,
  resolveOvertimeOwnerDate,
  type MatchedAttendanceDay,
} from './attendanceMatchingQueries.js'

/** A plain scheduled workday on one shift, optionally with punches already
 *  matched — same fixture shape as attendanceImportClassify.test.ts's
 *  `workday`, extended with the actual* fields matchAttendanceForDates adds.
 *  Only the fields chooseAttendanceWindow actually reads (workDate,
 *  expectedCheckInAt/OutAt, overtimeIntervals) carry real meaning for these
 *  tests — the rest are filled in consistently so the fixture stays a valid
 *  MatchedAttendanceDay rather than a cast. */
function workday(
  workDate: string,
  startTime: string,
  endTime: string,
  actual: { checkInAt?: string; checkOutAt?: string } = {}
): MatchedAttendanceDay {
  const { checkInAt, checkOutAt, isOvernight } = computeShiftWindow(workDate, startTime, endTime)
  return {
    workDate,
    status: 'workday',
    shiftId: 1,
    shiftName: 'test',
    expectedCheckInAt: checkInAt.toISOString(),
    expectedCheckOutAt: checkOutAt.toISOString(),
    expectedBreakStartAt: null,
    expectedBreakEndAt: null,
    expectedWorkIntervals: [{ startAt: checkInAt.toISOString(), endAt: checkOutAt.toISOString() }],
    expectedWorkMinutes: Math.round((checkOutAt.getTime() - checkInAt.getTime()) / 60_000),
    overtimeIntervals: [],
    leaveMinutes: 0,
    effectiveCheckInAt: checkInAt.toISOString(),
    effectiveCheckOutAt: checkOutAt.toISOString(),
    isOvernight,
    lateGraceMinutes: 0,
    earlyLeaveGraceMinutes: 0,
    isOffSiteDay: false,
    offSiteRequestId: null,
    actualCheckInAt: actual.checkInAt ?? null,
    actualCheckInEventId: actual.checkInAt ? 1 : null,
    actualCheckOutAt: actual.checkOutAt ?? null,
    actualCheckOutEventId: actual.checkOutAt ? 2 : null,
  }
}

/** A date that expects no attendance at all: no shift, no overtime — the
 *  case matchSpanOf returns null for. */
function noShift(workDate: string): MatchedAttendanceDay {
  return {
    workDate,
    status: 'weekly_off',
    shiftId: null,
    shiftName: null,
    expectedCheckInAt: null,
    expectedCheckOutAt: null,
    expectedBreakStartAt: null,
    expectedBreakEndAt: null,
    expectedWorkIntervals: [],
    expectedWorkMinutes: 0,
    overtimeIntervals: [],
    leaveMinutes: 0,
    effectiveCheckInAt: null,
    effectiveCheckOutAt: null,
    isOvernight: false,
    lateGraceMinutes: null,
    earlyLeaveGraceMinutes: null,
    isOffSiteDay: false,
    offSiteRequestId: null,
    actualCheckInAt: null,
    actualCheckInEventId: null,
    actualCheckOutAt: null,
    actualCheckOutEventId: null,
  }
}

describe('chooseAttendanceWindow', () => {
  it('prefers yesterday while still inside an overnight shift that started the evening before', () => {
    // 22:00-07:00 Bangkok, checked in last night, not out yet.
    const yesterday = workday('2026-08-19', '22:00:00', '07:00:00', { checkInAt: '2026-08-19T15:00:00Z' })
    const today = workday('2026-08-20', '22:00:00', '07:00:00')
    const now = new Date('2026-08-19T20:00:00Z') // 03:00 Bangkok on the 20th
    assert.equal(chooseAttendanceWindow(yesterday, today, now).workDate, '2026-08-19')
  })

  it("stays on yesterday's window right up to the end of its buffer", () => {
    const yesterday = workday('2026-08-19', '22:00:00', '07:00:00', {
      checkInAt: '2026-08-19T15:00:00Z',
      checkOutAt: '2026-08-20T00:00:00Z', // 07:00 Bangkok
    })
    const today = workday('2026-08-20', '22:00:00', '07:00:00')
    const now = new Date('2026-08-20T01:59:00Z') // 08:59 Bangkok — 1 min inside the 2h buffer
    assert.equal(chooseAttendanceWindow(yesterday, today, now).workDate, '2026-08-19')
  })

  it("switches to today's window once yesterday's buffer has passed", () => {
    const yesterday = workday('2026-08-19', '22:00:00', '07:00:00', {
      checkInAt: '2026-08-19T15:00:00Z',
      checkOutAt: '2026-08-20T00:00:00Z',
    })
    const today = workday('2026-08-20', '22:00:00', '07:00:00')
    const now = new Date('2026-08-20T02:30:00Z') // 09:30 Bangkok — 30 min past the buffer
    assert.equal(chooseAttendanceWindow(yesterday, today, now).workDate, '2026-08-20')
  })

  it("shows today's window once tonight's overnight shift has started", () => {
    const yesterday = workday('2026-08-19', '22:00:00', '07:00:00', {
      checkInAt: '2026-08-19T15:00:00Z',
      checkOutAt: '2026-08-20T00:00:00Z',
    })
    const today = workday('2026-08-20', '22:00:00', '07:00:00', { checkInAt: '2026-08-20T16:00:00Z' }) // 23:00 Bangkok
    const now = new Date('2026-08-20T16:00:00Z')
    assert.equal(chooseAttendanceWindow(yesterday, today, now).workDate, '2026-08-20')
  })

  it("shows today's completed ordinary shift in the evening, well past yesterday's buffer", () => {
    const yesterday = workday('2026-08-19', '08:00:00', '17:00:00', {
      checkInAt: '2026-08-19T01:00:00Z',
      checkOutAt: '2026-08-19T10:00:00Z',
    })
    const today = workday('2026-08-20', '08:00:00', '17:00:00', {
      checkInAt: '2026-08-20T01:00:00Z',
      checkOutAt: '2026-08-20T10:00:00Z',
    })
    const now = new Date('2026-08-20T13:00:00Z') // 20:00 Bangkok
    assert.equal(chooseAttendanceWindow(yesterday, today, now).workDate, '2026-08-20')
  })

  it('defaults to today when neither date expects any attendance at all', () => {
    const yesterday = noShift('2026-08-19')
    const today = noShift('2026-08-20')
    const now = new Date('2026-08-20T05:00:00Z')
    assert.equal(chooseAttendanceWindow(yesterday, today, now).workDate, '2026-08-20')
  })
})

describe('resolveOvertimeOwnerDate', () => {
  /** Builds the shiftEdgesByDate map resolveOvertimeOwnerDate reads, from
   *  plain shift-time strings — null for a date with no shift at all. */
  function edges(entries: Record<string, [string, string] | null>): Map<string, { checkInAt: Date; checkOutAt: Date } | null> {
    const map = new Map<string, { checkInAt: Date; checkOutAt: Date } | null>()
    for (const [date, times] of Object.entries(entries)) {
      if (times === null) {
        map.set(date, null)
        continue
      }
      const { checkInAt, checkOutAt } = computeShiftWindow(date, times[0], times[1])
      map.set(date, { checkInAt, checkOutAt })
    }
    return map
  }

  it('attributes an OT block that closes out an overnight shift to the shift\'s own day — the TEMP-0014 case', () => {
    // 20:00-05:00 shifts on both the 10th and the 11th; OT approved 05:00-08:00
    // on the 11th to cover the tail of the shift that started the 10th.
    const shiftEdgesByDate = edges({
      '2026-08-10': ['20:00:00', '05:00:00'],
      '2026-08-11': ['20:00:00', '05:00:00'],
    })
    const { checkInAt: otStart, checkOutAt: otEnd } = computeShiftWindow('2026-08-11', '05:00:00', '08:00:00')
    assert.equal(resolveOvertimeOwnerDate('2026-08-11', otStart, otEnd, shiftEdgesByDate), '2026-08-10')
  })

  it('keeps ot_date when it sits inside its own shift as usual (no neighbor closer)', () => {
    // Ordinary day shift 08:00-17:00, OT tacked on right after it the same day.
    const shiftEdgesByDate = edges({
      '2026-08-19': ['08:00:00', '17:00:00'],
      '2026-08-20': ['08:00:00', '17:00:00'],
    })
    const { checkInAt: otStart, checkOutAt: otEnd } = computeShiftWindow('2026-08-20', '17:00:00', '19:00:00')
    assert.equal(resolveOvertimeOwnerDate('2026-08-20', otStart, otEnd, shiftEdgesByDate), '2026-08-20')
  })

  it('keeps ot_date when both neighboring gaps exceed the cap', () => {
    const shiftEdgesByDate = edges({
      '2026-08-10': ['08:00:00', '12:00:00'], // ends 12:00 — 17h before a 05:00 OT start
      '2026-08-11': ['20:00:00', '23:00:00'], // starts 20:00 — 12h after a 08:00 OT end
    })
    const { checkInAt: otStart, checkOutAt: otEnd } = computeShiftWindow('2026-08-11', '05:00:00', '08:00:00')
    assert.equal(resolveOvertimeOwnerDate('2026-08-11', otStart, otEnd, shiftEdgesByDate), '2026-08-11')
  })

  it('lets the only side with a shift win even far away, as long as within the cap', () => {
    // No shift at all on the 11th itself (a rest day) — only the previous
    // overnight shift to compare against, 3h from the OT's start.
    const shiftEdgesByDate = edges({
      '2026-08-10': ['20:00:00', '02:00:00'],
      '2026-08-11': null,
    })
    const { checkInAt: otStart, checkOutAt: otEnd } = computeShiftWindow('2026-08-11', '05:00:00', '08:00:00')
    assert.equal(resolveOvertimeOwnerDate('2026-08-11', otStart, otEnd, shiftEdgesByDate), '2026-08-10')
  })

  it('keeps ot_date when the only comparable side is beyond the cap', () => {
    const shiftEdgesByDate = edges({
      '2026-08-10': ['20:00:00', '22:00:00'], // ends 22:00 — 7h before a 05:00 OT start, past the 6h cap
      '2026-08-11': null,
    })
    const { checkInAt: otStart, checkOutAt: otEnd } = computeShiftWindow('2026-08-11', '05:00:00', '08:00:00')
    assert.equal(resolveOvertimeOwnerDate('2026-08-11', otStart, otEnd, shiftEdgesByDate), '2026-08-11')
  })

  it('keeps ot_date on an exact tie between the two gaps', () => {
    // Shift ends 00:00 the 11th, next shift starts 08:00 the 11th — an OT
    // block dead in the middle (02:00-06:00) is 2h from both edges.
    const shiftEdgesByDate = edges({
      '2026-08-10': ['16:00:00', '00:00:00'],
      '2026-08-11': ['08:00:00', '17:00:00'],
    })
    const { checkInAt: otStart, checkOutAt: otEnd } = computeShiftWindow('2026-08-11', '02:00:00', '06:00:00')
    assert.equal(resolveOvertimeOwnerDate('2026-08-11', otStart, otEnd, shiftEdgesByDate), '2026-08-11')
  })

  it('stays on ot_date when the previous day is outside the map entirely (caller passed a narrow date range)', () => {
    const shiftEdgesByDate = edges({
      '2026-08-11': ['20:00:00', '05:00:00'],
    })
    const { checkInAt: otStart, checkOutAt: otEnd } = computeShiftWindow('2026-08-11', '05:00:00', '08:00:00')
    assert.equal(resolveOvertimeOwnerDate('2026-08-11', otStart, otEnd, shiftEdgesByDate), '2026-08-11')
  })
})
