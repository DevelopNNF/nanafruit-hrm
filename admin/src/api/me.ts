import type { AuthUser, MeResponse } from '@hrm/shared'
import { apiFetch, unwrap } from './client'

/**
 * Who the server thinks we are. MSAL already knows the signed-in account, but
 * only the server can say which roles it will honour — asking it is what keeps
 * the UI and the enforcement from disagreeing.
 */
export async function getMe(signal?: AbortSignal): Promise<AuthUser> {
  const res = await apiFetch('/api/me', { signal })
  const body = await unwrap<MeResponse>(res)
  return body.user
}
