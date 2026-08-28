import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { classifyImportedPunches, type PunchInput } from './attendanceImportClassify.js'
import { computeShiftWindow, type ExpectedShiftWindow } from './attendanceMatchingQueries.js'

/** A plain scheduled workday on one shift. Only the fields the classifier
 *  actually reads carry meaning — the rest are filled in consistently so the
 *  fixture stays a valid ExpectedShiftWindow rather than a cast. */
function workday(workDate: string, startTime: string, endTime: string): ExpectedShiftWindow {
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
  }
}

/** A date the employee owed nothing on: no shift, no overtime. */
function dayOff(workDate: string): ExpectedShiftWindow {
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
  }
}

/** Thailand wall-clock 'YYYY-MM-DD HH:MM' for whatever a punch was classified
 *  as, so assertions read like the sheet does. */
function atLocal(iso: string): string {
  return new Date(iso).toLocaleString('sv-SE', { timeZone: 'Asia/Bangkok' }).slice(0, 16)
}

function summarise(punches: ReturnType<typeof classifyImportedPunches>) {
  return punches.map((punch) => `${atLocal(punch.eventTime)} ${punch.eventType} → ${punch.workDate}`)
}

function cell(date: string, times: string[]): PunchInput[] {
  return times.map((time) => ({ date, time }))
}

describe('classifyImportedPunches — day shift', () => {
  it('reads a four-punch day as in, lunch out, lunch in, out', () => {
    const punches = cell('2026-07-28', ['07:47', '12:01', '12:45', '17:03'])
    const result = classifyImportedPunches(punches, [workday('2026-07-28', '08:00:00', '17:00:00')])

    assert.deepEqual(summarise(result), [
      '2026-07-28 07:47 check_in → 2026-07-28',
      '2026-07-28 12:01 check_out → 2026-07-28',
      '2026-07-28 12:45 check_in → 2026-07-28',
      '2026-07-28 17:03 check_out → 2026-07-28',
    ])
    assert.ok(result.every((punch) => punch.matchedShift))
  })

  it('leaves a day the export caught mid-shift ending on a check-in', () => {
    // Three punches means nobody has gone home yet. Inventing a departure
    // would turn an incomplete day into a complete-looking wrong one.
    const punches = cell('2026-08-04', ['07:51', '12:03', '12:47'])
    const result = classifyImportedPunches(punches, [workday('2026-08-04', '08:00:00', '17:00:00')])

    assert.deepEqual(
      result.map((punch) => punch.eventType),
      ['check_in', 'check_out', 'check_in']
    )
  })
})

describe('classifyImportedPunches — overnight shift', () => {
  // The case the whole module exists for. A 16:30-02:00 shift files its
  // check-out under the FOLLOWING calendar day, so each cell opens with the
  // previous work-date's departure:
  //
  //     cell 2026-07-28   02:00  16:34  21:04  21:56
  //     cell 2026-07-29   01:58  16:25  21:01  21:59
  //
  // where 02:00 on the 28th closes the 27th, and 01:58 on the 29th closes the
  // 28th. Alternating within each cell would call both of those check-ins.
  const windows = [
    workday('2026-07-27', '16:30:00', '02:00:00'),
    workday('2026-07-28', '16:30:00', '02:00:00'),
    workday('2026-07-29', '16:30:00', '02:00:00'),
  ]
  const punches = [
    ...cell('2026-07-28', ['02:00', '16:34', '21:04', '21:56']),
    ...cell('2026-07-29', ['01:58', '16:25', '21:01', '21:59']),
  ]

  it('gives the small-hours punch to the work-date that started the evening before', () => {
    const result = classifyImportedPunches(punches, windows)

    assert.deepEqual(summarise(result), [
      '2026-07-28 02:00 check_out → 2026-07-27',
      '2026-07-28 16:34 check_in → 2026-07-28',
      '2026-07-28 21:04 check_out → 2026-07-28',
      '2026-07-28 21:56 check_in → 2026-07-28',
      '2026-07-29 01:58 check_out → 2026-07-28',
      '2026-07-29 16:25 check_in → 2026-07-29',
      '2026-07-29 21:01 check_out → 2026-07-29',
      '2026-07-29 21:59 check_in → 2026-07-29',
    ])
  })

  it('reads a lone small-hours punch at the start of a file as a departure', () => {
    // The first day of any night-shift export opens with the previous
    // work-date's check-out, and that work-date's own evening punches are
    // before the period begins — so its session is this punch alone. Reading
    // it as an arrival would report someone as starting work at 2am.
    const result = classifyImportedPunches(cell('2026-07-28', ['02:00']), windows)

    assert.deepEqual(summarise(result), ['2026-07-28 02:00 check_out → 2026-07-27'])
  })

  it('closes each night with the check-out that arrived in the next day cell', () => {
    const result = classifyImportedPunches(punches, windows)
    const night = result.filter((punch) => punch.workDate === '2026-07-28')

    assert.deepEqual(
      night.map((punch) => `${atLocal(punch.eventTime)} ${punch.eventType}`),
      [
        '2026-07-28 16:34 check_in',
        '2026-07-28 21:04 check_out',
        '2026-07-28 21:56 check_in',
        '2026-07-29 01:58 check_out',
      ]
    )
  })
})

describe('classifyImportedPunches — overtime past the match buffer', () => {
  it('reads a departure that misses the buffer as a check-out, not a fresh check-in', () => {
    // Shift ends 17:00, buffer is 120 minutes, so 19:30 falls outside the
    // session and is picked up by the calendar-day fallback below. It must
    // still continue the day's in/out/in count rather than restart from zero.
    const punches = cell('2026-08-20', ['07:49', '12:01', '12:46', '19:30'])
    const result = classifyImportedPunches(punches, [workday('2026-08-20', '08:00:00', '17:00:00')])

    assert.deepEqual(summarise(result), [
      '2026-08-20 07:49 check_in → 2026-08-20',
      '2026-08-20 12:01 check_out → 2026-08-20',
      '2026-08-20 12:46 check_in → 2026-08-20',
      '2026-08-20 19:30 check_out → 2026-08-20',
    ])
    assert.deepEqual(
      result.map((punch) => punch.matchedShift),
      [true, true, true, false]
    )
  })
})

describe('classifyImportedPunches — punches no shift claims', () => {
  it('still imports them, alternating within the calendar day and saying so', () => {
    // Someone who came in on a rest day. The events are raw facts and belong
    // in the ledger; the daily job is what decides the day was unscheduled.
    const punches = cell('2026-07-26', ['08:02', '16:30'])
    const result = classifyImportedPunches(punches, [dayOff('2026-07-26')])

    assert.deepEqual(summarise(result), [
      '2026-07-26 08:02 check_in → 2026-07-26',
      '2026-07-26 16:30 check_out → 2026-07-26',
    ])
    assert.ok(result.every((punch) => !punch.matchedShift))
  })

  it('does not let an unclaimed punch bleed into the next calendar day', () => {
    const punches = [...cell('2026-07-26', ['08:02']), ...cell('2026-07-27', ['09:15'])]
    const result = classifyImportedPunches(punches, [dayOff('2026-07-26'), dayOff('2026-07-27')])

    assert.deepEqual(
      result.map((punch) => punch.eventType),
      ['check_in', 'check_in']
    )
  })
})

describe('classifyImportedPunches — edges', () => {
  it('returns nothing for an employee the terminal recorded nothing for', () => {
    assert.deepEqual(classifyImportedPunches([], [workday('2026-07-28', '08:00:00', '17:00:00')]), [])
  })

  it('reads a day with only a departure on it as a departure', () => {
    // Someone who forgot to clock in. Alternating from "check_in" regardless
    // would record them as arriving at going-home time.
    const result = classifyImportedPunches(
      cell('2026-07-28', ['17:02']),
      [workday('2026-07-28', '08:00:00', '17:00:00')]
    )

    assert.deepEqual(summarise(result), ['2026-07-28 17:02 check_out → 2026-07-28'])
  })

  it('keeps a punch a couple of hours either side of the shift', () => {
    // The match buffer is what lets a genuinely early arrival and a late
    // departure still belong to their own work-date.
    const punches = cell('2026-07-28', ['06:15', '18:45'])
    const result = classifyImportedPunches(punches, [workday('2026-07-28', '08:00:00', '17:00:00')])

    assert.deepEqual(summarise(result), [
      '2026-07-28 06:15 check_in → 2026-07-28',
      '2026-07-28 18:45 check_out → 2026-07-28',
    ])
  })
})
