import type {
  CompTimeOffRequestDetailResponse,
  CompTimeOffRequestListItem,
  CompTimeOffRequestListResponse,
  CompTimeOffRequestPendingApprovalResponse,
  CompTimeOffRequestStatus,
} from '@hrm/shared'
import { apiFetch, jsonHeaders, unwrap } from './client'

export async function listCompTimeOffRequests(
  status?: CompTimeOffRequestStatus,
  pagination: { page?: number; pageSize?: number } = {},
  signal?: AbortSignal
): Promise<CompTimeOffRequestListResponse> {
  const params = new URLSearchParams()
  if (status) params.set('status', status)
  if (pagination.page !== undefined) params.set('page', String(pagination.page))
  if (pagination.pageSize !== undefined) params.set('pageSize', String(pagination.pageSize))
  const qs = params.toString()
  const res = await apiFetch(`/api/comp-time-off-requests${qs ? `?${qs}` : ''}`, { signal })
  return unwrap<CompTimeOffRequestListResponse>(res)
}

/** The caller's own inbox: requests currently waiting on them as a
 *  supervisor, or — for HR/Admin — every request currently waiting on any
 *  supervisor. Empty rather than an error for an account that isn't anyone's
 *  supervisor. */
export async function listCompTimeOffRequestsPendingApproval(
  signal?: AbortSignal
): Promise<CompTimeOffRequestListItem[]> {
  const res = await apiFetch(`/api/comp-time-off-requests/pending-approval`, { signal })
  const body = await unwrap<CompTimeOffRequestPendingApprovalResponse>(res)
  return body.requests
}

export async function getCompTimeOffRequest(
  id: number,
  signal?: AbortSignal
): Promise<{ request: CompTimeOffRequestListItem; canDecide: boolean }> {
  const res = await apiFetch(`/api/comp-time-off-requests/${id}`, { signal })
  return unwrap<CompTimeOffRequestDetailResponse>(res)
}

export async function approveCompTimeOffRequest(
  id: number
): Promise<{ request: CompTimeOffRequestListItem; canDecide: boolean }> {
  const res = await apiFetch(`/api/comp-time-off-requests/${id}/approve`, { method: 'POST' })
  return unwrap<CompTimeOffRequestDetailResponse>(res)
}

export async function rejectCompTimeOffRequest(
  id: number,
  reason: string
): Promise<{ request: CompTimeOffRequestListItem; canDecide: boolean }> {
  const res = await apiFetch(`/api/comp-time-off-requests/${id}/reject`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ reason }),
  })
  return unwrap<CompTimeOffRequestDetailResponse>(res)
}
