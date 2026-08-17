import type {
  OvertimeRequestDetailResponse,
  OvertimeRequestListItem,
  OvertimeRequestListResponse,
  OvertimeRequestStatus,
} from '@hrm/shared'
import { apiFetch, jsonHeaders, unwrap } from './client'

export async function listOvertimeRequests(
  status?: OvertimeRequestStatus,
  signal?: AbortSignal
): Promise<OvertimeRequestListItem[]> {
  const query = status ? `?status=${status}` : ''
  const res = await apiFetch(`/api/overtime-requests${query}`, { signal })
  const body = await unwrap<OvertimeRequestListResponse>(res)
  return body.requests
}

export async function getOvertimeRequest(
  id: number,
  signal?: AbortSignal
): Promise<OvertimeRequestListItem> {
  const res = await apiFetch(`/api/overtime-requests/${id}`, { signal })
  const body = await unwrap<OvertimeRequestDetailResponse>(res)
  return body.request
}

export async function approveOvertimeRequest(id: number): Promise<OvertimeRequestListItem> {
  const res = await apiFetch(`/api/overtime-requests/${id}/approve`, { method: 'POST' })
  const body = await unwrap<OvertimeRequestDetailResponse>(res)
  return body.request
}

export async function rejectOvertimeRequest(
  id: number,
  reason: string
): Promise<OvertimeRequestListItem> {
  const res = await apiFetch(`/api/overtime-requests/${id}/reject`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ reason }),
  })
  const body = await unwrap<OvertimeRequestDetailResponse>(res)
  return body.request
}
