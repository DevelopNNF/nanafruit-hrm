import type {
  DayOffSwapRequestDetailResponse,
  DayOffSwapRequestListItem,
  DayOffSwapRequestListResponse,
  DayOffSwapRequestPendingApprovalResponse,
  DayOffSwapRequestStatus,
} from '@hrm/shared'
import { apiFetch, jsonHeaders, unwrap } from './client'

export async function listDayOffSwapRequests(
  status?: DayOffSwapRequestStatus,
  pagination: { page?: number; pageSize?: number } = {},
  signal?: AbortSignal
): Promise<DayOffSwapRequestListResponse> {
  const params = new URLSearchParams()
  if (status) params.set('status', status)
  if (pagination.page !== undefined) params.set('page', String(pagination.page))
  if (pagination.pageSize !== undefined) params.set('pageSize', String(pagination.pageSize))
  const qs = params.toString()
  const res = await apiFetch(`/api/day-off-swap-requests${qs ? `?${qs}` : ''}`, { signal })
  return unwrap<DayOffSwapRequestListResponse>(res)
}

/** The caller's own inbox — mirrors listLeaveRequestsPendingApproval. */
export async function listDayOffSwapRequestsPendingApproval(
  signal?: AbortSignal
): Promise<DayOffSwapRequestListItem[]> {
  const res = await apiFetch(`/api/day-off-swap-requests/pending-approval`, { signal })
  const body = await unwrap<DayOffSwapRequestPendingApprovalResponse>(res)
  return body.requests
}

export async function getDayOffSwapRequest(
  id: number,
  signal?: AbortSignal
): Promise<{ request: DayOffSwapRequestListItem; canDecide: boolean }> {
  const res = await apiFetch(`/api/day-off-swap-requests/${id}`, { signal })
  return unwrap<DayOffSwapRequestDetailResponse>(res)
}

export async function approveDayOffSwapRequest(
  id: number
): Promise<{ request: DayOffSwapRequestListItem; canDecide: boolean }> {
  const res = await apiFetch(`/api/day-off-swap-requests/${id}/approve`, { method: 'POST' })
  return unwrap<DayOffSwapRequestDetailResponse>(res)
}

export async function rejectDayOffSwapRequest(
  id: number,
  reason: string
): Promise<{ request: DayOffSwapRequestListItem; canDecide: boolean }> {
  const res = await apiFetch(`/api/day-off-swap-requests/${id}/reject`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ reason }),
  })
  return unwrap<DayOffSwapRequestDetailResponse>(res)
}
