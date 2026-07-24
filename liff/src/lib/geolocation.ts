// A best-effort GPS fix for a clock event. Per the product decision, a missing
// fix must never block the employee from recording that they clocked in or
// out — but *why* it's missing still matters for debugging, so this reports a
// reason rather than collapsing every failure into the same null.
export type Coordinates = { latitude: number; longitude: number; accuracyMeters: number }

export type CoordinatesResult =
  | { ok: true; coordinates: Coordinates }
  | { ok: false; reason: 'unsupported' | 'denied' | 'unavailable' | 'timeout' }

export function getCurrentCoordinates(): Promise<CoordinatesResult> {
  return new Promise((resolve) => {
    if (!('geolocation' in navigator)) {
      resolve({ ok: false, reason: 'unsupported' })
      return
    }
    navigator.geolocation.getCurrentPosition(
      (position) =>
        resolve({
          ok: true,
          coordinates: {
            latitude: position.coords.latitude,
            longitude: position.coords.longitude,
            accuracyMeters: position.coords.accuracy,
          },
        }),
      (error) => {
        // Logged rather than shown by default — see AttendanceCard, which
        // surfaces a Thai hint from `reason`. This stays in the console for
        // the times the hint itself isn't enough (e.g. LINE's in-app browser
        // silently declining without a code the reasons below expect).
        console.warn(`geolocation failed: [${error.code}] ${error.message}`)
        const reason =
          error.code === error.PERMISSION_DENIED
            ? 'denied'
            : error.code === error.TIMEOUT
              ? 'timeout'
              : 'unavailable'
        resolve({ ok: false, reason })
      },
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 0 }
    )
  })
}
