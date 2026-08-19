// The period window is the one number every later phase divides by, and it is
// the one people get wrong: a 26th-to-25th cycle is not a month, and it is not
// 30 days. These tests exist mostly to make that impossible to forget.

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import {
  canTransition,
  derivePeriodWindow,
  isEditableStatus,
  lastDayOfMonth,
  parsePeriodCode,
  windowDayCount,
  type PeriodCycle,
} from './payrollPeriod.js'

/** Nanafruit's own cycle: cut off on the 25th, pay on the last day. */
const NANAFRUIT: PeriodCycle = {
  cutoffDay: 25,
  payDayRule: 'last_day_of_month',
  payDayOfMonth: null,
}

function windowOf(periodCode: string, cycle: PeriodCycle = NANAFRUIT) {
  const window = derivePeriodWindow(periodCode, cycle)
  assert.ok(window, `expected a window for ${periodCode}`)
  return window
}

describe('derivePeriodWindow', () => {
  it('runs from the day after the previous cut-off to this month\u2019s', () => {
    assert.deepEqual(windowOf('2026-08'), {
      periodStart: '2026-07-26',
      periodEnd: '2026-08-25',
      payDate: '2026-08-31',
    })
  })

  it('rolls back into the previous year for January', () => {
    assert.deepEqual(windowOf('2026-01'), {
      periodStart: '2025-12-26',
      periodEnd: '2026-01-25',
      payDate: '2026-01-31',
    })
  })

  it('leaves no gap and no overlap between consecutive periods', () => {
    // The day after one period ends is the day the next one starts. If this
    // ever stops holding, a day of work belongs to no period at all — or to
    // two, which the table's EXCLUDE constraint would then reject.
    const july = windowOf('2026-07')
    const august = windowOf('2026-08')
    assert.equal(july.periodEnd, '2026-07-25')
    assert.equal(august.periodStart, '2026-07-26')
  })
})

describe('windowDayCount', () => {
  // The reason Phase 2 cannot divide by "the length of the period": on this
  // cycle 2026 has seven 31-day periods, four 30-day ones, and a 28-day March.
  // An employee who works a whole period is owed a whole salary in all three.
  it('is 31 days for most periods', () => {
    assert.equal(windowDayCount(windowOf('2026-08')), 31)
  })

  it('is 30 days when the previous month is short', () => {
    assert.equal(windowDayCount(windowOf('2026-05')), 30)
  })

  it('is 28 days for the March period', () => {
    assert.equal(windowDayCount(windowOf('2026-03')), 28)
  })

  it('is 29 days for the March period of a leap year', () => {
    const window = windowOf('2028-03')
    assert.equal(window.periodStart, '2028-02-26')
    assert.equal(windowDayCount(window), 29)
  })
})

describe('derivePeriodWindow with a fixed pay day', () => {
  it('pays on that day of the period month', () => {
    const cycle: PeriodCycle = { cutoffDay: 20, payDayRule: 'fixed_day', payDayOfMonth: 28 }
    assert.equal(windowOf('2026-08', cycle).payDate, '2026-08-28')
  })

  it('never pays before the period ends', () => {
    // A pay day earlier than the cut-off is a misconfigured group. Clamping
    // keeps it out of the table's pay_date >= period_end CHECK, which would
    // otherwise surface as a 500 when HR creates the period.
    const cycle: PeriodCycle = { cutoffDay: 25, payDayRule: 'fixed_day', payDayOfMonth: 5 }
    assert.equal(windowOf('2026-08', cycle).payDate, '2026-08-25')
  })

  it('never invents a day the month does not have', () => {
    const cycle: PeriodCycle = { cutoffDay: 20, payDayRule: 'fixed_day', payDayOfMonth: 31 }
    assert.equal(windowOf('2026-02', cycle).payDate, '2026-02-28')
  })
})

describe('parsePeriodCode', () => {
  it('accepts a well-formed code', () => {
    assert.deepEqual(parsePeriodCode('2026-08'), { year: 2026, month: 8 })
  })

  it('rejects anything else', () => {
    for (const bad of ['2026-13', '2026-00', '2026-8', '26-08', '2026/08', '', 'ส.ค.']) {
      assert.equal(parsePeriodCode(bad), null, `expected ${bad} to be rejected`)
    }
  })

  it('is what derivePeriodWindow refuses on', () => {
    assert.equal(derivePeriodWindow('2026-13', NANAFRUIT), null)
  })
})

describe('lastDayOfMonth', () => {
  it('knows the short months', () => {
    assert.equal(lastDayOfMonth(2026, 2), 28)
    assert.equal(lastDayOfMonth(2028, 2), 29)
    assert.equal(lastDayOfMonth(2026, 4), 30)
    assert.equal(lastDayOfMonth(2026, 12), 31)
  })
})

describe('canTransition', () => {
  it('allows the forward path through the run', () => {
    assert.ok(canTransition('draft', 'calculating'))
    assert.ok(canTransition('calculating', 'review'))
    assert.ok(canTransition('review', 'approved'))
    assert.ok(canTransition('approved', 'paid'))
    assert.ok(canTransition('paid', 'closed'))
  })

  it('allows voiding up to the point money moves', () => {
    assert.ok(canTransition('draft', 'voided'))
    assert.ok(canTransition('review', 'voided'))
    assert.ok(canTransition('approved', 'voided'))
  })

  it('refuses to void a period that has been paid', () => {
    // The fix for a wrong payment is another payment, recorded — not a period
    // that stops existing after the money left.
    assert.equal(canTransition('paid', 'voided'), false)
    assert.equal(canTransition('closed', 'voided'), false)
  })

  it('refuses to reopen a closed or voided period', () => {
    assert.equal(canTransition('closed', 'draft'), false)
    assert.equal(canTransition('closed', 'paid'), false)
    assert.equal(canTransition('voided', 'draft'), false)
  })

  it('refuses to skip a step', () => {
    assert.equal(canTransition('draft', 'approved'), false)
    assert.equal(canTransition('draft', 'paid'), false)
    assert.equal(canTransition('review', 'paid'), false)
  })
})

describe('isEditableStatus', () => {
  it('is draft and nothing else', () => {
    assert.ok(isEditableStatus('draft'))
    for (const status of ['calculating', 'review', 'approved', 'paid', 'closed', 'voided'] as const) {
      assert.equal(isEditableStatus(status), false, `${status} must not be editable`)
    }
  })
})
