import type {
  EmployeeFinanceItem,
  EmployeeFinanceItemInput,
  EmployeeFinanceItemListResponse,
  EmployeeFinanceItemResponse,
} from '@hrm/shared'
import { apiFetch, jsonHeaders, unwrap } from './client'

export async function listEmployeeFinanceItems(
  employeeId: number,
  signal?: AbortSignal
): Promise<EmployeeFinanceItem[]> {
  const res = await apiFetch(`/api/employees/${employeeId}/finance-items`, { signal })
  const body = await unwrap<EmployeeFinanceItemListResponse>(res)
  return body.employeeFinanceItems
}

export async function createEmployeeFinanceItem(
  employeeId: number,
  input: EmployeeFinanceItemInput
): Promise<EmployeeFinanceItem> {
  const res = await apiFetch(`/api/employees/${employeeId}/finance-items`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify(input),
  })
  const body = await unwrap<EmployeeFinanceItemResponse>(res)
  return body.employeeFinanceItem
}

export async function updateEmployeeFinanceItem(
  employeeId: number,
  lineId: number,
  input: EmployeeFinanceItemInput
): Promise<EmployeeFinanceItem> {
  const res = await apiFetch(`/api/employees/${employeeId}/finance-items/${lineId}`, {
    method: 'PUT',
    headers: jsonHeaders,
    body: JSON.stringify(input),
  })
  const body = await unwrap<EmployeeFinanceItemResponse>(res)
  return body.employeeFinanceItem
}
