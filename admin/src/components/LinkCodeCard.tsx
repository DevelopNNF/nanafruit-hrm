import { useState } from 'react'
import { createLinkCode } from '../api/employees'
import { button, card, muted } from '../styles'

type State =
  | { phase: 'idle' }
  | { phase: 'issuing' }
  | { phase: 'issued'; code: string; expiresAt: string }
  | { phase: 'error'; message: string }

/**
 * Issues the code an employee types into liff/ to claim this record.
 *
 * Whether they are already linked is not shown, because the server does not put
 * it on the Employee contract — pressing the button on someone who is linked
 * comes back as a plain refusal instead. Enough for now; a badge would be better.
 */
export function LinkCodeCard({ employeeId }: { employeeId: number }) {
  const [state, setState] = useState<State>({ phase: 'idle' })

  async function issue() {
    setState({ phase: 'issuing' })
    try {
      const { code, expiresAt } = await createLinkCode(employeeId)
      setState({ phase: 'issued', code, expiresAt })
    } catch (err) {
      setState({
        phase: 'error',
        message: err instanceof Error ? err.message : 'ออกรหัสไม่สำเร็จ',
      })
    }
  }

  return (
    <section className={`${card} mb-4`}>
      <h2 className="mb-5 border-b border-slate-200 pb-3 text-xs font-bold tracking-wider text-slate-500 uppercase">
        การผูกบัญชี LINE
      </h2>
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
    </section>
  )
}
