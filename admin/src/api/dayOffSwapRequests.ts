import type {
  DayOffSwapRequestBatchActionResponse,
  DayOffSwapRequestBatchDecisionOutcome,
  DayOffSwapRequestBatchResponse,
  DayOffSwapRequestBulkCreateResponse,
  DayOffSwapRequestBulkInput,
  DayOffSwapRequestDetailResponse,
  DayOffSwapRequestEligibleEmployee,
  DayOffSwapRequestEligibleEmployeesResponse,
  DayOffSwapRequestListItem,
  DayOffSwapRequestListResponse,
  DayOffSwapRequestPendingApprovalResponse,
  DayOffSwapRequestStatus,
} from '@hrm/shared'
import { apiFetch, jsonHeaders, unwrap } from './client'

export async function listDayOffSwapRequests(
  status?: DayOffSwapRequestStatus,
  pagination: { page?: number; pageSize?: number } = {},
  signal?: AbortSignal,
  /** Restricts to these employee ids — how the shared employee filter bar's
   *  department/job/employment-type/etc. selections narrow this list. */
  employeeIds?: number[]
): Promise<DayOffSwapRequestListResponse> {
  const params = new URLSearchParams()
  if (status) params.set('status', status)
  if (pagination.page !== undefined) params.set('page', String(pagination.page))
  if (pagination.pageSize !== undefined) params.set('pageSize', String(pagination.pageSize))
  employeeIds?.forEach((id) => params.append('employeeId', String(id)))
  const qs = params.toString()
  const res = await apiFetch(`/api/day-off-swap-requests${qs ? `?${qs}` : ''}`, { signal })
  return unwrap<DayOffSwapRequestListResponse>(res)
}

/** The caller's own inbox — mirrors listLeaveRequestsPendingApproval. */
export async function listDayOffSwapRequestsPendingApproval(
  signal?: AbortSignal
): Promise<DayOffSwapRequestListItem[]> {
  const res = await apiFetch(`/api/day-off-swap-requests/pending-approval`, { signal })
  const body = await unwrap<DayOffSwapRequestPendingApprovalResponse>(res)
  return body.requests
}

export async function getDayOffSwapRequest(
  id: number,
  signal?: AbortSignal
): Promise<{ request: DayOffSwapRequestListItem; canDecide: boolean }> {
  const res = await apiFetch(`/api/day-off-swap-requests/${id}`, { signal })
  return unwrap<DayOffSwapRequestDetailResponse>(res)
}

export async function approveDayOffSwapRequest(
  id: number
): Promise<{ request: DayOffSwapRequestListItem; canDecide: boolean }> {
  const res = await apiFetch(`/api/day-off-swap-requests/${id}/approve`, { method: 'POST' })
  return unwrap<DayOffSwapRequestDetailResponse>(res)
}

export async function rejectDayOffSwapRequest(
  id: number,
  reason: string
): Promise<{ request: DayOffSwapRequestListItem; canDecide: boolean }> {
  const res = await apiFetch(`/api/day-off-swap-requests/${id}/reject`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ reason }),
  })
  return unwrap<DayOffSwapRequestDetailResponse>(res)
}

/** The "ขอสลับวันหยุดแบบกลุ่ม" picker's employee pool — 'all' active
 *  employees for HR/Admin, or the caller's own active direct reports for a
 *  supervisor. Throws (ApiRequestError, 403) if the signed-in account has
 *  neither. */
export async function fetchDayOffSwapRequestEligibleEmployees(
  signal?: AbortSignal
): Promise<DayOffSwapRequestEligibleEmployeesResponse> {
  const res = await apiFetch('/api/day-off-swap-requests/eligible-employees', { signal })
  return unwrap<DayOffSwapRequestEligibleEmployeesResponse>(res)
}

export async function createBulkDayOffSwapRequest(
  input: DayOffSwapRequestBulkInput
): Promise<DayOffSwapRequestBulkCreateResponse> {
  const res = await apiFetch('/api/day-off-swap-requests/bulk', {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify(input),
  })
  return unwrap<DayOffSwapRequestBulkCreateResponse>(res)
}

export async function getDayOffSwapRequestBatch(
  batchId: string,
  signal?: AbortSignal
): Promise<DayOffSwapRequestBatchResponse> {
  const res = await apiFetch(`/api/day-off-swap-requests/batch/${batchId}`, { signal })
  return unwrap<DayOffSwapRequestBatchResponse>(res)
}

export async function approveDayOffSwapRequestBatch(
  batchId: string
): Promise<DayOffSwapRequestBatchDecisionOutcome[]> {
  const res = await apiFetch(`/api/day-off-swap-requests/batch/${batchId}/approve`, { method: 'POST' })
  const body = await unwrap<DayOffSwapRequestBatchActionResponse>(res)
  return body.outcomes
}

export async function rejectDayOffSwapRequestBatch(
  batchId: string,
  reason: string
): Promise<DayOffSwapRequestBatchDecisionOutcome[]> {
  const res = await apiFetch(`/api/day-off-swap-requests/batch/${batchId}/reject`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ reason }),
  })
  const body = await unwrap<DayOffSwapRequestBatchActionResponse>(res)
  return body.outcomes
}

export type { DayOffSwapRequestEligibleEmployee }
