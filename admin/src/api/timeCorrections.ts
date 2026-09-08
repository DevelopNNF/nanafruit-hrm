import type {
  TimeCorrectionAdminInput,
  TimeCorrectionDetailResponse,
  TimeCorrectionEligibleEmployeesResponse,
  TimeCorrectionListItem,
  TimeCorrectionListResponse,
  TimeCorrectionPendingApprovalResponse,
  TimeCorrectionResponse,
  TimeCorrectionStatus,
} from '@hrm/shared'
import { apiFetch, jsonHeaders, unwrap } from './client'

export async function listTimeCorrections(
  status?: TimeCorrectionStatus,
  pagination: { page?: number; pageSize?: number } = {},
  signal?: AbortSignal,
  /** Restricts to these employee ids — how the shared employee filter bar's
   *  department/job/employment-type/etc. selections narrow this list. */
  employeeIds?: number[]
): Promise<TimeCorrectionListResponse> {
  const params = new URLSearchParams()
  if (status) params.set('status', status)
  if (pagination.page !== undefined) params.set('page', String(pagination.page))
  if (pagination.pageSize !== undefined) params.set('pageSize', String(pagination.pageSize))
  employeeIds?.forEach((id) => params.append('employeeId', String(id)))
  const qs = params.toString()
  const res = await apiFetch(`/api/time-corrections${qs ? `?${qs}` : ''}`, { signal })
  return unwrap<TimeCorrectionListResponse>(res)
}

/** The caller's own inbox — mirrors listLeaveRequestsPendingApproval. */
export async function listTimeCorrectionsPendingApproval(
  signal?: AbortSignal
): Promise<TimeCorrectionListItem[]> {
  const res = await apiFetch(`/api/time-corrections/pending-approval`, { signal })
  const body = await unwrap<TimeCorrectionPendingApprovalResponse>(res)
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

/** Who the signed-in supervisor/HR/Admin may file an on-behalf-of request
 *  for — mirrors fetchOvertimeEligibleEmployees. */
export async function fetchTimeCorrectionEligibleEmployees(
  signal?: AbortSignal
): Promise<TimeCorrectionEligibleEmployeesResponse> {
  const res = await apiFetch('/api/time-corrections/eligible-employees', { signal })
  return unwrap<TimeCorrectionEligibleEmployeesResponse>(res)
}

export async function createTimeCorrectionForEmployee(
  input: TimeCorrectionAdminInput
): Promise<TimeCorrectionResponse> {
  const res = await apiFetch('/api/time-corrections/admin', {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify(input),
  })
  return unwrap<TimeCorrectionResponse>(res)
}
