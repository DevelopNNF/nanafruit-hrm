import type { WorkScheduleResponse } from '@hrm/shared'
import { apiFetch, unwrap } from './client'

export async function getWorkSchedule(
  year: number,
  month: number,
  signal?: AbortSignal
): Promise<WorkScheduleResponse> {
  const params = new URLSearchParams({ year: String(year), month: String(month).padStart(2, '0') })
  const res = await apiFetch(`/api/schedule?${params.toString()}`, { signal })
  return unwrap<WorkScheduleResponse>(res)
}
