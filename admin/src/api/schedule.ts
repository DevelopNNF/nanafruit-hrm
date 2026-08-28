import type { WorkScheduleResponse } from '@hrm/shared'
import { apiFetch, unwrap } from './client'

export async function getWorkSchedule(
  year: number,
  month: number,
  pagination: { page?: number; pageSize?: number } = {},
  signal?: AbortSignal
): Promise<WorkScheduleResponse> {
  const params = new URLSearchParams({ year: String(year), month: String(month).padStart(2, '0') })
  if (pagination.page !== undefined) params.set('page', String(pagination.page))
  if (pagination.pageSize !== undefined) params.set('pageSize', String(pagination.pageSize))
  const res = await apiFetch(`/api/schedule?${params.toString()}`, { signal })
  return unwrap<WorkScheduleResponse>(res)
}
