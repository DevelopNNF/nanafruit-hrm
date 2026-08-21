import type {
  AttendanceClockRequest,
  AttendanceClockResponse,
  AttendanceEvent,
  AttendanceEventType,
  AttendanceStatusResponse,
  AttendanceTodayStatus,
} from '@hrm/shared'
import type { Coordinates } from '../lib/geolocation'
import { apiFetch, jsonHeaders, unwrap } from './client'

/** This employee's check-in/check-out for whichever shift is currently
 *  relevant — not necessarily today's, see AttendanceTodayStatus. */
export async function fetchAttendanceStatus(signal?: AbortSignal): Promise<AttendanceTodayStatus> {
  const res = await apiFetch('/api/attendance/me', { signal })
  const body = await unwrap<AttendanceStatusResponse>(res)
  return body.today
}

export async function clockAttendance(
  eventType: AttendanceEventType,
  coordinates: Coordinates | null,
  deviceInfo: string
): Promise<AttendanceEvent> {
  const request: AttendanceClockRequest = {
    eventType,
    latitude: coordinates?.latitude ?? null,
    longitude: coordinates?.longitude ?? null,
    accuracyMeters: coordinates?.accuracyMeters ?? null,
    deviceInfo,
  }
  const res = await apiFetch('/api/attendance/clock', {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify(request),
  })
  const body = await unwrap<AttendanceClockResponse>(res)
  return body.event
}
