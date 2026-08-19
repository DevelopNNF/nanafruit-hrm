// The first tests in this repo. Kept to what is genuinely pure: hourlyWage
// takes numbers and returns a number, so it can be pinned down completely
// without a database anywhere near it.
//
// This matters more than the size of the function suggests. Every payroll
// phase after this one prices off the figure it returns — overtime already
// does — and Labour Protection Act s.68's "divide a monthly wage by 30" is
// exactly the kind of rule that looks like a typo to whoever reads it next.

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { hourlyWage } from './wageRate.js'

describe('hourlyWage', () => {
  it('divides a monthly wage by 30, not by the days in the month', () => {
    // 30,000 / 30 = 1,000 a day; over an 8-hour shift that is 125 an hour.
    // Dividing the month straight by its working hours would give ~170 and
    // underpay every hour of overtime priced off it.
    assert.equal(hourlyWage({ wageType: 'monthly', wageAmount: 30_000, shiftWorkMinutes: 480 }), 125)
  })

  it('treats a daily wage as already daily', () => {
    assert.equal(hourlyWage({ wageType: 'daily', wageAmount: 500, shiftWorkMinutes: 480 }), 62.5)
  })

  it('prices a shorter shift higher on the same salary', () => {
    // 7.5 hours of normal work for the same 1,000 a day. The shift is the
    // employee's own, not a company-wide constant, which is the whole reason
    // shiftWorkMinutes is a parameter.
    const short = hourlyWage({ wageType: 'monthly', wageAmount: 30_000, shiftWorkMinutes: 450 })
    const long = hourlyWage({ wageType: 'monthly', wageAmount: 30_000, shiftWorkMinutes: 480 })
    assert.ok(short !== null && long !== null)
    assert.ok(short > long)
    assert.equal(Math.round(short * 100) / 100, 133.33)
  })

  it('returns null when no shift applied, rather than dividing by zero', () => {
    assert.equal(
      hourlyWage({ wageType: 'monthly', wageAmount: 30_000, shiftWorkMinutes: null }),
      null
    )
    assert.equal(hourlyWage({ wageType: 'monthly', wageAmount: 30_000, shiftWorkMinutes: 0 }), null)
  })

  it('returns null for an unset wage, which is a question and not a rate of nothing', () => {
    assert.equal(hourlyWage({ wageType: 'monthly', wageAmount: 0, shiftWorkMinutes: 480 }), null)
  })
})
