import type { OvertimeReportResponse, OvertimeWeeklyCapResponse } from '@hrm/shared'
import { apiFetch, unwrap } from './client'

export type OvertimeReportFilter = {
  fromDate: string
  toDate: string
  employeeId?: number
  departmentId?: number
}

export async function fetchOvertimeReport(
  filter: OvertimeReportFilter,
  signal?: AbortSignal
): Promise<OvertimeReportResponse> {
  const params = new URLSearchParams({ from: filter.fromDate, to: filter.toDate })
  if (filter.employeeId !== undefined) params.set('employeeId', String(filter.employeeId))
  if (filter.departmentId !== undefined) params.set('departmentId', String(filter.departmentId))

  const res = await apiFetch(`/api/overtime-report?${params.toString()}`, { signal })
  return unwrap<OvertimeReportResponse>(res)
}

export async function fetchOvertimeWeeklyCap(
  requestId: number,
  signal?: AbortSignal
): Promise<OvertimeWeeklyCapResponse> {
  const res = await apiFetch(`/api/overtime-requests/${requestId}/weekly-cap`, { signal })
  return unwrap<OvertimeWeeklyCapResponse>(res)
}
