import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import type { LeaveRequestListItem, OvertimeRequestListItem } from '@hrm/shared'
import { mergeApprovalItems, type ApprovalGroup } from './approvals.js'

// Only createdAt/decidedAt/id matter to the sort/tag logic under test — the
// rest of each real *ListItem shape is irrelevant here, so a cast stands in
// for a full fixture rather than constructing 15+ unrelated fields per item.
function leaveGroup(items: ReadonlyArray<{ id: number; createdAt: string; decidedAt?: string | null }>): ApprovalGroup {
  return ['leave', items as unknown as ReadonlyArray<LeaveRequestListItem>]
}
function overtimeGroup(items: ReadonlyArray<{ id: number; createdAt: string; decidedAt?: string | null }>): ApprovalGroup {
  return ['overtime', items as unknown as ReadonlyArray<OvertimeRequestListItem>]
}

describe('mergeApprovalItems', () => {
  it('tags each group with its resourceType and interleaves them by createdAt, most recent first', () => {
    const merged = mergeApprovalItems([
      leaveGroup([{ id: 1, createdAt: '2026-08-19T10:00:00.000Z' }]),
      overtimeGroup([{ id: 2, createdAt: '2026-08-20T09:00:00.000Z' }]),
      leaveGroup([{ id: 3, createdAt: '2026-08-19T20:00:00.000Z' }]),
    ])

    assert.deepEqual(
      merged.map((item) => [item.resourceType, (item.request as unknown as { id: number }).id]),
      [
        ['overtime', 2],
        ['leave', 3],
        ['leave', 1],
      ]
    )
  })

  it('sorts by decidedAt (falling back to createdAt) when asked, for the done tab', () => {
    const merged = mergeApprovalItems(
      [
        leaveGroup([{ id: 1, createdAt: '2026-08-18T00:00:00.000Z', decidedAt: '2026-08-19T00:00:00.000Z' }]),
        overtimeGroup([{ id: 2, createdAt: '2026-08-20T00:00:00.000Z', decidedAt: null }]),
      ],
      'decidedAt'
    )

    // id 2 has no decidedAt, so it falls back to its createdAt (2026-08-20),
    // which still sorts after id 1's decidedAt (2026-08-19).
    assert.deepEqual(
      merged.map((item) => (item.request as unknown as { id: number }).id),
      [2, 1]
    )
  })

  it('returns an empty list when every group is empty', () => {
    assert.deepEqual(mergeApprovalItems([leaveGroup([]), overtimeGroup([])]), [])
  })
})
