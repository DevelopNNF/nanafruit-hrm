import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  chooseAttendanceWindow,
  computeShiftWindow,
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
