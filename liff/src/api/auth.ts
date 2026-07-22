import type {
  LineLinkRequest,
  LineLinkResponse,
  LineSessionRequest,
  LineSessionResponse,
} from '@hrm/shared'
import { ApiRequestError, apiUrl, jsonHeaders, setSessionToken, unwrap } from './client'

async function post<T>(path: string, body: unknown): Promise<T> {
  // No Authorization header: these are the two routes that exist to produce one.
  const res = await fetch(apiUrl(path), {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify(body),
  })
  return unwrap<T>(res)
}

/**
 * Trades the LINE ID token for an HRM session.
 *
 * Returns null when LINE knows this person but no employee record claims them —
 * a normal first-run state, not a failure, so it is a value rather than a throw.
 * The caller shows the link screen.
 */
export async function startSession(idToken: string): Promise<LineSessionResponse | null> {
  const request: LineSessionRequest = { idToken }
  try {
    const session = await post<LineSessionResponse>('/api/auth/line/session', request)
    setSessionToken(session.token)
    return session
  } catch (err) {
    if (err instanceof ApiRequestError && err.code === 'NOT_LINKED') return null
    throw err
  }
}

/** Claims an employee record with a code from HR, and lands in a session. */
export async function linkAccount(
  idToken: string,
  code: string
): Promise<LineSessionResponse> {
  const request: LineLinkRequest = { idToken, code }
  const session = await post<LineLinkResponse>('/api/auth/line/link', request)
  setSessionToken(session.token)
  return session
}
