import type {
  LeaveRequest,
  LeaveRequestInput,
  LeaveRequestMineResponse,
  LeaveRequestResponse,
} from '@hrm/shared'
import { apiFetch, jsonHeaders, unwrap } from './client'

export async function submitLeaveRequest(input: LeaveRequestInput): Promise<LeaveRequest> {
  const res = await apiFetch('/api/leave-requests', {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify(input),
  })
  const body = await unwrap<LeaveRequestResponse>(res)
  return body.request
}

export async function fetchMyLeaveRequests(signal?: AbortSignal): Promise<LeaveRequest[]> {
  const res = await apiFetch('/api/leave-requests/me', { signal })
  const body = await unwrap<LeaveRequestMineResponse>(res)
  return body.requests
}

export async function cancelLeaveRequest(id: number): Promise<LeaveRequest> {
  const res = await apiFetch(`/api/leave-requests/${id}/cancel`, { method: 'POST' })
  const body = await unwrap<LeaveRequestResponse>(res)
  return body.request
}
