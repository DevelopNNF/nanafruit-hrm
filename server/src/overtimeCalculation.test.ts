// overtimeAmount/overtimeRatesFor predate this file's tests (Phase 3 is the
// first to add a .test.ts here) — a handful of pinning tests for them below,
// plus full coverage of bucketOvertimeDay, the routing logic Phase 3 adds on
// top: which of the five payroll_entry_lines codes a day's overtime belongs
// to, and that splitting a day's amount into two bucket calls never loses or
// duplicates a baht against what one combined overtimeAmount() call returns.

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import type { OvertimeGroup } from '@hrm/shared'
import { bucketOvertimeDay, overtimeAmount, overtimeRatesFor } from './overtimeCalculation.js'

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
