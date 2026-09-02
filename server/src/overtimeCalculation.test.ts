// overtimeAmount/overtimeRatesFor predate this file's tests (Phase 3 is the
// first to add a .test.ts here) — a handful of pinning tests for them below,
// plus full coverage of bucketOvertimeDay, the routing logic Phase 3 adds on
// top: which of the five payroll_entry_lines codes a day's overtime belongs
// to, and that splitting a day's amount into two bucket calls never loses or
// duplicates a baht against what one combined overtimeAmount() call returns.

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import type { OvertimeGroup } from '@hrm/shared'
import {
  actualMinutesPerRequest,
  allocateOvertimeDayMinutesToRequests,
  bucketOvertimeDay,
  candidateCompAccrualMinutes,
  compConversionRatesFor,
  overtimeAmount,
  overtimeRatesFor,
  roundMinutesNearest,
  splitCompTimeForAnnualCap,
} from './overtimeCalculation.js'

const GROUP: OvertimeGroup = {
  id: 1,
  groupCode: 'OT1',
  groupName: 'ทดสอบ',
  rateOtWorkday: 1.5,
  rateNormalDayoff: 1,
  rateOtDayoff: 2,
  rateNormalHoliday: 1,
  rateOtHoliday: 3,
  roundingMinutes: 0,
  isActive: true,
  compTimeEnabled: false,
  compRateOtWorkday: null,
  compRateNormalDayoff: null,
  compRateOtDayoff: null,
  compRateNormalHoliday: null,
  compRateOtHoliday: null,
  compAnnualCapEnabled: false,
  compAnnualCapMinutes: null,
  compRoundingMinutes: 0,
}

const COMP_GROUP: OvertimeGroup = {
  ...GROUP,
  compTimeEnabled: true,
  compRateOtWorkday: 1.5,
  compRateNormalDayoff: 1,
  compRateOtDayoff: 2,
  compRateNormalHoliday: 1,
  compRateOtHoliday: 3,
  compAnnualCapEnabled: false,
  compAnnualCapMinutes: null,
  compRoundingMinutes: 0,
}

describe('overtimeRatesFor', () => {
  it('uses rateOtWorkday for both halves of a working day', () => {
    assert.deepEqual(overtimeRatesFor('workday', GROUP), { normalRate: 1.5, extraRate: 1.5 })
    assert.deepEqual(overtimeRatesFor('swap_workday', GROUP), { normalRate: 1.5, extraRate: 1.5 })
  })

  it('splits holiday into its own normal/extra pair', () => {
    assert.deepEqual(overtimeRatesFor('holiday', GROUP), { normalRate: 1, extraRate: 3 })
  })

  it('falls back to the day-off pair for weekly_off and swap_dayoff', () => {
    assert.deepEqual(overtimeRatesFor('weekly_off', GROUP), { normalRate: 1, extraRate: 2 })
    assert.deepEqual(overtimeRatesFor('swap_dayoff', GROUP), { normalRate: 1, extraRate: 2 })
  })
})

describe('overtimeAmount', () => {
  it('prices workday OT off the extra rate at the hourly wage', () => {
    // 120 minutes = 2 hours at 1.5x on a 100 baht/hour wage.
    assert.equal(
      overtimeAmount({ normalMinutes: 0, extraMinutes: 120, status: 'workday', group: GROUP, hourlyWage: 100 }),
      300
    )
  })

  it('combines both halves of a holiday in one call', () => {
    // 60 normal minutes at 1x + 60 extra minutes at 3x, both on 100/hour.
    assert.equal(
      overtimeAmount({ normalMinutes: 60, extraMinutes: 60, status: 'holiday', group: GROUP, hourlyWage: 100 }),
      100 + 300
    )
  })

  it('returns null rather than pricing at zero when the wage is unresolvable', () => {
    assert.equal(
      overtimeAmount({ normalMinutes: 60, extraMinutes: 0, status: 'holiday', group: GROUP, hourlyWage: null }),
      null
    )
  })
})

describe('bucketOvertimeDay', () => {
  it('routes a working day to a single OT_WORKDAY share', () => {
    const shares = bucketOvertimeDay({
      status: 'workday',
      normalMinutes: 0,
      extraMinutes: 120,
      group: GROUP,
      hourlyWage: 100,
    })
    assert.equal(shares.length, 1)
    assert.deepEqual(shares[0], { code: 'OT_WORKDAY', minutes: 120, rate: 1.5, amount: 300 })
  })

  it('routes swap_workday the same as workday', () => {
    const shares = bucketOvertimeDay({
      status: 'swap_workday',
      normalMinutes: 0,
      extraMinutes: 60,
      group: GROUP,
      hourlyWage: 100,
    })
    assert.equal(shares[0]!.code, 'OT_WORKDAY')
  })

  it('splits a holiday day into normal and extra holiday shares', () => {
    const shares = bucketOvertimeDay({
      status: 'holiday',
      normalMinutes: 60,
      extraMinutes: 120,
      group: GROUP,
      hourlyWage: 100,
    })
    assert.equal(shares.length, 2)
    assert.deepEqual(shares[0], { code: 'OT_NORMAL_HOLIDAY', minutes: 60, rate: 1, amount: 100 })
    assert.deepEqual(shares[1], { code: 'OT_EXTRA_HOLIDAY', minutes: 120, rate: 3, amount: 600 })
  })

  it('splits weekly_off/swap_dayoff into normal and extra day-off shares', () => {
    const shares = bucketOvertimeDay({
      status: 'weekly_off',
      normalMinutes: 60,
      extraMinutes: 30,
      group: GROUP,
      hourlyWage: 100,
    })
    assert.equal(shares.length, 2)
    assert.equal(shares[0]!.code, 'OT_NORMAL_DAYOFF')
    assert.equal(shares[1]!.code, 'OT_EXTRA_DAYOFF')

    const swap = bucketOvertimeDay({
      status: 'swap_dayoff',
      normalMinutes: 60,
      extraMinutes: 30,
      group: GROUP,
      hourlyWage: 100,
    })
    assert.equal(swap[0]!.code, 'OT_NORMAL_DAYOFF')
    assert.equal(swap[1]!.code, 'OT_EXTRA_DAYOFF')
  })

  it('splitting into two calls sums to exactly what one combined call returns', () => {
    const combined = overtimeAmount({
      normalMinutes: 45,
      extraMinutes: 90,
      status: 'holiday',
      group: GROUP,
      hourlyWage: 137.5,
    })
    const shares = bucketOvertimeDay({
      status: 'holiday',
      normalMinutes: 45,
      extraMinutes: 90,
      group: GROUP,
      hourlyWage: 137.5,
    })
    const summed = shares.reduce((sum, s) => sum + (s.amount ?? 0), 0)
    assert.ok(combined !== null)
    // Floating point: same operations in a different order can differ in the
    // last bit, so compare to satang rather than bit-for-bit.
    assert.equal(Math.round(summed * 100), Math.round(combined * 100))
  })

  it('propagates a null amount per share when the wage cannot be resolved', () => {
    const shares = bucketOvertimeDay({
      status: 'holiday',
      normalMinutes: 60,
      extraMinutes: 60,
      group: GROUP,
      hourlyWage: null,
    })
    assert.equal(shares[0]!.amount, null)
    assert.equal(shares[1]!.amount, null)
  })

  it('a zero-minute share on an otherwise-priced day still carries its own rate, not a fabricated amount', () => {
    // Holiday day with only extra minutes worked — the normal share exists
    // (holiday always splits) but has 0 minutes. A caller (buildOvertimeLines)
    // is expected to skip zero-minute shares before looking at amount, so
    // this only pins what bucketOvertimeDay itself returns.
    const shares = bucketOvertimeDay({
      status: 'holiday',
      normalMinutes: 0,
      extraMinutes: 60,
      group: GROUP,
      hourlyWage: 100,
    })
    assert.equal(shares[0]!.minutes, 0)
    assert.equal(shares[0]!.amount, 0)
    assert.equal(shares[1]!.minutes, 60)
    assert.equal(shares[1]!.amount, 300)
  })
})

describe('actualMinutesPerRequest', () => {
  it('intersects each request interval against presence individually', () => {
    const requests = [
      { requestId: 1, startAt: '2026-01-05T11:00:00Z', endAt: '2026-01-05T12:00:00Z' },
      { requestId: 2, startAt: '2026-01-05T13:00:00Z', endAt: '2026-01-05T14:00:00Z' },
    ]
    const result = actualMinutesPerRequest(requests, '2026-01-05T11:30:00Z', '2026-01-05T13:30:00Z')
    // request 1: only the last 30 minutes of its hour overlap presence.
    assert.equal(result.get(1), 30)
    // request 2: only the first 30 minutes of its hour overlap presence.
    assert.equal(result.get(2), 30)
  })

  it('zeroes every request when a punch is missing, mirroring computeOvertimeForDay', () => {
    const requests = [{ requestId: 1, startAt: '2026-01-05T11:00:00Z', endAt: '2026-01-05T12:00:00Z' }]
    assert.equal(actualMinutesPerRequest(requests, null, '2026-01-05T13:00:00Z').get(1), 0)
    assert.equal(actualMinutesPerRequest(requests, '2026-01-05T11:00:00Z', null).get(1), 0)
  })
})

describe('allocateOvertimeDayMinutesToRequests', () => {
  it('gives the whole day to a single request — matches the pre-existing money math exactly', () => {
    const allocation = allocateOvertimeDayMinutesToRequests({
      dayStatus: 'workday',
      dayNormalMinutes: 0,
      dayExtraMinutes: 120,
      requests: [{ requestId: 1, actualMinutes: 120 }],
    })
    assert.deepEqual(allocation, [{ requestId: 1, normalMinutes: 0, extraMinutes: 120 }])
  })

  it('splits two same-day day-off requests at the 8-hour boundary inside the second one', () => {
    // 420 minutes then 180 minutes, no rounding loss (700 = 420+180... use
    // exact totals): first request stays entirely normal, second request's
    // first 60 minutes are normal (fills the 480 threshold) and the
    // remaining 120 are extra.
    const allocation = allocateOvertimeDayMinutesToRequests({
      dayStatus: 'weekly_off',
      dayNormalMinutes: 480,
      dayExtraMinutes: 120,
      requests: [
        { requestId: 1, actualMinutes: 420 },
        { requestId: 2, actualMinutes: 180 },
      ],
    })
    assert.deepEqual(allocation, [
      { requestId: 1, normalMinutes: 420, extraMinutes: 0 },
      { requestId: 2, normalMinutes: 60, extraMinutes: 120 },
    ])
  })

  it('takes the rounding-down loss off the last request, walking backward', () => {
    // Two requests actually total 130 minutes; day-level rounding (30 min
    // step) brings the payable total down to 120 — the 10-minute loss must
    // come off request 2 first (the last one), not request 1.
    const allocation = allocateOvertimeDayMinutesToRequests({
      dayStatus: 'workday',
      dayNormalMinutes: 0,
      dayExtraMinutes: 120,
      requests: [
        { requestId: 1, actualMinutes: 70 },
        { requestId: 2, actualMinutes: 60 },
      ],
    })
    assert.deepEqual(allocation, [
      { requestId: 1, normalMinutes: 0, extraMinutes: 70 },
      { requestId: 2, normalMinutes: 0, extraMinutes: 50 },
    ])
    const total = allocation.reduce((sum, a) => sum + a.normalMinutes + a.extraMinutes, 0)
    assert.equal(total, 120)
  })

  it('carries the rounding loss past a request whose own actual minutes are smaller than the loss', () => {
    // Loss of 45 minutes must eat all of request 2 (20 min) and spill 25
    // minutes into request 1, not go negative on request 2.
    const allocation = allocateOvertimeDayMinutesToRequests({
      dayStatus: 'workday',
      dayNormalMinutes: 0,
      dayExtraMinutes: 55,
      requests: [
        { requestId: 1, actualMinutes: 80 },
        { requestId: 2, actualMinutes: 20 },
      ],
    })
    assert.deepEqual(allocation, [
      { requestId: 1, normalMinutes: 0, extraMinutes: 55 },
      { requestId: 2, normalMinutes: 0, extraMinutes: 0 },
    ])
  })

  it('returns all-zero allocations when the day has no actual minutes at all', () => {
    const allocation = allocateOvertimeDayMinutesToRequests({
      dayStatus: 'holiday',
      dayNormalMinutes: 0,
      dayExtraMinutes: 0,
      requests: [{ requestId: 1, actualMinutes: 0 }],
    })
    assert.deepEqual(allocation, [{ requestId: 1, normalMinutes: 0, extraMinutes: 0 }])
  })
})

describe('compConversionRatesFor', () => {
  it('mirrors overtimeRatesFor\'s selection logic over the comp_rate_* columns', () => {
    assert.deepEqual(compConversionRatesFor('workday', COMP_GROUP), { normalRate: 1.5, extraRate: 1.5 })
    assert.deepEqual(compConversionRatesFor('holiday', COMP_GROUP), { normalRate: 1, extraRate: 3 })
    assert.deepEqual(compConversionRatesFor('weekly_off', COMP_GROUP), { normalRate: 1, extraRate: 2 })
  })

  it('throws when the group does not have comp-time enabled', () => {
    assert.throws(() => compConversionRatesFor('workday', GROUP))
  })
})

describe('roundMinutesNearest', () => {
  it('rounds to the nearest step, not down', () => {
    assert.equal(roundMinutesNearest(37, 15), 30)
    assert.equal(roundMinutesNearest(38, 15), 45)
    assert.equal(roundMinutesNearest(97, 60), 120)
  })

  it('rounds ties up, matching Math.round', () => {
    assert.equal(roundMinutesNearest(7.5, 15), 15)
  })

  it('returns a whole number even with no step configured', () => {
    assert.equal(roundMinutesNearest(90.4, 0), 90)
    assert.equal(roundMinutesNearest(90.6, 0), 91)
  })
})

describe('candidateCompAccrualMinutes', () => {
  it('converts allocated minutes through the comp rate, e.g. 4 hours at 1.5x -> 6 hours', () => {
    const minutes = candidateCompAccrualMinutes({
      status: 'workday',
      allocatedNormalMinutes: 0,
      allocatedExtraMinutes: 240,
      group: COMP_GROUP,
    })
    assert.equal(minutes, 360)
  })

  it('blends normal and extra minutes at their own rates on a day off', () => {
    const minutes = candidateCompAccrualMinutes({
      status: 'weekly_off',
      allocatedNormalMinutes: 60, // x1
      allocatedExtraMinutes: 60, // x2
      group: COMP_GROUP,
    })
    assert.equal(minutes, 180)
  })

  it('applies the group\'s comp rounding to the converted total', () => {
    const rounded = candidateCompAccrualMinutes({
      status: 'workday',
      allocatedNormalMinutes: 0,
      allocatedExtraMinutes: 37, // 37 * 1.5 = 55.5
      group: { ...COMP_GROUP, compRoundingMinutes: 15 },
    })
    assert.equal(rounded, 60)
  })
})

describe('splitCompTimeForAnnualCap', () => {
  it('accrues the full candidate with no overflow when the group has no cap', () => {
    const result = splitCompTimeForAnnualCap({
      candidateAccrualMinutes: 360,
      sourceMinutes: 240,
      alreadyAccruedThisYearMinutes: 10_000,
      group: COMP_GROUP,
    })
    assert.deepEqual(result, { accrualMinutes: 360, moneySourceMinutesFromOverflow: 0 })
  })

  it('accrues the full candidate when there is enough headroom under the cap', () => {
    const group: OvertimeGroup = { ...COMP_GROUP, compAnnualCapEnabled: true, compAnnualCapMinutes: 480 }
    const result = splitCompTimeForAnnualCap({
      candidateAccrualMinutes: 360,
      sourceMinutes: 240,
      alreadyAccruedThisYearMinutes: 0,
      group,
    })
    assert.deepEqual(result, { accrualMinutes: 360, moneySourceMinutesFromOverflow: 0 })
  })

  it('prorates the overflow to money, proportionally, when the cap is crossed mid-request', () => {
    const group: OvertimeGroup = { ...COMP_GROUP, compAnnualCapEnabled: true, compAnnualCapMinutes: 480 }
    // Already accrued 400/480 -> only 80 minutes of headroom left. Candidate
    // 360 accrual came from 240 source minutes (1.5x): overflow is
    // 360-80=280 accrual minutes, which is 280/360 of the request, so the
    // money-priced source share is 280/360 * 240 = 186.67 -> rounds to 187.
    const result = splitCompTimeForAnnualCap({
      candidateAccrualMinutes: 360,
      sourceMinutes: 240,
      alreadyAccruedThisYearMinutes: 400,
      group,
    })
    assert.deepEqual(result, { accrualMinutes: 80, moneySourceMinutesFromOverflow: 187 })
  })

  it('accrues nothing and converts the whole request to money once the cap is already reached', () => {
    const group: OvertimeGroup = { ...COMP_GROUP, compAnnualCapEnabled: true, compAnnualCapMinutes: 480 }
    const result = splitCompTimeForAnnualCap({
      candidateAccrualMinutes: 180,
      sourceMinutes: 120,
      alreadyAccruedThisYearMinutes: 480,
      group,
    })
    assert.deepEqual(result, { accrualMinutes: 0, moneySourceMinutesFromOverflow: 120 })
  })
})
