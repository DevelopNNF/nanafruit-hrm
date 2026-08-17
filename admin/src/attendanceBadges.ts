/**
 * Turning one attendance_daily row into the badges shown against it.
 *
 * A day can be several things at once — half a day of leave and an early
 * departure, or late in and early out — but attendanceStatus deliberately
 * holds a single value, with late/early/leave carried as minute counts
 * instead (see ATTENDANCE_DAY_STATUSES in shared). Composing the badges is
 * therefore a UI concern, and this is the one place that does it, so the list
 * and any later detail view can't drift.
 */

import type { AttendanceDailyItem } from '@hrm/shared'
import { formatWorkMinutes } from './shiftHours'

type BadgeTone = 'active' | 'inactive' | 'role' | 'pending' | 'danger'

export type AttendanceBadge = { label: string; tone: BadgeTone }

/** How much of a shift the leave took, said the way a person would. Falls
 *  back to a duration when it isn't a recognisable fraction — an hour or two
 *  of leave has no name, so it just states the amount. */
function leaveLabel(day: AttendanceDailyItem): string {
  const owed = (day.expectedWorkMinutes ?? 0) + day.leaveMinutes
  if (owed > 0 && day.expectedWorkMinutes === 0) return 'ลาเต็มวัน'

  const share = owed > 0 ? day.leaveMinutes / owed : 0
  if (share >= 0.4 && share <= 0.6) return 'ลาครึ่งวัน'
  return `ลา ${formatWorkMinutes(day.leaveMinutes)}`
}

/** Which weekday-off wording fits, given how the calendar classified the day. */
function dayOffLabel(day: AttendanceDailyItem): string {
  if (day.leaveMinutes > 0) return leaveLabel(day)
  switch (day.dayStatus) {
    case 'holiday':
      return 'วันหยุดนักขัตฤกษ์'
    case 'swap_dayoff':
      return 'วันหยุดจากการสลับ'
    case 'leave':
      return 'ลาเต็มวัน'
    default:
      return 'วันหยุดประจำสัปดาห์'
  }
}

/**
 * The badges for one day, most significant first. Never empty.
 *
 * 'ปกติ' appears only when nothing else does — pairing it with 'มาสาย' would
 * contradict itself.
 */
export function attendanceBadges(day: AttendanceDailyItem): AttendanceBadge[] {
  switch (day.attendanceStatus) {
    case 'absent':
      return [{ label: 'ขาดงาน', tone: 'danger' }]
    case 'incomplete': {
      // Still worth naming a late arrival on a day whose clock-out is missing:
      // the check-in that did land is enough to judge it.
      const badges: AttendanceBadge[] = [{ label: 'ลงเวลาไม่ครบ', tone: 'danger' }]
      if (day.lateMinutes > 0) badges.push({ label: `มาสาย ${day.lateMinutes} นาที`, tone: 'pending' })
      return badges
    }
    case 'day_off':
      return [{ label: dayOffLabel(day), tone: day.leaveMinutes > 0 ? 'role' : 'inactive' }]
    case 'unscheduled_work':
      return [{ label: 'ทำงานวันหยุด', tone: 'role' }]
    case 'present': {
      const badges: AttendanceBadge[] = []
      if (day.leaveMinutes > 0) badges.push({ label: leaveLabel(day), tone: 'role' })
      if (day.lateMinutes > 0) badges.push({ label: `มาสาย ${day.lateMinutes} นาที`, tone: 'pending' })
      if (day.earlyLeaveMinutes > 0) {
        badges.push({ label: `ออกก่อน ${day.earlyLeaveMinutes} นาที`, tone: 'pending' })
      }
      return badges.length > 0 ? badges : [{ label: 'ปกติ', tone: 'active' }]
    }
  }
}
