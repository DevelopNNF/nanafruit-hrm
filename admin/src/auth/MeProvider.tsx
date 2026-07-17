import { useEffect, useState, type ReactNode } from 'react'
import type { AuthUser } from '@hrm/shared'
import { getMe } from '../api/me'
import { alert, alertDetail, muted } from '../styles'
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
      <AuthScreen>
        <div className="mx-auto mb-4 size-6 animate-spin rounded-full border-2 border-slate-200 border-t-navy" />
        <p className={muted}>กำลังโหลดข้อมูลผู้ใช้…</p>
      </AuthScreen>
    )
  }

  if (state.phase === 'error') {
    return (
      <AuthScreen>
        <h1 className="mb-3">เชื่อมต่อระบบไม่สำเร็จ</h1>
        <p className="mb-4 text-sm text-slate-500">
          ลองโหลดหน้านี้ใหม่ หากยังไม่ได้กรุณาติดต่อฝ่าย IT
        </p>
        <div className={`${alert('danger')} text-left`}>
          <p className={alertDetail}>{state.message}</p>
        </div>
      </AuthScreen>
    )
  }

  // Signed in, but Entra has granted them nothing. Every page would be an empty
  // table over a 403, so say the one useful thing instead. This is why /api/me
  // takes a token but no role — it can still answer this person.
  if (state.me.kind === 'admin' && state.me.roles.length === 0) {
    return (
      <AuthScreen>
        <h1 className="mb-3">ยังไม่ได้รับสิทธิ์</h1>
        <p className="text-sm text-slate-500">
          บัญชี {state.me.upn} เข้าสู่ระบบได้ แต่ยังไม่ได้รับสิทธิ์ใช้งาน HRM
          กรุณาติดต่อฝ่าย IT เพื่อขอสิทธิ์
        </p>
      </AuthScreen>
    )
  }

  return <MeContext value={state.me}>{children}</MeContext>
}

/** Rendered before the layout exists — these own the whole viewport rather
 *  than sitting inside .content. */
function AuthScreen({ children }: { children: ReactNode }) {
  return (
    <div className="m-auto max-w-md p-8 text-center">{children}</div>
  )
}
