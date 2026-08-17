import type {
  OvertimeRequest,
  OvertimeRequestInput,
  OvertimeRequestMineResponse,
  OvertimeRequestResponse,
} from '@hrm/shared'
import { apiFetch, jsonHeaders, unwrap } from './client'

export async function submitOvertimeRequest(input: OvertimeRequestInput): Promise<OvertimeRequest> {
  const res = await apiFetch('/api/overtime-requests', {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify(input),
  })
  const body = await unwrap<OvertimeRequestResponse>(res)
  return body.request
}

export async function updateOvertimeRequest(
  id: number,
  input: OvertimeRequestInput
): Promise<OvertimeRequest> {
  const res = await apiFetch(`/api/overtime-requests/${id}`, {
    method: 'PUT',
    headers: jsonHeaders,
    body: JSON.stringify(input),
  })
  const body = await unwrap<OvertimeRequestResponse>(res)
  return body.request
}

export async function fetchMyOvertimeRequests(signal?: AbortSignal): Promise<OvertimeRequest[]> {
  const res = await apiFetch('/api/overtime-requests/me', { signal })
  const body = await unwrap<OvertimeRequestMineResponse>(res)
  return body.requests
}

export async function cancelOvertimeRequest(id: number): Promise<OvertimeRequest> {
  const res = await apiFetch(`/api/overtime-requests/${id}/cancel`, { method: 'POST' })
  const body = await unwrap<OvertimeRequestResponse>(res)
  return body.request
}
