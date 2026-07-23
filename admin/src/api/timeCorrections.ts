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

export async function getTimeCorrection(id: number, signal?: AbortSignal): Promise<TimeCorrectionListItem> {
  const res = await apiFetch(`/api/time-corrections/${id}`, { signal })
  const body = await unwrap<TimeCorrectionDetailResponse>(res)
  return body.request
}

export async function approveTimeCorrection(id: number): Promise<TimeCorrectionListItem> {
  const res = await apiFetch(`/api/time-corrections/${id}/approve`, { method: 'POST' })
  const body = await unwrap<TimeCorrectionDetailResponse>(res)
  return body.request
}

export async function rejectTimeCorrection(id: number, reason: string): Promise<TimeCorrectionListItem> {
  const res = await apiFetch(`/api/time-corrections/${id}/reject`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ reason }),
  })
  const body = await unwrap<TimeCorrectionDetailResponse>(res)
  return body.request
}
