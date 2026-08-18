import { useEffect, useState } from 'react'
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'
import { FINANCE_ITEM_TYPES, type FinanceItemInput } from '@hrm/shared'
import { createFinanceItem, getFinanceItem, updateFinanceItem } from '../../../api/financeItems'
import { useCanWrite } from '../../../auth/meContext'
import { notify } from '../../../notifications/notify'
import { FINANCE_ITEM_TYPE_LABELS } from './financeItemLabels'
import {
  alert,
  alertDetail,
  alertTitle,
  button,
  card,
  eyebrow,
  fieldControl,
  muted,
  pageHead,
  requiredMark,
  subtitle,
} from '../../../styles'

const emptyDraft: FinanceItemInput = {
  itemCode: '',
  itemName: '',
  itemType: 'income',
  description: null,
  sortOrder: 0,
  isActive: true,
}

const sectionTitle =
  'mb-5 border-b border-slate-200 pb-3 text-xs font-bold tracking-wider text-slate-500 uppercase'

// Same one-line "label * : [input]" rows as the Overtime Group form, rather
// than the label-above-input fieldGrid in styles.ts.
const fieldStack = 'flex flex-col gap-3'
const fieldRow = 'flex flex-wrap items-center gap-3'
const fieldRowLabel = 'w-72 flex-none text-xs font-medium text-slate-600 text-right'

export function FinanceItemFormPage() {
  const params = useParams()
  const navigate = useNavigate()
  const canWrite = useCanWrite()

  // The route is /master/finance-items/new or /master/finance-items/:id.
  const idParam = params['id']
  const isNew = idParam === undefined
  const id = isNew ? null : Number(idParam)

  const [draft, setDraft] = useState<FinanceItemInput>(emptyDraft)
  const [loading, setLoading] = useState(!isNew)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (id === null) return
    const controller = new AbortController()

    getFinanceItem(id, controller.signal)
      .then((item) => {
        setDraft({
          itemCode: item.itemCode,
          itemName: item.itemName,
          itemType: item.itemType,
          description: item.description,
          sortOrder: item.sortOrder,
          isActive: item.isActive,
        })
        setLoading(false)
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return
        setError(err instanceof Error ? err.message : 'request failed')
        setLoading(false)
      })

    return () => controller.abort()
  }, [id])

  function set<K extends keyof FinanceItemInput>(key: K, value: FinanceItemInput[K]) {
    setDraft((prev) => ({ ...prev, [key]: value }))
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    setSaving(true)
    setError(null)
    try {
      if (id === null) await createFinanceItem(draft)
      else await updateFinanceItem(id, draft)
      notify.success(isNew ? 'เพิ่มรายการทางการเงินสำเร็จ' : 'บันทึกการแก้ไขสำเร็จ')
      void navigate('/master/finance-items')
    } catch (err) {
      // Server-side rejections (duplicate code, bad type) land here — keep the
      // user's input on screen and show why it was refused.
      setError(err instanceof Error ? err.message : 'save failed')
      setSaving(false)
    }
  }

  // A viewer has no business on the "new item" route at all — there is nothing
  // on it they could finish. The edit route still shows them the record,
  // read-only, because reading is exactly what their role is for.
  if (isNew && !canWrite) return <Navigate to="/master/finance-items" replace />

  if (loading) return <p className={muted}>กำลังโหลด…</p>

  return (
    <>
      <header className={pageHead}>
        <div>
          <p className={eyebrow}>
            <Link
              className="inline-flex items-center gap-1.5 text-slate-500 no-underline normal-case tracking-normal hover:text-navy"
              to="/master/finance-items"
            >
              <ArrowLeft size={13} />
              กลับไปรายการทางการเงิน
            </Link>
          </p>
          <h1>
            {isNew ? 'เพิ่มรายการทางการเงิน' : canWrite ? 'แก้ไขรายการทางการเงิน' : 'ข้อมูลรายการทางการเงิน'}
          </h1>
          <p className={subtitle}>
            {isNew ? 'กรอกข้อมูลให้ครบทุกช่องที่มีเครื่องหมาย *' : draft.itemName}
          </p>
        </div>
      </header>

      {!canWrite && (
        <div className={alert('info')}>
          <p className={alertTitle()}>โหมดอ่านอย่างเดียว</p>
          <p className={muted}>สิทธิ์ของคุณดูข้อมูลได้อย่างเดียว จึงแก้ไขข้อมูลนี้ไม่ได้</p>
        </div>
      )}

      {error && (
        <div className={alert('danger')}>
          <p className={alertTitle('danger')}>บันทึกไม่สำเร็จ</p>
          <p className={alertDetail}>{error}</p>
        </div>
      )}

      {/* max-w-4xl, wider than the other master forms' max-w-3xl: หมายเหตุ is
          free text and the label column eats 18rem before it starts. Every
          other control here carries its own max-w-*, so the extra room lands
          on that one field and nothing else moves. */}
      <form className="max-w-4xl" onSubmit={(e) => void handleSubmit(e)}>
        {/* One fieldset rather than a `disabled` on each control: a field added
            later is read-only by default instead of by remembering. */}
        <fieldset disabled={!canWrite} className="min-w-0 border-0 p-0">
          <section className={`${card} mb-4`}>
            <h2 className={sectionTitle}>ข้อมูลพื้นฐาน (Basic information)</h2>
            <p className={`${muted} mb-3`}>
              ยอดเงินไม่ได้ตั้งที่นี่ — รายการนี้เป็นเพียงชื่อรายการ ส่วนจำนวนเงินจะระบุแยกเป็นรายคน
            </p>
            <div className={fieldStack}>
              <label className={fieldRow}>
                <span className={fieldRowLabel}>
                  รหัสรายการ <span className={requiredMark}>*</span> :
                </span>
                <input
                  required
                  className={`${fieldControl} max-w-xs`}
                  value={draft.itemCode}
                  onChange={(e) => set('itemCode', e.target.value)}
                />
              </label>
              <label className={fieldRow}>
                <span className={fieldRowLabel}>
                  ชื่อรายการ <span className={requiredMark}>*</span> :
                </span>
                <input
                  required
                  className={`${fieldControl} max-w-xs`}
                  value={draft.itemName}
                  onChange={(e) => set('itemName', e.target.value)}
                />
              </label>
              <label className={fieldRow}>
                <span className={fieldRowLabel}>
                  ประเภท <span className={requiredMark}>*</span> :
                </span>
                <select
                  className={`${fieldControl} max-w-40`}
                  value={draft.itemType}
                  onChange={(e) =>
                    set('itemType', e.target.value as FinanceItemInput['itemType'])
                  }
                >
                  {FINANCE_ITEM_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {FINANCE_ITEM_TYPE_LABELS[type]}
                    </option>
                  ))}
                </select>
              </label>
              <label className={fieldRow}>
                <span className={fieldRowLabel}>หมายเหตุ :</span>
                {/* flex-1 rather than a max-w-* cap like the fields above:
                    this one holds a sentence, so it takes whatever room the
                    row has left instead of a width picked in advance. */}
                <input
                  className={`${fieldControl} flex-1`}
                  value={draft.description ?? ''}
                  onChange={(e) => set('description', e.target.value === '' ? null : e.target.value)}
                />
              </label>
              <label className={fieldRow}>
                <span className={fieldRowLabel}>ลำดับการแสดง :</span>
                <input
                  type="number"
                  step={1}
                  className={`${fieldControl} max-w-32`}
                  value={draft.sortOrder}
                  onChange={(e) => set('sortOrder', Number(e.target.value))}
                />
              </label>
            </div>
          </section>

          <section className={`${card} mb-4`}>
            <label className="flex items-center gap-2 text-xs font-medium text-slate-600">
              <input
                type="checkbox"
                checked={draft.isActive}
                onChange={(e) => set('isActive', e.target.checked)}
              />
              <span>เปิดใช้งาน</span>
            </label>
          </section>
        </fieldset>

        {canWrite ? (
          <div className="flex items-center gap-2.5 pt-1">
            <button className={button('primary')} type="submit" disabled={saving}>
              {saving ? 'กำลังบันทึก…' : 'บันทึก'}
            </button>
            <button
              className={button()}
              type="button"
              onClick={() => void navigate('/master/finance-items')}
              disabled={saving}
            >
              ยกเลิก
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-2.5 pt-1">
            <button
              className={button()}
              type="button"
              onClick={() => void navigate('/master/finance-items')}
            >
              กลับ
            </button>
          </div>
        )}
      </form>
    </>
  )
}
