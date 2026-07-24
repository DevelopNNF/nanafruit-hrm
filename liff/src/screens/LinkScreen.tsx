import { useState } from 'react'
import type { LineSessionResponse } from '@hrm/shared'
import { ApiRequestError } from '../api/client'
import { linkAccount } from '../api/auth'

type Props = {
  idToken: string
  onLinked: (session: LineSessionResponse) => void
}

/**
 * The server answers every bad code the same way — expired, spent, and never
 * real are one response — so there is nothing here to translate. These read the
 * status instead, and say the one thing the employee can act on.
 */
function messageFor(err: unknown): string {
  if (err instanceof ApiRequestError) {
    if (err.status === 409) {
      return 'บัญชี LINE นี้ถูกผูกกับพนักงานคนอื่นไปแล้ว กรุณาติดต่อฝ่ายบุคคล'
    }
    if (err.status === 400) {
      return 'รหัสไม่ถูกต้องหรือหมดอายุแล้ว กรุณาตรวจสอบอีกครั้ง หรือขอรหัสใหม่จากฝ่ายบุคคล'
    }
  }
  return 'เชื่อมต่อไม่สำเร็จ กรุณาลองใหม่อีกครั้ง'
}

export function LinkScreen({ idToken, onLinked }: Props) {
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      onLinked(await linkAccount(idToken, code))
    } catch (err) {
      setError(messageFor(err))
      setBusy(false)
    }
    // No setBusy(false) on success: onLinked swaps this screen out, and a state
    // update on the way there would land on an unmounted component.
  }

  return (
    <main className="app">
      <h1>HRM</h1>
      <p className="subtitle">ผูกบัญชีกับข้อมูลพนักงาน</p>

      <div className="card loading">
        <p className="headline">กรอกรหัสผูกบัญชี</p>
        <p className="hint">
          ขอรหัส 8 หลักจากฝ่ายบุคคล แล้วกรอกที่นี่เพื่อผูกบัญชี LINE ของคุณเข้ากับข้อมูลพนักงาน
          ทำเพียงครั้งเดียว
        </p>

        <form onSubmit={submit} className="link-form">
          <input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="ABCD-EFGH"
            // The code has no lowercase, no accents and no spell-checking to do,
            // and a phone keyboard will fight all three unless told not to.
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            inputMode="text"
            aria-label="รหัสผูกบัญชี"
            disabled={busy}
          />
          <button type="submit" disabled={busy || code.trim() === ''}>
            {busy ? 'กำลังตรวจสอบ…' : 'ผูกบัญชี'}
          </button>
        </form>

        {error !== null && <p className="form-error">{error}</p>}
      </div>
    </main>
  )
}
