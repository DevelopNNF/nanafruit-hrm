import type { DashboardOnLeaveTodayResponse, DashboardPendingApprovalsSummaryResponse } from '@hrm/shared'
import { apiFetch, unwrap } from './client'

export async function listEmployeesOnLeaveToday(signal?: AbortSignal) {
  const res = await apiFetch('/api/dashboard/on-leave-today', { signal })
  const body = await unwrap<DashboardOnLeaveTodayResponse>(res)
  return body.employees
}

export async function getPendingApprovalsSummary(
  signal?: AbortSignal
): Promise<DashboardPendingApprovalsSummaryResponse> {
  const res = await apiFetch('/api/dashboard/pending-approvals-summary', { signal })
  return unwrap<DashboardPendingApprovalsSummaryResponse>(res)
}
