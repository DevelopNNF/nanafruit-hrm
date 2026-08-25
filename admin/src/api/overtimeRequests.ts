import type {
  OvertimeBatchActionResponse,
  OvertimeBatchDecisionOutcome,
  OvertimeBatchResponse,
  OvertimeBulkCreateOutcome,
  OvertimeBulkCreateResponse,
  OvertimeBulkRequestInput,
  OvertimeEligibleEmployee,
  OvertimeEligibleEmployeesResponse,
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

/** The "ขอ OT แบบกลุ่ม" picker's employee pool for one date — 'all' active
 *  employees for HR/Admin, or the caller's own active direct reports for a
 *  supervisor. Throws (ApiRequestError, 403) if the signed-in account has
 *  neither. */
export async function fetchOvertimeEligibleEmployees(
  date: string,
  signal?: AbortSignal
): Promise<OvertimeEligibleEmployeesResponse> {
  const res = await apiFetch(
    `/api/overtime-requests/bulk/eligible-employees?date=${encodeURIComponent(date)}`,
    { signal }
  )
  return unwrap<OvertimeEligibleEmployeesResponse>(res)
}

export async function createBulkOvertimeRequest(
  input: OvertimeBulkRequestInput
): Promise<{ batchId: string; outcomes: OvertimeBulkCreateOutcome[] }> {
  const res = await apiFetch('/api/overtime-requests/bulk', {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify(input),
  })
  return unwrap<OvertimeBulkCreateResponse>(res)
}

export async function getOvertimeRequestBatch(
  batchId: string,
  signal?: AbortSignal
): Promise<OvertimeRequestListItem[]> {
  const res = await apiFetch(`/api/overtime-requests/batch/${batchId}`, { signal })
  const body = await unwrap<OvertimeBatchResponse>(res)
  return body.requests
}

export async function approveOvertimeRequestBatch(
  batchId: string
): Promise<OvertimeBatchDecisionOutcome[]> {
  const res = await apiFetch(`/api/overtime-requests/batch/${batchId}/approve`, { method: 'POST' })
  const body = await unwrap<OvertimeBatchActionResponse>(res)
  return body.outcomes
}

export async function rejectOvertimeRequestBatch(
  batchId: string,
  reason: string
): Promise<OvertimeBatchDecisionOutcome[]> {
  const res = await apiFetch(`/api/overtime-requests/batch/${batchId}/reject`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ reason }),
  })
  const body = await unwrap<OvertimeBatchActionResponse>(res)
  return body.outcomes
}

export type { OvertimeEligibleEmployee }
