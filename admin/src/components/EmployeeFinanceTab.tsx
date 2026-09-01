import { useEffect, useState } from 'react'
import {
  PAYMENT_METHODS,
  SOCIAL_SECURITY_TYPES,
  TAX_TYPES,
  type EmployeeFinance,
  type EmployeeFinanceInput,
  type PaymentMethod,
  type SocialSecurityType,
  type TaxType,
} from '@hrm/shared'
import { getEmployeeFinance, updateEmployeeFinance } from '../api/employees'
import { EmployeeFinanceItemsCard } from './EmployeeFinanceItemsCard'
import { WageHistoryCard } from './WageHistoryCard'
import { notify } from '../notifications/notify'
import {
  PAYMENT_METHOD_LABELS,
  SOCIAL_SECURITY_TYPE_LABELS,
  TAX_TYPE_LABELS,
} from './employeeFinanceLabels'
import {
  alert,
  alertDetail,
  alertTitle,
  button,
  card,
  fieldControl,
  fieldLabel,
  muted,
  requiredMark,
} from '../styles'

const fieldGrid = 'grid gap-x-5 gap-y-4 grid-cols-[repeat(auto-fit,minmax(13rem,1fr))]'
const sectionTitle = 'mb-5 border-b border-slate-200 pb-3 text-xs font-bold tracking-wider text-slate-500 uppercase'

/** Only SCB is supported today — same fixed value as the DB column's
 *  default, shown before the first save when nothing has come back from the
 *  server yet. */
const DEFAULT_BANK_NAME = 'ไทยพาณิชย์ (SCB)'

const CASH_PAYMENT: PaymentMethod = 'cash'
const SOCIAL_SECURITY_FIXED: SocialSecurityType = 'fixed_monthly'
const TAX_FIXED: TaxType = 'fixed_monthly'
const TAX_PERCENT: TaxType = 'percent_of_income'

/** Draft state for the 3 enum selects starts unset (`null`, rendered as the
 *  "— โปรดระบุ —" placeholder) rather than defaulting to PAYMENT_METHODS[0]
 *  etc. — an untouched dropdown should not silently submit whatever happens to
 *  be first in the list. Narrowed to EmployeeFinanceInput once
 *  missingFinanceFields confirms all 3 are picked, in handleSubmit. */
type FinanceDraft = Omit<
  EmployeeFinanceInput,
  'paymentMethod' | 'socialSecurityType' | 'taxType'
> & {
  paymentMethod: PaymentMethod | null
  socialSecurityType: SocialSecurityType | null
  taxType: TaxType | null
}

function emptyDraft(): FinanceDraft {
  return {
    paymentMethod: null,
    bankBranchCode: null,
    bankAccountNumber: '',
    socialSecurityType: null,
    socialSecurityFixedAmount: null,
    taxType: null,
    taxFixedAmount: null,
    taxPercent: null,
    taxStartMonth: null,
  }
}

function draftFrom(finance: EmployeeFinance): FinanceDraft {
  return {
    paymentMethod: finance.paymentMethod,
    bankBranchCode: finance.bankBranchCode,
    bankAccountNumber: finance.bankAccountNumber,
    socialSecurityType: finance.socialSecurityType,
    socialSecurityFixedAmount: finance.socialSecurityFixedAmount,
    taxType: finance.taxType,
    taxFixedAmount: finance.taxFixedAmount,
    taxPercent: finance.taxPercent,
    taxStartMonth: finance.taxStartMonth,
  }
}

/** Same reasoning as EmployeeBasicTab's missingBasicFields: custom/native
 *  controls here don't reliably surface the browser's own validation
 *  bubble, so this is the one path that always runs and is always visible. */
function missingFinanceFields(draft: FinanceDraft): string[] {
  const missing: string[] = []
  if (!draft.paymentMethod) missing.push('ช่องทางการจ่ายค่าจ้าง')
  if (draft.paymentMethod !== CASH_PAYMENT && !draft.bankAccountNumber.trim()) {
    missing.push('เลขที่บัญชี')
  }
  if (!draft.socialSecurityType) missing.push('ประกันสังคม')
  if (
    draft.socialSecurityType === SOCIAL_SECURITY_FIXED &&
    (draft.socialSecurityFixedAmount === null || draft.socialSecurityFixedAmount <= 0)
  ) {
    missing.push('ค่าประกันสังคม')
  }
  if (!draft.taxType) missing.push('ภาษี')
  if (
    draft.taxType === TAX_FIXED &&
    (draft.taxFixedAmount === null || draft.taxFixedAmount <= 0)
  ) {
    missing.push('ค่าภาษีคงที่')
  }
  if (
    draft.taxType === TAX_PERCENT &&
    (draft.taxPercent === null || draft.taxPercent <= 0)
  ) {
    missing.push('เปอร์เซ็นต์ภาษี')
  }
  return missing
}

type FinanceState =
  | { phase: 'loading' }
  | { phase: 'ok'; finance: EmployeeFinance | null }
  | { phase: 'error'; message: string }

/**
 * Tab 5 of the employee edit screen: wage, bank, social security and
 * withholding-tax settings. Fetches its own data via GET
 * /employees/:id/finance rather than reading it off the Employee prop the
 * other tabs share — this data is HR/Admin-only (see the route's
 * canReadWriteFinance), so it can't ride along on the general employee read
 * every HRM role gets. Only rendered at all when the caller can write it —
 * see EmployeeFormPage, which hides this tab entirely for a Viewer.
 */
export function EmployeeFinanceTab({
  employeeId,
  canWrite,
}: {
  employeeId: number
  canWrite: boolean
}) {
  const [state, setState] = useState<FinanceState>({ phase: 'loading' })
  const [draft, setDraft] = useState<FinanceDraft>(emptyDraft)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    getEmployeeFinance(employeeId, controller.signal)
      .then((finance) => {
        setState({ phase: 'ok', finance })
        setDraft(finance ? draftFrom(finance) : emptyDraft())
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return
        setState({
          phase: 'error',
          message: err instanceof Error ? err.message : 'request failed',
        })
      })
    return () => controller.abort()
  }, [employeeId])

  function set<K extends keyof FinanceDraft>(key: K, value: FinanceDraft[K]) {
    setDraft((prev) => ({ ...prev, [key]: value }))
  }

  // Clearing the fixed amount when its type moves away from "คงที่" mirrors
  // ShiftFormPage's toggleHasBreak: a stale value left behind would otherwise
  // fail the server's consistency check on next save even though the field
  // is no longer shown.
  function setSocialSecurityType(value: SocialSecurityType | null) {
    setDraft((prev) => ({
      ...prev,
      socialSecurityType: value,
      socialSecurityFixedAmount: value === SOCIAL_SECURITY_FIXED ? prev.socialSecurityFixedAmount : null,
    }))
  }

  function setTaxType(value: TaxType | null) {
    setDraft((prev) => ({
      ...prev,
      taxType: value,
      taxFixedAmount: value === TAX_FIXED ? prev.taxFixedAmount : null,
      taxPercent: value === TAX_PERCENT ? prev.taxPercent : null,
    }))
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    const missing = missingFinanceFields(draft)
    if (missing.length > 0) {
      notify.error('กรอกข้อมูลไม่ครบ', `กรุณากรอก: ${missing.join(', ')}`)
      return
    }
    setSaving(true)
    setError(null)
    try {
      // The missing-field check above guarantees all 3 selects are picked,
      // so this narrows FinanceDraft down to the input the API wants.
      const input: EmployeeFinanceInput = {
        ...draft,
        paymentMethod: draft.paymentMethod as PaymentMethod,
        socialSecurityType: draft.socialSecurityType as SocialSecurityType,
        taxType: draft.taxType as TaxType,
      }
      const updated = await updateEmployeeFinance(employeeId, input)
      setState({ phase: 'ok', finance: updated })
      notify.success('บันทึกข้อมูลการเงินสำเร็จ')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'save failed')
    } finally {
      setSaving(false)
    }
  }

  if (state.phase === 'loading') return <p className={muted}>กำลังโหลด…</p>

  if (state.phase === 'error') {
    return (
      <div className={alert('danger')}>
        <p className={alertTitle('danger')}>โหลดข้อมูลการเงินไม่สำเร็จ</p>
        <p className={alertDetail}>{state.message}</p>
      </div>
    )
  }

  const bankName = state.finance?.bankName ?? DEFAULT_BANK_NAME
  const showBankFields = draft.paymentMethod !== CASH_PAYMENT && draft.paymentMethod !== null
  const showSocialSecurityFixedAmount = draft.socialSecurityType === SOCIAL_SECURITY_FIXED
  const showTaxFixedAmount = draft.taxType === TAX_FIXED
  const showTaxPercent = draft.taxType === TAX_PERCENT

  return (
    <>
      {error && (
        <div className={alert('danger')}>
          <p className={alertTitle('danger')}>บันทึกไม่สำเร็จ</p>
          <p className={alertDetail}>{error}</p>
        </div>
      )}

      {/* noValidate: same reasoning as EmployeeBasicTab — the missing-field
          toast below is the one validation path that always runs. */}
      <form noValidate onSubmit={(e) => void handleSubmit(e)}>
        <fieldset disabled={!canWrite} className="min-w-0 border-0 p-0">
          <section className={`${card} mb-4`}>
            <h2 className={sectionTitle}>ข้อมูลพื้นฐาน (Basic information)</h2>
            {/* No wage fields here since 046: a wage is a dated interval and
                is set in WageHistoryCard below, the way a shift is set in
                ShiftHistoryCard rather than on the employment form. */}
            <div className={fieldGrid}>
              <label className={fieldLabel}>
                <span>
                  ช่องทางการจ่ายค่าจ้าง <span className={requiredMark}>*</span>
                </span>
                <select
                  required
                  className={fieldControl}
                  value={draft.paymentMethod ?? ''}
                  onChange={(e) =>
                    set('paymentMethod', (e.target.value || null) as PaymentMethod | null)
                  }
                >
                  <option value="" disabled>
                    — โปรดระบุ —
                  </option>
                  {PAYMENT_METHODS.map((method) => (
                    <option key={method} value={method}>
                      {PAYMENT_METHOD_LABELS[method]}
                    </option>
                  ))}
                </select>
              </label>
              {showBankFields && (
                <>
                  <label className={fieldLabel}>
                    <span>ธนาคาร</span>
                    <input disabled className={fieldControl} value={bankName} readOnly />
                  </label>
                  <label className={fieldLabel}>
                    <span>รหัสสาขาธนาคาร</span>
                    <input
                      className={fieldControl}
                      value={draft.bankBranchCode ?? ''}
                      onChange={(e) => set('bankBranchCode', e.target.value || null)}
                    />
                  </label>
                  <label className={fieldLabel}>
                    <span>
                      เลขที่บัญชี <span className={requiredMark}>*</span>
                    </span>
                    <input
                      required
                      className={fieldControl}
                      value={draft.bankAccountNumber}
                      onChange={(e) => set('bankAccountNumber', e.target.value)}
                    />
                  </label>
                </>
              )}
            </div>
          </section>

          <section className={`${card} mb-4`}>
            <h2 className={sectionTitle}>ประกันสังคมและภาษี (Social security &amp; tax)</h2>
            <div className={fieldGrid}>
              {/* Social Security */}
              <label className={fieldLabel}>
                <span>
                  ประกันสังคม <span className={requiredMark}>*</span>
                </span>
                <select
                  required
                  className={fieldControl}
                  value={draft.socialSecurityType ?? ''}
                  onChange={(e) =>
                    setSocialSecurityType((e.target.value || null) as SocialSecurityType | null)
                  }
                >
                  <option value="" disabled>
                    — โปรดระบุ —
                  </option>
                  {SOCIAL_SECURITY_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {SOCIAL_SECURITY_TYPE_LABELS[type]}
                    </option>
                  ))}
                </select>
              </label>
              {showSocialSecurityFixedAmount && (
                <label className={fieldLabel}>
                  <span>
                    ค่าประกันสังคม <span className={requiredMark}>*</span>
                  </span>
                  <input
                    required
                    type="number"
                    step="0.01"
                    min="0.01"
                    inputMode="decimal"
                    className={fieldControl}
                    value={draft.socialSecurityFixedAmount ?? ''}
                    onChange={(e) =>
                      set(
                        'socialSecurityFixedAmount',
                        e.target.value === '' ? null : Number(e.target.value)
                      )
                    }
                  />
                </label>
              )}
              
              {/* Tax */}
              <label className={fieldLabel}>
                <span>
                  ภาษี <span className={requiredMark}>*</span>
                </span>
                <select
                  required
                  className={fieldControl}
                  value={draft.taxType ?? ''}
                  onChange={(e) => setTaxType((e.target.value || null) as TaxType | null)}
                >
                  <option value="" disabled>
                    — โปรดระบุ —
                  </option>
                  {TAX_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {TAX_TYPE_LABELS[type]}
                    </option>
                  ))}
                </select>
              </label>
              {showTaxFixedAmount && (
                <label className={fieldLabel}>
                  <span>
                    ค่าภาษีคงที่ <span className={requiredMark}>*</span>
                  </span>
                  <input
                    required
                    type="number"
                    step="0.01"
                    min="0.01"
                    inputMode="decimal"
                    className={fieldControl}
                    value={draft.taxFixedAmount ?? ''}
                    onChange={(e) =>
                      set('taxFixedAmount', e.target.value === '' ? null : Number(e.target.value))
                    }
                  />
                </label>
              )}
              {showTaxPercent && (
                <label className={fieldLabel}>
                  <span>
                    เปอร์เซ็นต์ภาษี <span className={requiredMark}>*</span>
                  </span>
                  <input
                    required
                    type="number"
                    step="0.01"
                    min="0.01"
                    max="100"
                    inputMode="decimal"
                    className={fieldControl}
                    value={draft.taxPercent ?? ''}
                    onChange={(e) =>
                      set('taxPercent', e.target.value === '' ? null : Number(e.target.value))
                    }
                  />
                </label>
              )}
              <label className={fieldLabel}>
                <span>เดือนที่เริ่มคำนวณภาษี</span>
                <input
                  type="month"
                  className={fieldControl}
                  value={draft.taxStartMonth ? draft.taxStartMonth.slice(0, 7) : ''}
                  onChange={(e) => set('taxStartMonth', e.target.value ? `${e.target.value}-01` : null)}
                />
              </label>
            </div>
          </section>
        </fieldset>

        {/* Inside this form, so the save button below stays at the bottom of
            the page rather than having a card sit under it. The card saves a
            row at a time on its own and must not disturb this form to do it —
            it has no <form> of its own, all of its buttons are type="button",
            and it swallows Enter in its row inputs. See its own comment: those
            three are what make this placement safe. */}
        <div className="mt-4">
          <WageHistoryCard employeeId={employeeId} canWrite={canWrite} />
          <EmployeeFinanceItemsCard employeeId={employeeId} canWrite={canWrite} />
        </div>

        {canWrite && (
          <div className="flex items-center gap-2.5 pt-1">
            <button className={button('primary')} type="submit" disabled={saving}>
              {saving ? 'กำลังบันทึก…' : 'บันทึก'}
            </button>
          </div>
        )}
      </form>
    </>
  )
}
