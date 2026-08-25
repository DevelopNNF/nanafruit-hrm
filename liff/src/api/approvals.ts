import type { ApprovalResourceType, PendingApprovalItem, PendingApprovalsResponse } from '@hrm/shared'
import { apiFetch, jsonHeaders, unwrap } from './client'

export async function fetchPendingApprovals(signal?: AbortSignal): Promise<PendingApprovalsResponse> {
  const res = await apiFetch('/api/approvals/pending-for-me', { signal })
  return unwrap<PendingApprovalsResponse>(res)
}

// Maps each resource to the URL segment its own router mounts under — see
// server/src/index.ts. Kept here (not in @hrm/shared) since it's an HTTP
// routing detail, not a domain fact liff/admin both need.
const RESOURCE_PATH: Record<ApprovalResourceType, string> = {
  leave: 'leave-requests',
  overtime: 'overtime-requests',
  shiftChange: 'shift-change-requests',
  dayOffSwap: 'day-off-swap-requests',
  timeCorrection: 'time-corrections',
}

/** Approving asks for no reason (see ApprovalRejectModal's comment for why
 *  rejecting does) — just a plain confirm, so no body beyond an empty
 *  object; none of the 5 approve endpoints read one either way. */
export async function approveApprovalItem(item: PendingApprovalItem): Promise<void> {
  const res = await apiFetch(`/api/${RESOURCE_PATH[item.resourceType]}/${item.request.id}/approve`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({}),
  })
  if (!res.ok) await unwrap<never>(res)
}

export async function rejectApprovalItem(item: PendingApprovalItem, reason: string): Promise<void> {
  const res = await apiFetch(`/api/${RESOURCE_PATH[item.resourceType]}/${item.request.id}/reject`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ reason }),
  })
  if (!res.ok) await unwrap<never>(res)
}
