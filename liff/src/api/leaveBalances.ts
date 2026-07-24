import type { LeaveBalanceSummary, LeaveBalanceSummaryListResponse } from '@hrm/shared'
import { apiFetch, unwrap } from './client'

export async function fetchMyLeaveBalances(year: number, signal?: AbortSignal): Promise<LeaveBalanceSummary[]> {
  const res = await apiFetch(`/api/leave-balances/me?year=${year}`, { signal })
  const body = await unwrap<LeaveBalanceSummaryListResponse>(res)
  return body.summaries
}
