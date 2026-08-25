import type {
  TimeCorrectionDetailResponse,
  TimeCorrectionListItem,
  TimeCorrectionListResponse,
  TimeCorrectionStatus,
} from '@hrm/shared'
import { apiFetch, jsonHeaders, unwrap } from './client'

export async function listTimeCorrections(
  status?: TimeCorrectionStatus,
  signal?: AbortSignal
): Promise<TimeCorrectionListItem[]> {
  const query = status ? `?status=${status}` : ''
  const res = await apiFetch(`/api/time-corrections${query}`, { signal })
  const body = await unwrap<TimeCorrectionListResponse>(res)
  return body.requests
}

/** The caller's own inbox — mirrors listLeaveRequestsPendingApproval. */
export async function listTimeCorrectionsPendingApproval(
  signal?: AbortSignal
): Promise<TimeCorrectionListItem[]> {
  const res = await apiFetch(`/api/time-corrections/pending-approval`, { signal })
  const body = await unwrap<TimeCorrectionListResponse>(res)
  return body.requests
}

export async function getTimeCorrection(
  id: number,
  signal?: AbortSignal
): Promise<{ request: TimeCorrectionListItem; canDecide: boolean }> {
  const res = await apiFetch(`/api/time-corrections/${id}`, { signal })
  return unwrap<TimeCorrectionDetailResponse>(res)
}

export async function approveTimeCorrection(
  id: number
): Promise<{ request: TimeCorrectionListItem; canDecide: boolean }> {
  const res = await apiFetch(`/api/time-corrections/${id}/approve`, { method: 'POST' })
  return unwrap<TimeCorrectionDetailResponse>(res)
}

export async function rejectTimeCorrection(
  id: number,
  reason: string
): Promise<{ request: TimeCorrectionListItem; canDecide: boolean }> {
  const res = await apiFetch(`/api/time-corrections/${id}/reject`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ reason }),
  })
  return unwrap<TimeCorrectionDetailResponse>(res)
}
