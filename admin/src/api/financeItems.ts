import type {
  FinanceItem,
  FinanceItemInput,
  FinanceItemListResponse,
  FinanceItemResponse,
} from '@hrm/shared'
import { apiFetch, jsonHeaders, unwrap } from './client'

export async function listFinanceItems(signal?: AbortSignal): Promise<FinanceItem[]> {
  const res = await apiFetch('/api/finance-items', { signal })
  const body = await unwrap<FinanceItemListResponse>(res)
  return body.financeItems
}

export async function getFinanceItem(id: number, signal?: AbortSignal): Promise<FinanceItem> {
  const res = await apiFetch(`/api/finance-items/${id}`, { signal })
  const body = await unwrap<FinanceItemResponse>(res)
  return body.financeItem
}

export async function createFinanceItem(input: FinanceItemInput): Promise<FinanceItem> {
  const res = await apiFetch('/api/finance-items', {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify(input),
  })
  const body = await unwrap<FinanceItemResponse>(res)
  return body.financeItem
}

export async function updateFinanceItem(
  id: number,
  input: FinanceItemInput
): Promise<FinanceItem> {
  const res = await apiFetch(`/api/finance-items/${id}`, {
    method: 'PUT',
    headers: jsonHeaders,
    body: JSON.stringify(input),
  })
  const body = await unwrap<FinanceItemResponse>(res)
  return body.financeItem
}
