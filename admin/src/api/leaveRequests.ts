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

export async function getLeaveRequest(id: number, signal?: AbortSignal): Promise<LeaveRequestListItem> {
  const res = await apiFetch(`/api/leave-requests/${id}`, { signal })
  const body = await unwrap<LeaveRequestDetailResponse>(res)
  return body.request
}

export async function approveLeaveRequest(id: number): Promise<LeaveRequestListItem> {
  const res = await apiFetch(`/api/leave-requests/${id}/approve`, { method: 'POST' })
  const body = await unwrap<LeaveRequestDetailResponse>(res)
  return body.request
}

export async function rejectLeaveRequest(id: number, reason: string): Promise<LeaveRequestListItem> {
  const res = await apiFetch(`/api/leave-requests/${id}/reject`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ reason }),
  })
  const body = await unwrap<LeaveRequestDetailResponse>(res)
  return body.request
}
