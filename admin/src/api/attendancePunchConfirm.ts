import type { AttendanceCandidatePunchesResponse, ConfirmAttendancePunchResponse } from '@hrm/shared'
import { apiFetch, jsonHeaders, unwrap } from './client'

export async function fetchCandidatePunches(
  employeeId: number,
  workDate: string,
  signal?: AbortSignal
): Promise<AttendanceCandidatePunchesResponse> {
  const res = await apiFetch(`/api/attendance/daily/${employeeId}/${workDate}/candidate-punches`, { signal })
  return unwrap<AttendanceCandidatePunchesResponse>(res)
}

/** `eventId: null` clears the day's manual confirmation. */
export async function confirmAttendancePunch(
  employeeId: number,
  workDate: string,
  eventId: number | null
): Promise<ConfirmAttendancePunchResponse> {
  const res = await apiFetch(`/api/attendance/daily/${employeeId}/${workDate}/confirm-punch`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ eventId }),
  })
  return unwrap<ConfirmAttendancePunchResponse>(res)
}
