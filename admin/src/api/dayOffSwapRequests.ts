import type {
  DayOffSwapRequestDetailResponse,
  DayOffSwapRequestListItem,
  DayOffSwapRequestListResponse,
  DayOffSwapRequestStatus,
} from '@hrm/shared'
import { apiFetch, jsonHeaders, unwrap } from './client'

export async function listDayOffSwapRequests(
  status?: DayOffSwapRequestStatus,
  signal?: AbortSignal
): Promise<DayOffSwapRequestListItem[]> {
  const query = status ? `?status=${status}` : ''
  const res = await apiFetch(`/api/day-off-swap-requests${query}`, { signal })
  const body = await unwrap<DayOffSwapRequestListResponse>(res)
  return body.requests
}

/** The caller's own inbox — mirrors listLeaveRequestsPendingApproval. */
export async function listDayOffSwapRequestsPendingApproval(
  signal?: AbortSignal
): Promise<DayOffSwapRequestListItem[]> {
  const res = await apiFetch(`/api/day-off-swap-requests/pending-approval`, { signal })
  const body = await unwrap<DayOffSwapRequestListResponse>(res)
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
