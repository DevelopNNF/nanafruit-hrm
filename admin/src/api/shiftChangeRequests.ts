import type {
  ShiftChangeAttachmentResponse,
  ShiftChangeRequestDetailResponse,
  ShiftChangeRequestListItem,
  ShiftChangeRequestListResponse,
  ShiftChangeRequestStatus,
} from '@hrm/shared'
import { apiFetch, jsonHeaders, unwrap } from './client'

export async function listShiftChangeRequests(
  status?: ShiftChangeRequestStatus,
  signal?: AbortSignal
): Promise<ShiftChangeRequestListItem[]> {
  const query = status ? `?status=${status}` : ''
  const res = await apiFetch(`/api/shift-change-requests${query}`, { signal })
  const body = await unwrap<ShiftChangeRequestListResponse>(res)
  return body.requests
}

export async function getShiftChangeRequest(
  id: number,
  signal?: AbortSignal
): Promise<ShiftChangeRequestListItem> {
  const res = await apiFetch(`/api/shift-change-requests/${id}`, { signal })
  const body = await unwrap<ShiftChangeRequestDetailResponse>(res)
  return body.request
}

export async function approveShiftChangeRequest(id: number): Promise<ShiftChangeRequestListItem> {
  const res = await apiFetch(`/api/shift-change-requests/${id}/approve`, { method: 'POST' })
  const body = await unwrap<ShiftChangeRequestDetailResponse>(res)
  return body.request
}

export async function rejectShiftChangeRequest(id: number, reason: string): Promise<ShiftChangeRequestListItem> {
  const res = await apiFetch(`/api/shift-change-requests/${id}/reject`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ reason }),
  })
  const body = await unwrap<ShiftChangeRequestDetailResponse>(res)
  return body.request
}

export async function getShiftChangeAttachmentUrl(id: number, signal?: AbortSignal): Promise<string | null> {
  const res = await apiFetch(`/api/shift-change-requests/${id}/attachment`, { signal })
  const body = await unwrap<ShiftChangeAttachmentResponse>(res)
  return body.url
}
