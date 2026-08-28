import type {
  OffSiteWorkRequestDetailResponse,
  OffSiteWorkRequestListItem,
  OffSiteWorkRequestListResponse,
  OffSiteWorkRequestPendingApprovalResponse,
  OffSiteWorkRequestStatus,
} from '@hrm/shared'
import { apiFetch, jsonHeaders, unwrap } from './client'

export async function listOffSiteWorkRequests(
  status?: OffSiteWorkRequestStatus,
  pagination: { page?: number; pageSize?: number } = {},
  signal?: AbortSignal
): Promise<OffSiteWorkRequestListResponse> {
  const params = new URLSearchParams()
  if (status) params.set('status', status)
  if (pagination.page !== undefined) params.set('page', String(pagination.page))
  if (pagination.pageSize !== undefined) params.set('pageSize', String(pagination.pageSize))
  const qs = params.toString()
  const res = await apiFetch(`/api/off-site-work-requests${qs ? `?${qs}` : ''}`, { signal })
  return unwrap<OffSiteWorkRequestListResponse>(res)
}

/** The caller's own inbox: requests currently waiting on them as a
 *  supervisor, or — for HR/Admin — every request currently waiting on any
 *  supervisor. Empty rather than an error for an account that isn't anyone's
 *  supervisor. */
export async function listOffSiteWorkRequestsPendingApproval(
  signal?: AbortSignal
): Promise<OffSiteWorkRequestListItem[]> {
  const res = await apiFetch(`/api/off-site-work-requests/pending-approval`, { signal })
  const body = await unwrap<OffSiteWorkRequestPendingApprovalResponse>(res)
  return body.requests
}

export async function getOffSiteWorkRequest(
  id: number,
  signal?: AbortSignal
): Promise<{ request: OffSiteWorkRequestListItem; canDecide: boolean }> {
  const res = await apiFetch(`/api/off-site-work-requests/${id}`, { signal })
  return unwrap<OffSiteWorkRequestDetailResponse>(res)
}

export async function approveOffSiteWorkRequest(
  id: number
): Promise<{ request: OffSiteWorkRequestListItem; canDecide: boolean }> {
  const res = await apiFetch(`/api/off-site-work-requests/${id}/approve`, { method: 'POST' })
  return unwrap<OffSiteWorkRequestDetailResponse>(res)
}

export async function rejectOffSiteWorkRequest(
  id: number,
  reason: string
): Promise<{ request: OffSiteWorkRequestListItem; canDecide: boolean }> {
  const res = await apiFetch(`/api/off-site-work-requests/${id}/reject`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ reason }),
  })
  return unwrap<OffSiteWorkRequestDetailResponse>(res)
}
