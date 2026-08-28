// Thai message text per event, kept separate from dispatch.ts so wording can
// change without touching delivery logic. Draft copy — HR has not reviewed
// the exact wording yet (see notification-system-plan memory), so treat
// these strings as placeholders likely to be revised before Phase 5 rollout.

import type { AttendanceIssue } from '../attendanceDailyQueries.js'
import type { RequestResourceType } from './types.js'

const RESOURCE_LABELS: Record<RequestResourceType, string> = {
  leave_request: 'คำขอลา',
  overtime_request: 'คำขอทำงานล่วงเวลา',
  shift_change_request: 'คำขอเปลี่ยนกะ',
  day_off_swap_request: 'คำขอสลับวันหยุด',
  time_correction_request: 'คำขอแก้ไขเวลา',
  off_site_work_request: 'คำขอทำงานนอกสถานที่',
}

export function resourceLabel(resource: RequestResourceType): string {
  return RESOURCE_LABELS[resource]
}

export function pendingApprovalLineText(resource: RequestResourceType, requesterName: string): string {
  return `${requesterName} ส่ง${resourceLabel(resource)}ใหม่ รอการอนุมัติจากคุณ — ดูรายละเอียดได้ในแอป LINE`
}

export function decisionLineText(
  resource: RequestResourceType,
  decision: 'approved' | 'rejected',
  reason: string | null
): string {
  if (decision === 'approved') {
    return `${resourceLabel(resource)}ของคุณได้รับการอนุมัติแล้ว`
  }
  const reasonText = reason ? `\nเหตุผล: ${reason}` : ''
  return `${resourceLabel(resource)}ของคุณไม่ได้รับการอนุมัติ${reasonText}`
}

export function cancelledLineText(resource: RequestResourceType, requesterName: string): string {
  return `${requesterName} ยกเลิก${resourceLabel(resource)}ที่รอการอนุมัติจากคุณอยู่แล้ว`
}

export function hrPendingApprovalEmail(
  resource: RequestResourceType,
  requesterName: string,
  requestId: number
): { subject: string; bodyHtml: string } {
  const label = resourceLabel(resource)
  return {
    subject: `[HRM] ${label}รออนุมัติ — ${requesterName}`,
    bodyHtml: `<p>${requesterName} ส่ง${label} (เลขที่ ${requestId}) และรอการอนุมัติขั้นสุดท้ายจาก HR</p>`,
  }
}

/** 'ขาดงาน' for an absent day; otherwise whichever of late/early-leave
 *  applied (computeAttendanceDay lets both happen the same day — checked in
 *  late AND left early is one row with both minute counts set). */
function describeAttendanceIssue(issue: AttendanceIssue): string {
  if (issue.attendanceStatus === 'absent') return 'ขาดงาน'
  const parts: string[] = []
  if (issue.lateMinutes > 0) parts.push(`สาย ${issue.lateMinutes} นาที`)
  if (issue.earlyLeaveMinutes > 0) parts.push(`ออกก่อนเวลา ${issue.earlyLeaveMinutes} นาที`)
  return parts.join(', ')
}

export function attendanceDigestLineText(workDate: string, issues: AttendanceIssue[]): string {
  const lines = issues.map((issue) => `- ${issue.employeeName}: ${describeAttendanceIssue(issue)}`)
  return `สรุปการเข้างานทีมของคุณ วันที่ ${workDate}\n${lines.join('\n')}`
}

export function attendanceDigestHrEmail(
  workDate: string,
  issues: AttendanceIssue[]
): { subject: string; bodyHtml: string } {
  const rows = issues
    .map((issue) => `<tr><td>${issue.employeeName}</td><td>${describeAttendanceIssue(issue)}</td></tr>`)
    .join('')
  return {
    subject: `[HRM] สรุปการขาด/สาย/ออกก่อนเวลา วันที่ ${workDate} (${issues.length} คน)`,
    bodyHtml: `<table><thead><tr><th>พนักงาน</th><th>รายการ</th></tr></thead><tbody>${rows}</tbody></table>`,
  }
}
