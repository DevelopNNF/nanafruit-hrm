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

export async function getDayOffSwapRequest(
  id: number,
  signal?: AbortSignal
): Promise<DayOffSwapRequestListItem> {
  const res = await apiFetch(`/api/day-off-swap-requests/${id}`, { signal })
  const body = await unwrap<DayOffSwapRequestDetailResponse>(res)
  return body.request
}

export async function approveDayOffSwapRequest(id: number): Promise<DayOffSwapRequestListItem> {
  const res = await apiFetch(`/api/day-off-swap-requests/${id}/approve`, { method: 'POST' })
  const body = await unwrap<DayOffSwapRequestDetailResponse>(res)
  return body.request
}

export async function rejectDayOffSwapRequest(id: number, reason: string): Promise<DayOffSwapRequestListItem> {
  const res = await apiFetch(`/api/day-off-swap-requests/${id}/reject`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ reason }),
  })
  const body = await unwrap<DayOffSwapRequestDetailResponse>(res)
  return body.request
}
