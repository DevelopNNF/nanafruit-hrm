// The three period lengths a 26th-to-25th cycle actually produces in 2026 —
// same pinned windows payrollPeriod.test.ts uses — because the one bug this
// module exists to prevent (dividing by the window instead of by 30) is
// invisible on a 30-day period and only shows up on the other two.

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import {
  employedDayCount,
  isFullPeriodEmployment,
  lateOrEarlyDeductionAmount,
  monthlyAbsenceDeduction,
  monthlyGrossWage,
  round2,
} from './payrollEarnings.js'

const AUGUST = { start: '2026-07-26', end: '2026-08-25' } // 31 days
const MAY = { start: '2026-04-26', end: '2026-05-25' } // 30 days
const MARCH = { start: '2026-02-26', end: '2026-03-25' } // 28 days

describe('employedDayCount', () => {
  it('counts the full window for someone employed through all of it', () => {
    assert.equal(employedDayCount(AUGUST.start, AUGUST.end, '2020-01-01', null), 31)
  })

  it('clips to the day someone joined mid-period', () => {
    // Joined 2026-08-10: 10th through 25th inclusive is 16 days.
    assert.equal(employedDayCount(AUGUST.start, AUGUST.end, '2026-08-10', null), 16)
  })

  it('clips to the day someone left mid-period', () => {
    // Left 2026-08-05: 26 Jul through 5 Aug inclusive is 11 days.
    assert.equal(employedDayCount(AUGUST.start, AUGUST.end, '2020-01-01', '2026-08-05'), 11)
  })

  it('returns 0 for an employment that does not overlap the period at all', () => {
    assert.equal(employedDayCount(AUGUST.start, AUGUST.end, '2026-09-01', null), 0)
  })
})

describe('isFullPeriodEmployment', () => {
  it('is true for someone employed before the period and still active', () => {
    assert.equal(isFullPeriodEmployment(AUGUST.start, AUGUST.end, '2020-01-01', null), true)
  })

  it('is false for someone who joined mid-period', () => {
    assert.equal(isFullPeriodEmployment(AUGUST.start, AUGUST.end, '2026-08-10', null), false)
  })

  it('is false for someone who left mid-period', () => {
    assert.equal(isFullPeriodEmployment(AUGUST.start, AUGUST.end, '2020-01-01', '2026-08-20'), false)
  })

  it('is true for someone whose last day is exactly the period end', () => {
    assert.equal(isFullPeriodEmployment(AUGUST.start, AUGUST.end, '2020-01-01', AUGUST.end), true)
  })
})

describe('monthlyGrossWage — full-period stayer gets the wage exactly', () => {
  // The core guarantee: a person who worked the whole period is paid the
  // wage in full no matter how long that period happened to be — 28, 30 or
  // 31 days must all give the identical answer for the same wage.
  for (const [label, window] of [['31-day August', AUGUST], ['30-day May', MAY], ['28-day March', MARCH]] as const) {
    it(`pays exactly the wage on the ${label} period`, () => {
      const days = employedDayCount(window.start, window.end, '2020-01-01', null)
      assert.equal(monthlyGrossWage(30_000, true, days), 30_000)
    })
  }
})

describe('monthlyGrossWage — partial period is prorated by a fixed 30, not by window length', () => {
  it('prices a mid-period joiner in the 31-day period below what ÷31 would give', () => {
    // Joined 2026-08-10: employed 16 of August's 31 days.
    const days = employedDayCount(AUGUST.start, AUGUST.end, '2026-08-10', null)
    const gross = monthlyGrossWage(30_000, false, days)
    assert.equal(gross, round2((30_000 / 30) * 16))
    // If this used ÷31 instead, the answer would be higher — confirms the
    // fixed divisor rather than the window length is actually driving it.
    assert.notEqual(gross, round2((30_000 / 31) * 16))
  })

  it('prices a mid-period joiner in the 28-day March period above what ÷28 would give', () => {
    // Joined 2026-03-10: employed 16 of March's 28 days.
    const days = employedDayCount(MARCH.start, MARCH.end, '2026-03-10', null)
    const gross = monthlyGrossWage(30_000, false, days)
    assert.equal(gross, round2((30_000 / 30) * 16))
    assert.notEqual(gross, round2((30_000 / 28) * 16))
  })

  it('never exceeds the full wage even if employedDays is overstated', () => {
    assert.equal(monthlyGrossWage(30_000, false, 40), 30_000)
  })

  it('is 0 for someone with no employed days in the period', () => {
    assert.equal(monthlyGrossWage(30_000, false, 0), 0)
  })
})

describe('monthlyAbsenceDeduction', () => {
  it('deducts wage/30 per absent or unpaid-leave day, same divisor as proration', () => {
    assert.equal(monthlyAbsenceDeduction(30_000, 2), round2((30_000 / 30) * 2))
  })

  it('is 0 for someone with no absences', () => {
    assert.equal(monthlyAbsenceDeduction(30_000, 0), 0)
  })

  it('combined with a full-period gross wage, never goes negative', () => {
    const gross = monthlyGrossWage(30_000, true, 31)
    const deduction = monthlyAbsenceDeduction(30_000, 2)
    assert.ok(gross - deduction > 0)
    assert.ok(gross - deduction < gross)
  })
})

describe('lateOrEarlyDeductionAmount', () => {
  it('prices only the minutes past grace, at the hourly wage', () => {
    // hourlyWage 125/hr, 6 minutes past grace: 125/60 * 6 = 12.5
    assert.equal(lateOrEarlyDeductionAmount(6, 125), 12.5)
  })

  it('is 0 when nothing was past grace', () => {
    assert.equal(lateOrEarlyDeductionAmount(0, 125), 0)
  })

  it('is 0 when the hourly wage is unpriceable', () => {
    assert.equal(lateOrEarlyDeductionAmount(6, 0), 0)
  })
})

describe('round2', () => {
  it('rounds to satang', () => {
    assert.equal(round2(30_000 / 30 * 16), 16_000)
    assert.equal(round2(1 / 3), 0.33)
  })
})
