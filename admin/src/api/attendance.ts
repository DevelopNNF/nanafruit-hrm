import type { AttendanceListResponse, AttendanceListItem } from '@hrm/shared'
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
  signal?: AbortSignal
): Promise<AttendanceListItem[]> {
  const params = new URLSearchParams()
  if (filter.employeeId !== undefined) params.set('employeeId', String(filter.employeeId))
  if (filter.fromDate) params.set('fromDate', filter.fromDate)
  if (filter.toDate) params.set('toDate', filter.toDate)

  const query = params.toString()
  const res = await apiFetch(`/api/attendance${query ? `?${query}` : ''}`, { signal })
  const body = await unwrap<AttendanceListResponse>(res)
  return body.events
}
