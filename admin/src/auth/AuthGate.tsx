import type { ReactNode } from 'react'
import { InteractionType } from '@azure/msal-browser'
import { MsalAuthenticationTemplate, type MsalAuthenticationResult } from '@azure/msal-react'
import { apiRequest } from './msal'

function SigningIn() {
  return (
    <div className="auth-screen">
      <p>กำลังเข้าสู่ระบบ…</p>
    </div>
  )
}

function SignInFailed({ error }: MsalAuthenticationResult) {
  return (
    <div className="auth-screen">
      <h1>เข้าสู่ระบบไม่สำเร็จ</h1>
      <p className="detail">{error?.errorMessage ?? 'ไม่ทราบสาเหตุ'}</p>
      <p className="hint">ลองโหลดหน้านี้ใหม่ หากยังไม่ได้กรุณาติดต่อฝ่าย IT</p>
    </div>
  )
}

/**
 * Nothing inside renders until there is a signed-in account. With Redirect,
 * a visitor without one is sent to Microsoft immediately rather than being
 * shown a page whose only content is a sign-in button — for an internal tool
 * where every visitor is staff, that extra click has nothing to offer.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  return (
    <MsalAuthenticationTemplate
      interactionType={InteractionType.Redirect}
      authenticationRequest={apiRequest}
      loadingComponent={SigningIn}
      errorComponent={SignInFailed}
    >
      {children}
    </MsalAuthenticationTemplate>
  )
}
