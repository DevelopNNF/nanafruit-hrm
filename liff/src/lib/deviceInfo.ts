import liff from '@line/liff'

/**
 * A short "what is this client" string for attendance_events.device_info —
 * debugging only, see AttendanceEvent.deviceInfo in shared/src/index.ts.
 *
 * OS and inClient lead because they're what actually explained the first real
 * incident this field exists for: LINE's in-app browser silently declining a
 * geolocation request without ever prompting, because the LINE app itself
 * held no OS-level location permission. The raw user agent alone would not
 * have named that.
 */
export function describeDevice(): string {
  return `${liff.getOS() ?? 'unknown-os'} inClient=${liff.isInClient()} ua=${navigator.userAgent}`
}
