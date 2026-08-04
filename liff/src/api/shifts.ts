import type { Shift, ShiftListResponse } from '@hrm/shared'
import { apiFetch, unwrap } from './client'

export async function fetchActiveShifts(signal?: AbortSignal): Promise<Shift[]> {
  const res = await apiFetch('/api/shifts/active', { signal })
  const body = await unwrap<ShiftListResponse>(res)
  return body.shifts
}
