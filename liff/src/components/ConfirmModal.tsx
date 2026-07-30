import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog'

type Props = {
  title: string
  message?: string
  confirmLabel: string
  cancelLabel?: string
  busy?: boolean
  onConfirm: () => void
  onCancel: () => void
}

export function ConfirmModal({
  title,
  message,
  confirmLabel,
  cancelLabel = 'ยกเลิก',
  busy = false,
  onConfirm,
  onCancel,
}: Props) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        // Radix fires this for Escape and outside-click too — ignoring it
        // while busy is what used to stop the overlay's onClick from
        // cancelling mid-submit.
        if (!open && !busy) onCancel()
      }}
    >
      <DialogContent role="alertdialog">
        <DialogTitle>{title}</DialogTitle>
        {message && <DialogDescription>{message}</DialogDescription>}
        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </button>
          <button type="button" className="modal-confirm-button" onClick={onConfirm} disabled={busy}>
            {busy ? 'กำลังบันทึก…' : confirmLabel}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
