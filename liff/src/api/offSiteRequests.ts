import type {
  OffSiteWorkRequest,
  OffSiteWorkRequestInput,
  OffSiteWorkRequestMineResponse,
  OffSiteWorkRequestResponse,
} from '@hrm/shared'
import { apiFetch, jsonHeaders, unwrap } from './client'

export async function submitOffSiteWorkRequest(input: OffSiteWorkRequestInput): Promise<OffSiteWorkRequest> {
  const res = await apiFetch('/api/off-site-work-requests', {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify(input),
  })
  const body = await unwrap<OffSiteWorkRequestResponse>(res)
  return body.request
}

export async function fetchMyOffSiteWorkRequests(signal?: AbortSignal): Promise<OffSiteWorkRequest[]> {
  const res = await apiFetch('/api/off-site-work-requests/me', { signal })
  const body = await unwrap<OffSiteWorkRequestMineResponse>(res)
  return body.requests
}

export async function cancelOffSiteWorkRequest(id: number): Promise<OffSiteWorkRequest> {
  const res = await apiFetch(`/api/off-site-work-requests/${id}/cancel`, { method: 'POST' })
  const body = await unwrap<OffSiteWorkRequestResponse>(res)
  return body.request
}
