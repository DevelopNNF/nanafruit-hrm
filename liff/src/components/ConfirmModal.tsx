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
    <div
      className="modal-overlay"
      role="presentation"
      onClick={() => {
        if (!busy) onCancel()
      }}
    >
      <div
        className="modal-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <p className="modal-title">{title}</p>
        {message && <p className="modal-message">{message}</p>}
        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </button>
          <button type="button" className="modal-confirm-button" onClick={onConfirm} disabled={busy}>
            {busy ? 'กำลังบันทึก…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
