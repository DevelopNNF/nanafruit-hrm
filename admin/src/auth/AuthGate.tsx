import { useState, type ReactNode } from 'react'
import { InteractionStatus } from '@azure/msal-browser'
import { useIsAuthenticated, useMsal } from '@azure/msal-react'
import { Link2, ShieldCheck, Users } from 'lucide-react'
import { MicrosoftMark } from '../components/MicrosoftMark'
import { alert, alertDetail, alertTitle, button } from '../styles'
import { apiRequest } from './msal'

/**
 * Nothing inside renders until there is a signed-in account.
 *
 * Visitors are shown a sign-in screen and choose to start, rather than being
 * bounced to Microsoft the moment the page loads. The redirect is still what
 * does the signing in — this only puts a door in front of it, so that a person
 * landing here sees which system they are entering and why, instead of watching
 * the browser navigate somewhere they did not ask for.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const { instance, inProgress } = useMsal()
  const isAuthenticated = useIsAuthenticated()
  const [error, setError] = useState<string | null>(null)

  if (isAuthenticated) return <>{children}</>

  // Covers both legs of a redirect sign-in: MsalProvider resolving a pending
  // one on mount, and the outbound trip after the button is pressed. Neither is
  // a moment to offer the button again.
  if (inProgress !== InteractionStatus.None) {
    return <SignInPending />
  }

  function signIn() {
    setError(null)
    // A rejection here is the redirect failing to start — MSAL not initialised,
    // popups/redirects blocked, config wrong. Anything after the navigation is
    // reported on the way back in, not here.
    instance.loginRedirect(apiRequest).catch((err: unknown) => {
      setError(err instanceof Error ? err.message : 'เริ่มการเข้าสู่ระบบไม่สำเร็จ')
    })
  }

  return <SignInScreen onSignIn={signIn} error={error} />
}

function SignInScreen({
  onSignIn,
  error,
}: {
  onSignIn: () => void
  error: string | null
}) {
  return (
    <div className="grid min-h-svh flex-1 bg-white shell:grid-cols-2">
      {/* Decorative half: says which system this is, to someone who arrived at a
          bare origin with no idea what lives here. Dropped on narrow screens,
          where the form is the only thing worth the space. */}
      <aside className="hidden flex-col justify-between bg-gradient-to-br from-shell to-[#071a33]
        p-12 text-shell-fg shell:flex">
        <div className="my-auto max-w-96">
          <div className="mb-6 grid size-12 place-items-center rounded-[10px] bg-white/10 text-white">
            <Users size={22} />
          </div>
          <h1 className="text-4xl font-bold tracking-wide text-white">HRM</h1>
          <p className="mt-1.5 text-sm text-shell-fg-dim">
            ระบบบริหารทรัพยากรบุคคล · Nanafruit
          </p>

          <ul className="mt-10 flex flex-col gap-3.5">
            <li className="flex items-center gap-3 text-sm text-shell-fg">
              <Users size={16} className="flex-none text-shell-fg-dim" />
              <span>ทะเบียนประวัติพนักงาน</span>
            </li>
            <li className="flex items-center gap-3 text-sm text-shell-fg">
              <Link2 size={16} className="flex-none text-shell-fg-dim" />
              <span>ผูกบัญชี LINE ของพนักงาน</span>
            </li>
            <li className="flex items-center gap-3 text-sm text-shell-fg">
              <ShieldCheck size={16} className="flex-none text-shell-fg-dim" />
              <span>เข้าถึงตามสิทธิ์ที่ได้รับ</span>
            </li>
          </ul>
        </div>
        <p className="text-xs text-shell-fg-dim/80">สำหรับพนักงานภายในองค์กรเท่านั้น</p>
      </aside>

      <main className="grid place-items-center p-8">
        <div className="w-full max-w-88">
          <h2 className="text-2xl font-semibold">เข้าสู่ระบบ</h2>
          <p className="mt-1.5 mb-6 text-sm text-slate-500">
            ใช้บัญชี Microsoft 365 ขององค์กรเพื่อเข้าใช้งานระบบ
          </p>

          {error && (
            <div className={alert('danger')} role="alert">
              <p className={alertTitle('danger')}>เข้าสู่ระบบไม่สำเร็จ</p>
              <p className={alertDetail}>{error}</p>
            </div>
          )}

          <button type="button" className={`${button('primary')} w-full`} onClick={onSignIn}>
            <MicrosoftMark size={18} />
            เข้าสู่ระบบด้วย Microsoft
          </button>

          <p className="mt-3.5 text-center text-xs text-slate-500">
            ระบบจะพาไปยังหน้าลงชื่อเข้าใช้ของ Microsoft
            แล้วกลับมาที่นี่โดยอัตโนมัติ
          </p>

          <p className="mt-8 border-t border-slate-200 pt-5 text-center text-xs text-slate-500">
            เข้าใช้งานไม่ได้? กรุณาติดต่อฝ่าย IT เพื่อขอสิทธิ์
          </p>
        </div>
      </main>
    </div>
  )
}

function SignInPending() {
  return (
    <div className="grid min-h-svh flex-1 place-items-center bg-white p-8">
      <div className="flex flex-col items-center gap-4 text-center">
        <div className="size-6 animate-spin rounded-full border-2 border-slate-200 border-t-navy" />
        <p className="text-sm text-slate-500">กำลังเข้าสู่ระบบ…</p>
      </div>
    </div>
  )
}
