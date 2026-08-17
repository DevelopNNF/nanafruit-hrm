import type { AttendanceDailyFilter, AttendanceDailyListResponse } from '@hrm/shared'
import { apiFetch, unwrap } from './client'

export type AttendanceDailyQuery = {
  fromDate?: string
  toDate?: string
  employeeId?: number
  departmentId?: number
  status?: AttendanceDailyFilter
}

export async function listAttendanceDaily(
  query: AttendanceDailyQuery,
  signal?: AbortSignal
): Promise<AttendanceDailyListResponse> {
  const params = new URLSearchParams()
  if (query.fromDate) params.set('fromDate', query.fromDate)
  if (query.toDate) params.set('toDate', query.toDate)
  if (query.employeeId !== undefined) params.set('employeeId', String(query.employeeId))
  if (query.departmentId !== undefined) params.set('departmentId', String(query.departmentId))
  if (query.status) params.set('status', query.status)

  const qs = params.toString()
  const res = await apiFetch(`/api/attendance/daily${qs ? `?${qs}` : ''}`, { signal })
  return unwrap<AttendanceDailyListResponse>(res)
}
