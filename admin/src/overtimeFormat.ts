// Display helpers shared by the two overtime-request pages, in their own
// module rather than exported from the list page: a file that exports both a
// component and plain values loses fast refresh. Same reason attendanceBadges.ts
// and shiftHours.ts sit here.

import type { CalendarDayStatus } from '@hrm/shared'

/** How the calendar classified the date at submission time. Which of the OT
 *  group's five rates ends up applying is decided by this, so it earns a
 *  column of its own rather than being buried in the detail page. */
export const DAY_STATUS_LABEL: Record<CalendarDayStatus, string> = {
  workday: 'วันทำงาน',
  weekly_off: 'วันหยุดประจำสัปดาห์',
  holiday: 'วันหยุดบริษัท',
  leave: 'วันลา',
  swap_workday: 'วันทำงาน (สลับ)',
  swap_dayoff: 'วันหยุด (สลับ)',
}

export function formatOvertimeDate(iso: string): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString('th-TH', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })
}

/** 'HH:MM:SS' → 'HH:MM'. The seconds are always zero — the API normalises
 *  every submitted time to the minute. */
export function hhmm(time: string): string {
  return time.slice(0, 5)
}

/** Minutes as "3 ชม. 30 น." — minutes are what the row stores and what the OT
 *  rates will eventually multiply, so hours exist only for reading. */
export function formatOvertimeHours(minutes: number): string {
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  if (hours === 0) return `${rest} น.`
  if (rest === 0) return `${hours} ชม.`
  return `${hours} ชม. ${rest} น.`
}
