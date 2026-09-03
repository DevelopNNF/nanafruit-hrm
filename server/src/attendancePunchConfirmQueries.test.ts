import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { PayrollPeriodStatus } from '@hrm/shared'
import { buildCandidateList, isPeriodLockedForEdit, type RawPunch } from './attendancePunchConfirmQueries.js'

function punch(id: number): RawPunch {
  return { id, eventType: 'check_in', eventTime: '2026-08-01T01:00:00.000Z', source: 'fingerprint_import' }
}

describe('buildCandidateList', () => {
  it('drops a punch that is already this exact work-date\'s own pick', () => {
    const events = [punch(1), punch(2), punch(3)]
    const owners = new Map([[2, '2026-08-02']])
    const result = buildCandidateList(events, owners, '2026-08-02')
    assert.deepEqual(result.map((e) => e.id), [1, 3])
  })

  it('keeps a punch claimed by a neighbouring work-date, annotated with that date', () => {
    // The overnight-shift case: a punch that lands inside the *next* day's
    // own shift window and gets claimed there must still be offered here so
    // it can be reassigned back to the shift it actually belongs to.
    const events = [punch(1)]
    const owners = new Map([[1, '2026-08-03']])
    const result = buildCandidateList(events, owners, '2026-08-02')
    assert.deepEqual(result, [{ ...punch(1), claimedByWorkDate: '2026-08-03' }])
  })

  it('annotates an unclaimed punch with null', () => {
    const events = [punch(1)]
    const result = buildCandidateList(events, new Map(), '2026-08-02')
    assert.equal(result[0]?.claimedByWorkDate, null)
  })
})

describe('isPeriodLockedForEdit', () => {
  it('allows editing when no period covers the date', () => {
    assert.equal(isPeriodLockedForEdit(null), false)
  })

  it('allows editing while the period is still draft or calculating', () => {
    assert.equal(isPeriodLockedForEdit('draft'), false)
    assert.equal(isPeriodLockedForEdit('calculating'), false)
  })

  it('blocks editing once the period has moved past calculating', () => {
    const locked: PayrollPeriodStatus[] = ['review', 'approved', 'paid', 'closed']
    for (const status of locked) {
      assert.equal(isPeriodLockedForEdit(status), true, `expected ${status} to be locked`)
    }
  })

  // resolvePayrollPeriodStatus's own query excludes status = 'voided', so this
  // is a defensive case that should never actually reach here — but the
  // function stays fail-safe (locked, not open) if it ever did.
  it('treats an unexpected voided status as locked rather than open', () => {
    assert.equal(isPeriodLockedForEdit('voided'), true)
  })
})
