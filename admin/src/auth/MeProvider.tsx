import { useEffect, useState, type ReactNode } from 'react'
import type { AuthUser } from '@hrm/shared'
import { getMe } from '../api/me'
import { MeContext } from './meContext'

type State =
  | { phase: 'loading' }
  | { phase: 'ready'; me: AuthUser }
  | { phase: 'error'; message: string }

/**
 * Asks the server who we are, once, and holds the answer for the whole app.
 *
 * It has to be the server's answer rather than the token's claims: the server is
 * what enforces them, and a UI that decided for itself would be free to disagree
 * with the thing that says no.
 */
export function MeProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>({ phase: 'loading' })

  useEffect(() => {
    const controller = new AbortController()
    getMe(controller.signal).then(
      (me) => setState({ phase: 'ready', me }),
      (err: unknown) => {
        if (controller.signal.aborted) return
        setState({
          phase: 'error',
          message: err instanceof Error ? err.message : 'request failed',
        })
      }
    )
    return () => controller.abort()
  }, [])

  if (state.phase === 'loading') {
    return (
      <div className="auth-screen">
        <p>กำลังโหลด…</p>
      </div>
    )
  }

  if (state.phase === 'error') {
    return (
      <div className="auth-screen">
        <h1>เชื่อมต่อระบบไม่สำเร็จ</h1>
        <p className="detail">{state.message}</p>
      </div>
    )
  }

  // Signed in, but Entra has granted them nothing. Every page would be an empty
  // table over a 403, so say the one useful thing instead. This is why /api/me
  // takes a token but no role — it can still answer this person.
  if (state.me.kind === 'admin' && state.me.roles.length === 0) {
    return (
      <div className="auth-screen">
        <h1>ยังไม่ได้รับสิทธิ์</h1>
        <p className="hint">
          บัญชี {state.me.upn} เข้าสู่ระบบได้ แต่ยังไม่ได้รับสิทธิ์ใช้งาน HRM
          กรุณาติดต่อฝ่าย IT เพื่อขอสิทธิ์
        </p>
      </div>
    )
  }

  return <MeContext value={state.me}>{children}</MeContext>
}

