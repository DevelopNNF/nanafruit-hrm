// addDays is what closes an interval the day before the next one opens, in
// both createShiftChange and createWageChange. An off-by-one here leaves
// either a one-day gap with no wage on file or a one-day overlap that the
// EXCLUDE constraint rejects, so the month boundaries are worth pinning.

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { addDays, toThailandDateString } from './shiftAssignmentQueries.js'

describe('addDays', () => {
  it('steps back across a month boundary', () => {
    assert.equal(addDays('2026-03-01', -1), '2026-02-28')
  })

  it('knows February has 29 days in a leap year', () => {
    assert.equal(addDays('2028-03-01', -1), '2028-02-29')
  })

  it('steps forward across a year boundary', () => {
    assert.equal(addDays('2026-12-31', 1), '2027-01-01')
  })

  it('steps forward across a month boundary', () => {
    assert.equal(addDays('2026-01-31', 1), '2026-02-01')
  })

  it('returns the same date for zero', () => {
    assert.equal(addDays('2026-08-18', 0), '2026-08-18')
  })
})

describe('toThailandDateString', () => {
  it('is still the previous day in UTC late in a Thai evening', () => {
    // 18:30 UTC on the 17th is 01:30 on the 18th in Bangkok. Reading the
    // instant in UTC would date a clock-in to the wrong day.
    assert.equal(toThailandDateString(new Date('2026-08-17T18:30:00Z')), '2026-08-18')
  })

  it('agrees with UTC in the middle of a Thai afternoon', () => {
    assert.equal(toThailandDateString(new Date('2026-08-18T07:00:00Z')), '2026-08-18')
  })
})
