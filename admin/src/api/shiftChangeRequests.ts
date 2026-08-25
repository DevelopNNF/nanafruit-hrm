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

/** The caller's own inbox — mirrors listLeaveRequestsPendingApproval. */
export async function listShiftChangeRequestsPendingApproval(
  signal?: AbortSignal
): Promise<ShiftChangeRequestListItem[]> {
  const res = await apiFetch(`/api/shift-change-requests/pending-approval`, { signal })
  const body = await unwrap<ShiftChangeRequestListResponse>(res)
  return body.requests
}

export async function getShiftChangeRequest(
  id: number,
  signal?: AbortSignal
): Promise<{ request: ShiftChangeRequestListItem; canDecide: boolean }> {
  const res = await apiFetch(`/api/shift-change-requests/${id}`, { signal })
  return unwrap<ShiftChangeRequestDetailResponse>(res)
}

export async function approveShiftChangeRequest(
  id: number
): Promise<{ request: ShiftChangeRequestListItem; canDecide: boolean }> {
  const res = await apiFetch(`/api/shift-change-requests/${id}/approve`, { method: 'POST' })
  return unwrap<ShiftChangeRequestDetailResponse>(res)
}

export async function rejectShiftChangeRequest(
  id: number,
  reason: string
): Promise<{ request: ShiftChangeRequestListItem; canDecide: boolean }> {
  const res = await apiFetch(`/api/shift-change-requests/${id}/reject`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ reason }),
  })
  return unwrap<ShiftChangeRequestDetailResponse>(res)
}

export async function getShiftChangeAttachmentUrl(id: number, signal?: AbortSignal): Promise<string | null> {
  const res = await apiFetch(`/api/shift-change-requests/${id}/attachment`, { signal })
  const body = await unwrap<ShiftChangeAttachmentResponse>(res)
  return body.url
}
