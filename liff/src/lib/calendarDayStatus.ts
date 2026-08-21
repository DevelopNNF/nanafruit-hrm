import type { CalendarDayStatus } from '@hrm/shared'

/** Thai label per calendar-day type — shared by CalendarScreen (the legend
 *  and day-detail pill) and OvertimeRequestCard (the picked date's status
 *  hint), so the wording can't drift between the two places an employee
 *  sees the same status. */
export const DAY_STATUS_LABEL: Record<CalendarDayStatus, string> = {
  workday: 'วันทำงาน',
  weekly_off: 'วันหยุดประจำสัปดาห์',
  holiday: 'วันหยุดบริษัท',
  leave: 'วันลา',
  swap_workday: 'วันทำงาน (สลับ)',
  swap_dayoff: 'วันหยุด (สลับ)',
}

/** CSS custom property name per calendar-day type — see the --day-* tokens
 *  in index.css. A property name, not a resolved color, so callers can drop
 *  it straight into a `var(...)` reference or a className. */
export const DAY_STATUS_CLASS: Record<CalendarDayStatus, string> = {
  workday: 'workday',
  weekly_off: 'weekly-off',
  holiday: 'holiday',
  leave: 'leave',
  swap_workday: 'swap-workday',
  swap_dayoff: 'swap-dayoff',
}
