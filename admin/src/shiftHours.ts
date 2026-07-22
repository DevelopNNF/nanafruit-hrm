// Work-hours-per-shift is shown in the list and form for convenience, but it's
// derived entirely from shiftStartTime/shiftEndTime/breakStartTime/breakEndTime —
// storing it too would just be a second value that can drift from the times
// that define it, so it's computed here instead and never sent to the server.

const TIME_PREFIX_RE = /^([01]\d|2[0-3]):([0-5]\d)/

function parseTimeToMinutes(time: string): number | null {
  const match = TIME_PREFIX_RE.exec(time)
  if (!match) return null
  return Number(match[1]) * 60 + Number(match[2])
}

type ShiftTimes = {
  shiftStartTime: string
  shiftEndTime: string
  breakStartTime: string | null
  breakEndTime: string | null
}

/**
 * Minutes actually worked, break excluded. Null when the shift's own times
 * aren't filled in yet (the form, mid-entry) rather than a hard error.
 *
 * shiftEndTime <= shiftStartTime is treated as crossing midnight, matching the
 * server's interpretation of the same fields.
 */
export function computeWorkMinutes(input: ShiftTimes): number | null {
  const start = parseTimeToMinutes(input.shiftStartTime)
  const end = parseTimeToMinutes(input.shiftEndTime)
  if (start === null || end === null) return null

  const shiftMinutes = end > start ? end - start : end + 24 * 60 - start

  let breakMinutes = 0
  if (input.breakStartTime && input.breakEndTime) {
    const breakStart = parseTimeToMinutes(input.breakStartTime)
    const breakEnd = parseTimeToMinutes(input.breakEndTime)
    if (breakStart !== null && breakEnd !== null && breakEnd > breakStart) {
      breakMinutes = breakEnd - breakStart
    }
  }

  return Math.max(shiftMinutes - breakMinutes, 0)
}

export function formatWorkMinutes(minutes: number): string {
  const hours = Math.floor(minutes / 60)
  const mins = minutes % 60
  return mins === 0 ? `${hours} ชม.` : `${hours} ชม. ${mins} นาที`
}
