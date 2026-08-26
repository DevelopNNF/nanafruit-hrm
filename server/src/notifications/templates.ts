// Thai message text per event, kept separate from dispatch.ts so wording can
// change without touching delivery logic. Draft copy — HR has not reviewed
// the exact wording yet (see notification-system-plan memory), so treat
// these strings as placeholders likely to be revised before Phase 5 rollout.

import type { RequestResourceType } from './types.js'

const RESOURCE_LABELS: Record<RequestResourceType, string> = {
  leave_request: 'คำขอลา',
  overtime_request: 'คำขอทำงานล่วงเวลา',
  shift_change_request: 'คำขอเปลี่ยนกะ',
  day_off_swap_request: 'คำขอสลับวันหยุด',
  time_correction_request: 'คำขอแก้ไขเวลา',
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
