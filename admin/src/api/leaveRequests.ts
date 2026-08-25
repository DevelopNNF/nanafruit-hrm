import type {
  LeaveRequestDetailResponse,
  LeaveRequestListItem,
  LeaveRequestListResponse,
  LeaveRequestStatus,
} from '@hrm/shared'
import { apiFetch, jsonHeaders, unwrap } from './client'

export async function listLeaveRequests(
  status?: LeaveRequestStatus,
  signal?: AbortSignal
): Promise<LeaveRequestListItem[]> {
  const query = status ? `?status=${status}` : ''
  const res = await apiFetch(`/api/leave-requests${query}`, { signal })
  const body = await unwrap<LeaveRequestListResponse>(res)
  return body.requests
}

/** The caller's own inbox: requests currently waiting on them as a
 *  supervisor, or — for HR/Admin — every request currently waiting on any
 *  supervisor. Empty rather than an error for an account that isn't anyone's
 *  supervisor. */
export async function listLeaveRequestsPendingApproval(signal?: AbortSignal): Promise<LeaveRequestListItem[]> {
  const res = await apiFetch(`/api/leave-requests/pending-approval`, { signal })
  const body = await unwrap<LeaveRequestListResponse>(res)
  return body.requests
}

export async function getLeaveRequest(
  id: number,
  signal?: AbortSignal
): Promise<{ request: LeaveRequestListItem; canDecide: boolean }> {
  const res = await apiFetch(`/api/leave-requests/${id}`, { signal })
  return unwrap<LeaveRequestDetailResponse>(res)
}

export async function approveLeaveRequest(
  id: number
): Promise<{ request: LeaveRequestListItem; canDecide: boolean }> {
  const res = await apiFetch(`/api/leave-requests/${id}/approve`, { method: 'POST' })
  return unwrap<LeaveRequestDetailResponse>(res)
}

export async function rejectLeaveRequest(
  id: number,
  reason: string
): Promise<{ request: LeaveRequestListItem; canDecide: boolean }> {
  const res = await apiFetch(`/api/leave-requests/${id}/reject`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ reason }),
  })
  return unwrap<LeaveRequestDetailResponse>(res)
}
