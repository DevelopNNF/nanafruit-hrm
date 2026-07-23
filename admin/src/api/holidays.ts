import type { Holiday, HolidayInput, HolidayListResponse, HolidayResponse } from '@hrm/shared'
import { apiFetch, jsonHeaders, unwrap } from './client'

export async function listHolidays(groupId: number, signal?: AbortSignal): Promise<Holiday[]> {
  const res = await apiFetch(`/api/holiday-groups/${groupId}/holidays`, { signal })
  const body = await unwrap<HolidayListResponse>(res)
  return body.holidays
}

export async function createHoliday(groupId: number, input: HolidayInput): Promise<Holiday> {
  const res = await apiFetch(`/api/holiday-groups/${groupId}/holidays`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify(input),
  })
  const body = await unwrap<HolidayResponse>(res)
  return body.holiday
}

export async function updateHoliday(id: number, input: HolidayInput): Promise<Holiday> {
  const res = await apiFetch(`/api/holidays/${id}`, {
    method: 'PUT',
    headers: jsonHeaders,
    body: JSON.stringify(input),
  })
  const body = await unwrap<HolidayResponse>(res)
  return body.holiday
}

export async function deleteHoliday(id: number): Promise<void> {
  const res = await apiFetch(`/api/holidays/${id}`, { method: 'DELETE' })
  // 204: nothing to unwrap, but a failure still needs to surface.
  if (!res.ok) await unwrap<never>(res)
}
