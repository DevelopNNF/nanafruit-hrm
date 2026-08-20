export type RequestStatus = 'pending' | 'approved' | 'rejected' | 'cancelled'

const LABEL: Record<RequestStatus, string> = {
  pending: 'รอดำเนินการ',
  approved: 'อนุมัติแล้ว',
  rejected: 'ปฏิเสธ',
  cancelled: 'ยกเลิกแล้ว',
}

export function StatusPill({ status }: { status: RequestStatus }) {
  return <span className={`status-pill ${status}`}>{LABEL[status]}</span>
}
