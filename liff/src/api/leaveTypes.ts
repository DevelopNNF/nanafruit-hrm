import type { LeaveType, LeaveTypeListResponse } from '@hrm/shared'
import { apiFetch, unwrap } from './client'

export async function fetchActiveLeaveTypes(signal?: AbortSignal): Promise<LeaveType[]> {
  const res = await apiFetch('/api/leave-types/active', { signal })
  const body = await unwrap<LeaveTypeListResponse>(res)
  return body.leaveTypes
}
