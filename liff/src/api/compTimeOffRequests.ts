import type {
  CompTimeBalance,
  CompTimeBalanceResponse,
  CompTimeOffRequest,
  CompTimeOffRequestInput,
  CompTimeOffRequestMineResponse,
  CompTimeOffRequestResponse,
} from '@hrm/shared'
import { apiFetch, jsonHeaders, unwrap } from './client'

export async function submitCompTimeOffRequest(input: CompTimeOffRequestInput): Promise<CompTimeOffRequest> {
  const res = await apiFetch('/api/comp-time-off-requests', {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify(input),
  })
  const body = await unwrap<CompTimeOffRequestResponse>(res)
  return body.request
}

export async function updateCompTimeOffRequest(
  id: number,
  input: CompTimeOffRequestInput
): Promise<CompTimeOffRequest> {
  const res = await apiFetch(`/api/comp-time-off-requests/${id}`, {
    method: 'PUT',
    headers: jsonHeaders,
    body: JSON.stringify(input),
  })
  const body = await unwrap<CompTimeOffRequestResponse>(res)
  return body.request
}

export async function fetchMyCompTimeOffRequests(signal?: AbortSignal): Promise<CompTimeOffRequest[]> {
  const res = await apiFetch('/api/comp-time-off-requests/me', { signal })
  const body = await unwrap<CompTimeOffRequestMineResponse>(res)
  return body.requests
}

export async function cancelCompTimeOffRequest(id: number): Promise<CompTimeOffRequest> {
  const res = await apiFetch(`/api/comp-time-off-requests/${id}/cancel`, { method: 'POST' })
  const body = await unwrap<CompTimeOffRequestResponse>(res)
  return body.request
}

export async function fetchCompTimeBalance(signal?: AbortSignal): Promise<CompTimeBalance> {
  const res = await apiFetch('/api/comp-time-off-requests/balance', { signal })
  const body = await unwrap<CompTimeBalanceResponse>(res)
  return body.balance
}
