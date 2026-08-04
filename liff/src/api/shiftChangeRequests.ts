import type {
  ShiftChangeAttachmentPresignInput,
  ShiftChangeAttachmentPresignResponse,
  ShiftChangeAttachmentResponse,
  ShiftChangeRequest,
  ShiftChangeRequestInput,
  ShiftChangeRequestMineResponse,
  ShiftChangeRequestResponse,
} from '@hrm/shared'
import { apiFetch, jsonHeaders, unwrap } from './client'

export async function submitShiftChangeRequest(input: ShiftChangeRequestInput): Promise<ShiftChangeRequest> {
  const res = await apiFetch('/api/shift-change-requests', {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify(input),
  })
  const body = await unwrap<ShiftChangeRequestResponse>(res)
  return body.request
}

export async function updateShiftChangeRequest(
  id: number,
  input: ShiftChangeRequestInput
): Promise<ShiftChangeRequest> {
  const res = await apiFetch(`/api/shift-change-requests/${id}`, {
    method: 'PUT',
    headers: jsonHeaders,
    body: JSON.stringify(input),
  })
  const body = await unwrap<ShiftChangeRequestResponse>(res)
  return body.request
}

export async function fetchMyShiftChangeRequests(signal?: AbortSignal): Promise<ShiftChangeRequest[]> {
  const res = await apiFetch('/api/shift-change-requests/me', { signal })
  const body = await unwrap<ShiftChangeRequestMineResponse>(res)
  return body.requests
}

export async function cancelShiftChangeRequest(id: number): Promise<ShiftChangeRequest> {
  const res = await apiFetch(`/api/shift-change-requests/${id}/cancel`, { method: 'POST' })
  const body = await unwrap<ShiftChangeRequestResponse>(res)
  return body.request
}

export async function presignShiftChangeAttachmentUpload(
  id: number,
  input: ShiftChangeAttachmentPresignInput
): Promise<ShiftChangeAttachmentPresignResponse> {
  const res = await apiFetch(`/api/shift-change-requests/${id}/attachment/presign-upload`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify(input),
  })
  return unwrap<ShiftChangeAttachmentPresignResponse>(res)
}

export async function completeShiftChangeAttachmentUpload(id: number, key: string): Promise<ShiftChangeRequest> {
  const res = await apiFetch(`/api/shift-change-requests/${id}/attachment/complete`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ key }),
  })
  const body = await unwrap<ShiftChangeRequestResponse>(res)
  return body.request
}

export async function deleteShiftChangeAttachment(id: number): Promise<void> {
  const res = await apiFetch(`/api/shift-change-requests/${id}/attachment`, { method: 'DELETE' })
  if (!res.ok) await unwrap<never>(res)
}

export async function getShiftChangeAttachmentUrl(id: number, signal?: AbortSignal): Promise<string | null> {
  const res = await apiFetch(`/api/shift-change-requests/${id}/attachment`, { signal })
  const body = await unwrap<ShiftChangeAttachmentResponse>(res)
  return body.url
}
