import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import type { AttendanceEventType } from '@hrm/shared'
import { ApiRequestError } from '../../api/client'
import { createTimeCorrectionForEmployee, fetchTimeCorrectionEligibleEmployees } from '../../api/timeCorrections'
import { DatePicker } from '../../components/DatePicker'
import { EmployeeCombobox, type EmployeeComboboxCandidate } from '../../components/EmployeeCombobox'
import { notify } from '../../notifications/notify'
import {
  alert,
  alertDetail,
  alertTitle,
  button,
  card,
  eyebrow,
  fieldControl,
  fieldLabel,
  muted,
  pageHead,
  requiredMark,
  subtitle,
} from '../../styles'
import { ArrowLeft } from 'lucide-react'

type EligibleState =
  | { phase: 'loading' }
  | { phase: 'ok'; scope: 'all' | 'team'; employees: EmployeeComboboxCandidate[] }
  | { phase: 'forbidden' }
  | { phase: 'error'; message: string }

/** Today, local device time, as 'YYYY-MM-DD' — a correction can never be for
 *  a moment that hasn't happened yet, same bound liff's own form uses. */
function today(): string {
  const now = new Date()
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/**
 * "ขอแก้ไขเวลาแทนพนักงาน" — the Admin-side counterpart to liff's
 * TimeCorrectionCard, for one employee at a time. Who shows up in the picker
 * depends on the signed-in account: HR/Admin sees every active employee, a
 * supervisor sees only their own active direct reports, and anyone else gets
 * a 403 the page shows as "no access" — mirrors BulkOvertimeRequestPage's
 * eligible-employees handling.
 */
export function AdminTimeCorrectionRequestPage() {
  const navigate = useNavigate()
  const [eligibleState, setEligibleState] = useState<EligibleState>({ phase: 'loading' })
  const [employeeId, setEmployeeId] = useState<number | null>(null)
  const [eventType, setEventType] = useState<AttendanceEventType>('check_in')
  const [date, setDate] = useState(today())
  const [time, setTime] = useState('')
  const [reason, setReason] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    fetchTimeCorrectionEligibleEmployees(controller.signal)
      .then((res) => setEligibleState({ phase: 'ok', scope: res.scope, employees: res.employees }))
      .catch((err: unknown) => {
        if (controller.signal.aborted) return
        if (err instanceof ApiRequestError && err.code === 'FORBIDDEN') {
          setEligibleState({ phase: 'forbidden' })
          return
        }
        setEligibleState({ phase: 'error', message: err instanceof Error ? err.message : 'request failed' })
      })
    return () => controller.abort()
  }, [])

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    if (employeeId === null) {
      notify.error('ยังไม่ได้เลือกพนักงาน', 'ค้นหาและเลือกพนักงานก่อนบันทึก')
      return
    }
    if (date === '' || time === '') {
      notify.error('กรอกวันและเวลาไม่ครบ', 'ระบุวันที่และเวลาก่อนบันทึก')
      return
    }
    if (reason.trim() === '') {
      notify.error('ยังไม่ได้ระบุเหตุผล', 'กรอกเหตุผลการแก้ไขเวลาก่อนบันทึก')
      return
    }
    const requestedEventTime = new Date(`${date}T${time}`)
    if (requestedEventTime.getTime() > Date.now()) {
      notify.error('เวลาที่ระบุยังไม่เกิดขึ้น', 'ไม่สามารถขอแก้ไขเวลาที่ยังไม่เกิดขึ้นได้')
      return
    }

    setSubmitting(true)
    setError(null)
    try {
      const { request } = await createTimeCorrectionForEmployee({
        employeeId,
        eventType,
        requestedEventTime: requestedEventTime.toISOString(),
        reason: reason.trim(),
      })
      notify.success('ส่งคำขอแก้ไขเวลาแล้ว')
      navigate(`/time-corrections/${request.id}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'บันทึกไม่สำเร็จ')
    } finally {
      setSubmitting(false)
    }
  }

  const employees = eligibleState.phase === 'ok' ? eligibleState.employees : []

  return (
    <>
      <header className={pageHead}>
        <div>
          <p className={eyebrow}>
            <Link
              className="inline-flex items-center gap-1.5 text-slate-500 no-underline normal-case tracking-normal hover:text-navy"
              to="/time-corrections"
            >
              <ArrowLeft size={13} />
              กลับไปรายการคำขอ
            </Link>
          </p>
          <h1>ขอแก้ไขเวลาแทนพนักงาน</h1>
          <p className={subtitle}>
            สำหรับหัวหน้างานยื่นแทนลูกน้องของตัวเอง หรือ HR/Admin ยื่นแทนพนักงานคนใดก็ได้ — คำขอยังต้องผ่านการอนุมัติตามปกติ
          </p>
        </div>
      </header>

      {error && (
        <div className={alert('danger')}>
          <p className={alertTitle('danger')}>บันทึกไม่สำเร็จ</p>
          <p className={alertDetail}>{error}</p>
        </div>
      )}

      {eligibleState.phase === 'forbidden' && (
        <div className={alert('danger')}>
          <p className={alertTitle('danger')}>ไม่มีสิทธิ์เข้าถึงหน้านี้</p>
          <p className={alertDetail}>
            หน้านี้ใช้ได้เฉพาะ HR, Admin หรือหัวหน้างานที่มีพนักงานในการดูแล — ถ้าคิดว่าควรมีสิทธิ์ กรุณาติดต่อ HR
          </p>
        </div>
      )}

      {eligibleState.phase === 'error' && (
        <div className={alert('danger')}>
          <p className={alertTitle('danger')}>โหลดรายชื่อพนักงานไม่สำเร็จ</p>
          <p className={alertDetail}>{eligibleState.message}</p>
        </div>
      )}

      {eligibleState.phase !== 'forbidden' && (
        <form className={card} onSubmit={(e) => void handleSubmit(e)}>
          <label className={`${fieldLabel} mb-4`}>
            <span>
              พนักงาน <span className={requiredMark}>*</span>
            </span>
            {eligibleState.phase === 'loading' ? (
              <p className={muted}>กำลังโหลดรายชื่อพนักงาน…</p>
            ) : (
              <EmployeeCombobox candidates={employees} value={employeeId} onChange={setEmployeeId} />
            )}
          </label>

          {eligibleState.phase === 'ok' && employees.length === 0 && (
            <p className={`${muted} mb-4`}>
              {eligibleState.scope === 'team' ? 'ยังไม่มีพนักงานในการดูแลของคุณ' : 'ยังไม่มีพนักงานที่ยังทำงานอยู่ในระบบ'}
            </p>
          )}

          <div className="mb-4 flex flex-wrap items-end gap-3">
            <label className={fieldLabel}>
              <span>
                วันที่ <span className={requiredMark}>*</span>
              </span>
              <DatePicker required value={date} onChange={setDate} max={today()} />
            </label>
            <label className={fieldLabel}>
              <span>
                เวลา <span className={requiredMark}>*</span>
              </span>
              <input
                type="time"
                required
                className={fieldControl}
                value={time}
                onChange={(e) => setTime(e.target.value)}
              />
            </label>
            <label className={fieldLabel}>
              <span>
                ประเภท <span className={requiredMark}>*</span>
              </span>
              <select
                className={fieldControl}
                value={eventType}
                onChange={(e) => setEventType(e.target.value as AttendanceEventType)}
              >
                <option value="check_in">เข้างาน</option>
                <option value="check_out">ออกงาน</option>
              </select>
            </label>
          </div>

          <label className={`${fieldLabel} mb-4`}>
            <span>
              เหตุผล <span className={requiredMark}>*</span>
            </span>
            <textarea
              required
              rows={2}
              className={fieldControl}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>

          <div className="flex w-full justify-end">
            <button
              className={button('primary')}
              type="submit"
              disabled={submitting || eligibleState.phase !== 'ok'}
            >
              {submitting ? 'กำลังบันทึก…' : 'ส่งคำขอ'}
            </button>
          </div>
        </form>
      )}
    </>
  )
}
