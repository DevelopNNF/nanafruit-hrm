import { useState } from 'react'
import type { Employee } from '@hrm/shared'
import { createLinkCode, unlinkLineAccount } from '../api/employees'
import { notify } from '../notifications/notify'
import { badge, button, card, muted } from '../styles'

type State =
  | { phase: 'idle' }
  | { phase: 'issuing' }
  | { phase: 'issued'; code: string; expiresAt: string }
  | { phase: 'error'; message: string }

/** Issues the code an employee types into liff/ to claim this record. */
export function LinkCodeCard({
  employee,
  onSaved,
}: {
  employee: Employee
  onSaved: (employee: Employee) => void
}) {
  const [state, setState] = useState<State>({ phase: 'idle' })
  const [unlinking, setUnlinking] = useState(false)

  async function issue() {
    setState({ phase: 'issuing' })
    try {
      const { code, expiresAt } = await createLinkCode(employee.id)
      setState({ phase: 'issued', code, expiresAt })
    } catch (err) {
      setState({
        phase: 'error',
        message: err instanceof Error ? err.message : 'ออกรหัสไม่สำเร็จ',
      })
    }
  }

  async function unlink() {
    if (!confirm('ยกเลิกการผูกบัญชี LINE ของพนักงานคนนี้?')) return
    setUnlinking(true)
    try {
      await unlinkLineAccount(employee.id)
      setState({ phase: 'idle' })
      onSaved({ ...employee, lineLinked: false })
      notify.success('ยกเลิกการผูกบัญชี LINE สำเร็จ')
    } catch (err) {
      notify.error('ยกเลิกการผูกบัญชีไม่สำเร็จ', err instanceof Error ? err.message : undefined)
    } finally {
      setUnlinking(false)
    }
  }

  return (
    <section className={`${card} mb-4`}>
      <h2 className="mb-5 border-b border-slate-200 pb-3 text-xs font-bold tracking-wider text-slate-500 uppercase">
        การผูกบัญชี LINE
      </h2>

      {employee.lineLinked ? (
        <div className="flex flex-wrap items-center gap-3">
          <span className={badge('active')}>ผูกบัญชี LINE แล้ว</span>
          <button
            className={button('danger')}
            type="button"
            onClick={() => void unlink()}
            disabled={unlinking}
          >
            {unlinking ? 'กำลังยกเลิก…' : 'ยกเลิกการผูกกับบัญชีนี้'}
          </button>
        </div>
      ) : (
        <>
          <p className={`mb-4 ${muted}`}>
            ออกรหัสให้พนักงานกรอกในแอป LIFF เพื่อผูกบัญชี LINE เข้ากับข้อมูลนี้ ใช้ได้ครั้งเดียว
            ภายใน 24 ชั่วโมง
          </p>

          {state.phase === 'issued' ? (
            <div className="flex flex-col items-start gap-2.5">
              <code className="rounded-md border border-dashed border-slate-300 bg-slate-50 px-3.5 py-2 font-mono text-2xl font-semibold tracking-widest text-slate-900 select-all">
                {state.code}
              </code>
              <p className={muted}>
                หมดอายุ {new Date(state.expiresAt).toLocaleString('th-TH')} — คัดลอกไว้ตอนนี้
                ระบบไม่เก็บรหัสนี้ไว้และเปิดดูซ้ำไม่ได้ ถ้าหายต้องออกใหม่
              </p>
            </div>
          ) : (
            <button
              className={button()}
              type="button"
              onClick={() => void issue()}
              disabled={state.phase === 'issuing'}
            >
              {state.phase === 'issuing' ? 'กำลังออกรหัส…' : 'ออกรหัสผูกบัญชี'}
            </button>
          )}

          {state.phase === 'error' && (
            <p className="mt-3 font-mono text-[0.775rem] break-words text-red-700">
              {state.message}
            </p>
          )}
        </>
      )}
    </section>
  )
}
