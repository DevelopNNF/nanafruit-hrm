import type {
  BulkGrantLeaveRequest,
  BulkGrantLeaveResponse,
  LeaveBalanceEntry,
  LeaveBalanceEntryInput,
  LeaveBalanceEntryListResponse,
  LeaveBalanceEntryResponse,
  LeaveBalanceSummary,
  LeaveBalanceSummaryListResponse,
} from '@hrm/shared'
import { apiFetch, jsonHeaders, unwrap } from './client'

export async function listLeaveBalanceSummaries(
  employeeId: number,
  year: number,
  signal?: AbortSignal
): Promise<LeaveBalanceSummary[]> {
  const res = await apiFetch(`/api/employees/${employeeId}/leave-balances?year=${year}`, {
    signal,
  })
  const body = await unwrap<LeaveBalanceSummaryListResponse>(res)
  return body.summaries
}

export async function listLeaveBalanceEntries(
  employeeId: number,
  year: number,
  signal?: AbortSignal
): Promise<LeaveBalanceEntry[]> {
  const res = await apiFetch(
    `/api/employees/${employeeId}/leave-balances/entries?year=${year}`,
    { signal }
  )
  const body = await unwrap<LeaveBalanceEntryListResponse>(res)
  return body.entries
}

export async function createLeaveBalanceEntry(
  employeeId: number,
  input: LeaveBalanceEntryInput
): Promise<LeaveBalanceEntry> {
  const res = await apiFetch(`/api/employees/${employeeId}/leave-balances/entries`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify(input),
  })
  const body = await unwrap<LeaveBalanceEntryResponse>(res)
  return body.entry
}

export async function bulkGrantLeave(
  input: BulkGrantLeaveRequest
): Promise<BulkGrantLeaveResponse> {
  const res = await apiFetch('/api/leave-balances/bulk-grant', {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify(input),
  })
  return unwrap<BulkGrantLeaveResponse>(res)
}
