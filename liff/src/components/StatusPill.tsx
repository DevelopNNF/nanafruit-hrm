export type RequestStatus = 'pending' | 'approved' | 'rejected' | 'cancelled' | 'revoked'

const LABEL: Record<RequestStatus, string> = {
  pending: 'รอดำเนินการ',
  approved: 'อนุมัติแล้ว',
  rejected: 'ปฏิเสธ',
  cancelled: 'ยกเลิกแล้ว',
  // HR/Admin cancelling an OT request that had already been approved — see
  // OVERTIME_REQUEST_STATUSES' comment in shared/src/index.ts.
  revoked: 'ยกเลิกหลังอนุมัติ',
}

export function StatusPill({ status }: { status: RequestStatus }) {
  return <span className={`status-pill ${status}`}>{LABEL[status]}</span>
}
