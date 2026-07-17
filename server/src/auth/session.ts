// The sessions we issue to liff/.
//
// Why liff/ carries our token instead of LINE's: a LINE ID token is short-lived
// and the LIFF SDK does not renew it, so sending it on every request would mean
// a 401 mid-session whenever it lapsed. Exchanging it once for a token of our
// own also gives us somewhere to put the employee id, which LINE knows nothing
// about — after this, no request has to ask LINE anything.

import { SignJWT, errors, jwtVerify } from 'jose'
import { authConfig } from './config.js'
import { TokenError } from './errors.js'
import type { EmployeeUser } from './types.js'

/**
 * The `iss` on our own tokens. Not a URL, which is the point: it cannot collide
 * with Entra's, so the issuer peek in middleware.ts stays unambiguous.
 */
export const HRM_ISSUER = 'hrm'

/**
 * Long enough to cover a working day without a phone being asked to sign in
 * again, short enough that access ends the same day someone leaves. The token is
 * self-contained, so nothing revokes it early — an employee deleted at 9am can
 * still read their own record until this expires. That is the trade being made,
 * and the reason it is hours rather than days.
 */
const TTL_MS = 8 * 60 * 60 * 1000

const key = new TextEncoder().encode(authConfig.sessionSecret)

export type Session = { token: string; expiresAt: Date }

export async function issueSession(employeeId: number): Promise<Session> {
  const expiresAt = new Date(Date.now() + TTL_MS)
  const token = await new SignJWT({ kind: 'employee' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(HRM_ISSUER)
    .setSubject(String(employeeId))
    .setIssuedAt()
    .setExpirationTime(expiresAt)
    .sign(key)
  return { token, expiresAt }
}

export async function verifySession(token: string): Promise<EmployeeUser> {
  let sub: string | undefined
  try {
    const { payload } = await jwtVerify(token, key, {
      issuer: HRM_ISSUER,
      // Pinning the algorithm is what stops a token that names its own weaker
      // one from being taken at its word.
      algorithms: ['HS256'],
    })
    sub = payload.sub
  } catch (err) {
    // Same rule as the Entra verifier: only a JOSEError means the token is
    // wrong. There is no network here, but a thrown TypeError still should not
    // be reported to a user as "your session is invalid".
    if (!(err instanceof errors.JOSEError)) throw err
    throw new TokenError('session is not valid')
  }

  const employeeId = Number(sub)
  if (!Number.isInteger(employeeId) || employeeId <= 0) {
    throw new TokenError('session names no employee')
  }
  return { kind: 'employee', employeeId }
}
