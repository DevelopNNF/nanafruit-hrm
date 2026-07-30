import type { CalendarDay, MonthCalendarResponse } from '@hrm/shared'
import { apiFetch, unwrap } from './client'

/** This employee's calendar for one month (1-12). */
export async function fetchMonthCalendar(
  year: number,
  month: number,
  signal?: AbortSignal
): Promise<CalendarDay[]> {
  const res = await apiFetch(`/api/calendar/me?year=${year}&month=${month}`, { signal })
  const body = await unwrap<MonthCalendarResponse>(res)
  return body.days
}
