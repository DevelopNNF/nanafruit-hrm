import type { AttendanceDailyFilter, AttendanceDailyListResponse, WorkLocation } from '@hrm/shared'
import { apiFetch, unwrap, ApiRequestError } from './client'

export type AttendanceDailyQuery = {
  fromDate?: string
  toDate?: string
  employeeId?: number
  departmentId?: number
  status?: AttendanceDailyFilter
  workLocation?: WorkLocation
  /** Matched against employee code, full name, and nickname. */
  search?: string
}

function buildParams(query: AttendanceDailyQuery): URLSearchParams {
  const params = new URLSearchParams()
  if (query.fromDate) params.set('fromDate', query.fromDate)
  if (query.toDate) params.set('toDate', query.toDate)
  if (query.employeeId !== undefined) params.set('employeeId', String(query.employeeId))
  if (query.departmentId !== undefined) params.set('departmentId', String(query.departmentId))
  if (query.status) params.set('status', query.status)
  if (query.workLocation) params.set('workLocation', query.workLocation)
  if (query.search) params.set('search', query.search)
  return params
}

export async function listAttendanceDaily(
  query: AttendanceDailyQuery,
  pagination: { page?: number; pageSize?: number } = {},
  signal?: AbortSignal
): Promise<AttendanceDailyListResponse> {
  const params = buildParams(query)
  if (pagination.page !== undefined) params.set('page', String(pagination.page))
  if (pagination.pageSize !== undefined) params.set('pageSize', String(pagination.pageSize))
  const qs = params.toString()
  const res = await apiFetch(`/api/attendance/daily${qs ? `?${qs}` : ''}`, { signal })
  return unwrap<AttendanceDailyListResponse>(res)
}

/** The same filtered range as listAttendanceDaily, as a formatted .xlsx file —
 *  generated server-side from the report template so it isn't capped by
 *  listAttendanceDaily's on-screen row limit. */
export async function exportAttendanceDaily(
  query: AttendanceDailyQuery,
  signal?: AbortSignal
): Promise<Blob> {
  const qs = buildParams(query).toString()
  const res = await apiFetch(`/api/attendance/daily/export${qs ? `?${qs}` : ''}`, { signal })
  if (!res.ok) {
    let message = `HTTP ${res.status}`
    try {
      const body = (await res.json()) as { message?: string }
      if (body.message) message = body.message
    } catch {
      // Non-JSON error body — the status is all we have.
    }
    throw new ApiRequestError(message)
  }
  return res.blob()
}
