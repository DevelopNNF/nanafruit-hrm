import type { ReactNode } from 'react'
import { StatusPill, type RequestStatus } from './StatusPill'

/**
 * Shared list/form chrome for every request type (leave, time correction,
 * shift change, day-off swap, overtime) — the five screens differ only in
 * their form fields, which the caller passes as `children`.
 */

export type RequestListItem = {
  id: number
  title: string
  meta: string
  status: RequestStatus
  reason: string | null
  decisionNote?: string | null
  hasFile?: boolean
  onEdit?: () => void
  onCancel?: () => void
}

type ListPhase = 'loading' | 'error' | 'ready'

type Props = {
  title: string
  englishTag: string
  ruleText: string
  onBack: () => void
  mode: 'list' | 'form'
  busy: boolean

  // list mode
  newLabel: string
  onOpenForm: () => void
  listPhase: ListPhase
  listErrorMessage?: string
  emptyText: string
  items: RequestListItem[]

  // form mode
  onSubmit: (event: React.FormEvent) => void
  onCloseForm: () => void
  formError: string | null
  submitLabel: string
  canSubmit: boolean
  reasonLabel: string
  reason: string
  onReasonChange: (value: string) => void
  children?: ReactNode
}

export function RequestShell({
  title,
  englishTag,
  ruleText,
  onBack,
  mode,
  busy,
  newLabel,
  onOpenForm,
  listPhase,
  listErrorMessage,
  emptyText,
  items,
  onSubmit,
  onCloseForm,
  formError,
  submitLabel,
  canSubmit,
  reasonLabel,
  reason,
  onReasonChange,
  children,
}: Props) {
  return (
    <main className="app">
      <div className="request-shell-header">
        <button type="button" className="back-button" onClick={onBack} aria-label="ย้อนกลับ">
          ←
        </button>
        <h1>{title}</h1>
        <span className="request-shell-en">{englishTag}</span>
      </div>

      <p className="request-shell-rule">{ruleText}</p>

      {mode === 'list' && (
        <>
          <button type="button" className="request-shell-primary" onClick={onOpenForm}>
            {newLabel}
          </button>

          <p className="request-shell-subheading">ประวัติคำขอ</p>

          {listPhase === 'loading' && <p className="hint">กำลังโหลด…</p>}
          {listPhase === 'error' && <p className="form-error">{listErrorMessage}</p>}

          {listPhase === 'ready' &&
            (items.length === 0 ? (
              <div className="request-empty">
                <p>{emptyText}</p>
              </div>
            ) : (
              <ul className="request-list">
                {items.map((item) => (
                  <li key={item.id} className="request-item">
                    <div className="request-item-head">
                      <div>
                        <p className="request-item-title">{item.title}</p>
                        <p className="request-item-meta">{item.meta}</p>
                      </div>
                      <StatusPill status={item.status} />
                    </div>
                    {item.reason && <p className="request-item-reason">{item.reason}</p>}
                    {item.decisionNote && <p className="request-item-decision">{item.decisionNote}</p>}
                    {item.hasFile && <p className="request-item-file">แนบรูป 1 ไฟล์</p>}
                    {(item.onEdit || item.onCancel) && (
                      <div className="request-item-actions">
                        {item.onEdit && (
                          <button
                            type="button"
                            className="request-edit-button"
                            disabled={busy}
                            onClick={item.onEdit}
                          >
                            แก้ไข
                          </button>
                        )}
                        {item.onCancel && (
                          <button
                            type="button"
                            className="request-cancel-button"
                            disabled={busy}
                            onClick={item.onCancel}
                          >
                            ยกเลิกคำขอ
                          </button>
                        )}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            ))}
        </>
      )}

      {mode === 'form' && (
        <form onSubmit={onSubmit} className="request-form">
          {children}

          <label className="field">
            <span>{reasonLabel}</span>
            <textarea
              value={reason}
              onChange={(e) => onReasonChange(e.target.value)}
              placeholder="ระบุเหตุผลสั้น ๆ"
              rows={3}
              disabled={busy}
            />
          </label>

          {formError !== null && <p className="form-error">{formError}</p>}

          <div className="correction-form-actions">
            <button type="submit" disabled={busy || !canSubmit}>
              {busy ? 'กำลังส่ง…' : submitLabel}
            </button>
            <button type="button" className="secondary-button" disabled={busy} onClick={onCloseForm}>
              ยกเลิก
            </button>
          </div>
        </form>
      )}
    </main>
  )
}
