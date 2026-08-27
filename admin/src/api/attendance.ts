import type { AttendanceListResponse } from '@hrm/shared'
import { apiFetch, unwrap } from './client'

export type AttendanceListFilter = {
  employeeId?: number
  /** 'YYYY-MM-DD', inclusive. */
  fromDate?: string
  /** 'YYYY-MM-DD', inclusive. */
  toDate?: string
}

export async function listAttendance(
  filter: AttendanceListFilter,
  pagination: { page?: number; pageSize?: number } = {},
  signal?: AbortSignal
): Promise<AttendanceListResponse> {
  const params = new URLSearchParams()
  if (filter.employeeId !== undefined) params.set('employeeId', String(filter.employeeId))
  if (filter.fromDate) params.set('fromDate', filter.fromDate)
  if (filter.toDate) params.set('toDate', filter.toDate)
  if (pagination.page !== undefined) params.set('page', String(pagination.page))
  if (pagination.pageSize !== undefined) params.set('pageSize', String(pagination.pageSize))

  const query = params.toString()
  const res = await apiFetch(`/api/attendance${query ? `?${query}` : ''}`, { signal })
  return unwrap<AttendanceListResponse>(res)
}
