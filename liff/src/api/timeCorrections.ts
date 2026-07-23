import type {
  TimeCorrectionInput,
  TimeCorrectionMineResponse,
  TimeCorrectionRequest,
  TimeCorrectionResponse,
} from '@hrm/shared'
import { apiFetch, jsonHeaders, unwrap } from './client'

export async function submitTimeCorrection(input: TimeCorrectionInput): Promise<TimeCorrectionRequest> {
  const res = await apiFetch('/api/time-corrections', {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify(input),
  })
  const body = await unwrap<TimeCorrectionResponse>(res)
  return body.request
}

export async function fetchMyTimeCorrections(signal?: AbortSignal): Promise<TimeCorrectionRequest[]> {
  const res = await apiFetch('/api/time-corrections/me', { signal })
  const body = await unwrap<TimeCorrectionMineResponse>(res)
  return body.requests
}
