// The LIFF "รออนุมัติจากฉัน" inbox: one combined view across all 5 request
// types for a supervisor, distinct from admin/'s per-resource review queues.
// Reads the existing pending-approval/decided-by-supervisor query functions
// directly rather than going through their HTTP routes (those stay
// admin-only) — no resolveSupervisorScope needed either, since the caller's
// employeeId is already known from their LINE session, unlike an admin
// account which has to be resolved from its Entra UPN first.

import { Router } from 'express'
import type { Request, Response } from 'express'
import type {
  DayOffSwapRequestListItem,
  LeaveRequestListItem,
  OvertimeRequestListItem,
  PendingApprovalItem,
  PendingApprovalsResponse,
  ShiftChangeRequestListItem,
  TimeCorrectionListItem,
} from '@hrm/shared'
import { fail, handleUnexpected } from '../http.js'
import { listLeaveRequestsPendingApproval, listLeaveRequestsDecidedBySupervisor } from '../leaveRequestQueries.js'
import {
  listOvertimeRequestsPendingApproval,
  listOvertimeRequestsDecidedBySupervisor,
} from '../overtimeRequestQueries.js'
import {
  listShiftChangeRequestsPendingApproval,
  listShiftChangeRequestsDecidedBySupervisor,
} from '../shiftChangeRequestQueries.js'
import {
  listDayOffSwapRequestsPendingApproval,
  listDayOffSwapRequestsDecidedBySupervisor,
} from '../dayOffSwapRequestQueries.js'
import {
  listTimeCorrectionsPendingApproval,
  listTimeCorrectionsDecidedBySupervisor,
} from '../timeCorrectionQueries.js'

export const approvalsRouter = Router()

/** One resource's list, still tagged with which resource it came from — the
 *  discriminated-union pairing PendingApprovalItem needs, which a single
 *  generic type parameter across all 5 (structurally different) resources
 *  cannot express without TypeScript collapsing them to one inferred type. */
export type ApprovalGroup =
  | readonly ['leave', ReadonlyArray<LeaveRequestListItem>]
  | readonly ['overtime', ReadonlyArray<OvertimeRequestListItem>]
  | readonly ['shiftChange', ReadonlyArray<ShiftChangeRequestListItem>]
  | readonly ['dayOffSwap', ReadonlyArray<DayOffSwapRequestListItem>]
  | readonly ['timeCorrection', ReadonlyArray<TimeCorrectionListItem>]

/** Tags each resource's list with its resourceType and merges all 5 into one
 *  list, most recent first — createdAt for the pending tab, decidedAt (falling
 *  back to createdAt, since a stale/never-decided row has none) for the done
 *  tab. Exported as a pure function so it's unit-testable without a DB. */
export function mergeApprovalItems(
  groups: ReadonlyArray<ApprovalGroup>,
  sortBy: 'createdAt' | 'decidedAt' = 'createdAt'
): PendingApprovalItem[] {
  const items: PendingApprovalItem[] = groups.flatMap(([resourceType, requests]): PendingApprovalItem[] => {
    switch (resourceType) {
      case 'leave':
        return requests.map((request): PendingApprovalItem => ({ resourceType, request }))
      case 'overtime':
        return requests.map((request): PendingApprovalItem => ({ resourceType, request }))
      case 'shiftChange':
        return requests.map((request): PendingApprovalItem => ({ resourceType, request }))
      case 'dayOffSwap':
        return requests.map((request): PendingApprovalItem => ({ resourceType, request }))
      case 'timeCorrection':
        return requests.map((request): PendingApprovalItem => ({ resourceType, request }))
    }
  })
  return items.sort((a, b) => {
    const key = (item: PendingApprovalItem): string =>
      (sortBy === 'decidedAt' ? item.request.decidedAt : null) ?? item.request.createdAt
    return key(b).localeCompare(key(a))
  })
}

approvalsRouter.get('/approvals/pending-for-me', async (req: Request, res: Response) => {
  const auth = req.auth
  if (!auth) return fail(res, 500, 'server misconfigured')
  if (auth.kind !== 'employee') {
    return fail(res, 403, 'this endpoint is for employee accounts', 'FORBIDDEN')
  }

  try {
    const id = auth.employeeId
    const [
      leavePending,
      otPending,
      shiftPending,
      swapPending,
      correctionPending,
      leaveDone,
      otDone,
      shiftDone,
      swapDone,
      correctionDone,
    ] = await Promise.all([
      listLeaveRequestsPendingApproval(id),
      listOvertimeRequestsPendingApproval(id),
      listShiftChangeRequestsPendingApproval(id),
      listDayOffSwapRequestsPendingApproval(id),
      listTimeCorrectionsPendingApproval(id),
      listLeaveRequestsDecidedBySupervisor(id),
      listOvertimeRequestsDecidedBySupervisor(id),
      listShiftChangeRequestsDecidedBySupervisor(id),
      listDayOffSwapRequestsDecidedBySupervisor(id),
      listTimeCorrectionsDecidedBySupervisor(id),
    ])

    const body: PendingApprovalsResponse = {
      pending: mergeApprovalItems(
        [
          ['leave', leavePending],
          ['overtime', otPending],
          ['shiftChange', shiftPending],
          ['dayOffSwap', swapPending],
          ['timeCorrection', correctionPending],
        ],
        'createdAt'
      ),
      done: mergeApprovalItems(
        [
          ['leave', leaveDone],
          ['overtime', otDone],
          ['shiftChange', shiftDone],
          ['dayOffSwap', swapDone],
          ['timeCorrection', correctionDone],
        ],
        'decidedAt'
      ),
    }
    res.json(body)
  } catch (err) {
    handleUnexpected(res, err)
  }
})
