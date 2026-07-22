import type { Shift, ShiftInput, ShiftListResponse, ShiftResponse } from '@hrm/shared'
import { apiFetch, jsonHeaders, unwrap } from './client'

export async function listShifts(signal?: AbortSignal): Promise<Shift[]> {
  const res = await apiFetch('/api/shifts', { signal })
  const body = await unwrap<ShiftListResponse>(res)
  return body.shifts
}

export async function getShift(id: number, signal?: AbortSignal): Promise<Shift> {
  const res = await apiFetch(`/api/shifts/${id}`, { signal })
  const body = await unwrap<ShiftResponse>(res)
  return body.shift
}

export async function createShift(input: ShiftInput): Promise<Shift> {
  const res = await apiFetch('/api/shifts', {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify(input),
  })
  const body = await unwrap<ShiftResponse>(res)
  return body.shift
}

export async function updateShift(id: number, input: ShiftInput): Promise<Shift> {
  const res = await apiFetch(`/api/shifts/${id}`, {
    method: 'PUT',
    headers: jsonHeaders,
    body: JSON.stringify(input),
  })
  const body = await unwrap<ShiftResponse>(res)
  return body.shift
}
