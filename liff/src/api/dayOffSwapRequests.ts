import type {
  DayOffSwapRequest,
  DayOffSwapRequestInput,
  DayOffSwapRequestMineResponse,
  DayOffSwapRequestResponse,
} from '@hrm/shared'
import { apiFetch, jsonHeaders, unwrap } from './client'

export async function submitDayOffSwapRequest(input: DayOffSwapRequestInput): Promise<DayOffSwapRequest> {
  const res = await apiFetch('/api/day-off-swap-requests', {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify(input),
  })
  const body = await unwrap<DayOffSwapRequestResponse>(res)
  return body.request
}

export async function updateDayOffSwapRequest(
  id: number,
  input: DayOffSwapRequestInput
): Promise<DayOffSwapRequest> {
  const res = await apiFetch(`/api/day-off-swap-requests/${id}`, {
    method: 'PUT',
    headers: jsonHeaders,
    body: JSON.stringify(input),
  })
  const body = await unwrap<DayOffSwapRequestResponse>(res)
  return body.request
}

export async function fetchMyDayOffSwapRequests(signal?: AbortSignal): Promise<DayOffSwapRequest[]> {
  const res = await apiFetch('/api/day-off-swap-requests/me', { signal })
  const body = await unwrap<DayOffSwapRequestMineResponse>(res)
  return body.requests
}

export async function cancelDayOffSwapRequest(id: number): Promise<DayOffSwapRequest> {
  const res = await apiFetch(`/api/day-off-swap-requests/${id}/cancel`, { method: 'POST' })
  const body = await unwrap<DayOffSwapRequestResponse>(res)
  return body.request
}
