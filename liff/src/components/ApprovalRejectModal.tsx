import { useState } from 'react'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog'

type Props = {
  /** Employee name + request title, for "who/what am I rejecting". */
  subject: string
  busy: boolean
  onConfirm: (reason: string) => void
  onCancel: () => void
}

// Approving is a plain confirm (ApprovalInboxCard uses ConfirmModal for
// that) — only rejecting requires a reason, since the employee sees it and
// "no" needs an explanation "yes" doesn't. Reusing ConfirmModal wasn't
// possible here: it has no room for the chip row + textarea below.
const REJECT_CHIPS = ['กำลังคนไม่พอในวันนั้น', 'เอกสารประกอบไม่ครบ', 'ขอเลื่อนไปช่วงอื่น']

export function ApprovalRejectModal({ subject, busy, onConfirm, onCancel }: Props) {
  const [reason, setReason] = useState('')
  const canConfirm = reason.trim() !== ''

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onCancel()
      }}
    >
      <DialogContent role="alertdialog">
        <DialogTitle className="approval-reject-title">ปฏิเสธคำขอ</DialogTitle>
        <DialogDescription>{subject}</DialogDescription>

        <div className="approval-reject-chips">
          {REJECT_CHIPS.map((chip) => (
            <button
              key={chip}
              type="button"
              className={`approval-reject-chip ${reason === chip ? 'selected' : ''}`}
              disabled={busy}
              onClick={() => setReason(chip)}
            >
              {chip}
            </button>
          ))}
        </div>

        <label className="field approval-reject-field">
          <span>เหตุผล * (พนักงานจะเห็นข้อความนี้)</span>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            placeholder="ระบุเหตุผลของการปฏิเสธ"
            disabled={busy}
          />
        </label>

        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={onCancel} disabled={busy}>
            ปิด
          </button>
          <button
            type="button"
            className="approval-reject-confirm-button"
            onClick={() => onConfirm(reason.trim())}
            disabled={busy || !canConfirm}
          >
            {busy ? 'กำลังบันทึก…' : canConfirm ? 'ยืนยันปฏิเสธ' : 'กรอกเหตุผลก่อน'}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
