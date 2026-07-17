import { Router } from 'express'
import type { Request, Response } from 'express'
import type { Employee, LineLinkResponse, LineSessionResponse } from '@hrm/shared'
import { recordAudit } from '../audit.js'
import { withTransaction } from '../db.js'
import { findEmployeeById, findEmployeeByLineUserId } from '../employeeQueries.js'
import { TokenError } from '../auth/errors.js'
import { hashLinkCode } from '../auth/linkCode.js'
import { verifyLineIdToken } from '../auth/line.js'
import { issueSession } from '../auth/session.js'
import { fail, handleUnexpected } from '../http.js'
import { linkLimiter, sessionLimiter } from '../rateLimit.js'

export const authRouter = Router()

// These two are the front door for liff/ and therefore cannot sit behind
// `authenticate` — they are how a caller gets something to authenticate with.
// What stands in for it is the LINE ID token in the body, which is verified
// before either route does anything else.

function readString(body: unknown, key: string): string | null {
  if (typeof body !== 'object' || body === null) return null
  const value = (body as Record<string, unknown>)[key]
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

function sessionBody(token: string, expiresAt: Date, employee: Employee): LineSessionResponse {
  return { token, expiresAt: expiresAt.toISOString(), employee }
}

/** Turns a TokenError into a 401 and anything else into a 500, as everywhere else. */
function failVerify(res: Response, err: unknown): void {
  if (err instanceof TokenError) {
    return fail(res, 401, err.message, 'UNAUTHENTICATED')
  }
  handleUnexpected(res, err)
}

authRouter.post('/auth/line/session', sessionLimiter, async (req: Request, res: Response) => {
  const idToken = readString(req.body, 'idToken')
  if (idToken === null) return fail(res, 400, 'idToken is required')

  try {
    const lineUserId = await verifyLineIdToken(idToken)
    const employee = await findEmployeeByLineUserId(lineUserId)

    // LINE vouched for them, so this is not an authentication failure — we
    // simply do not know who they are yet. liff/ reads the code and shows the
    // link screen rather than an error.
    if (!employee) {
      return fail(res, 403, 'this LINE account is not linked to an employee', 'NOT_LINKED')
    }

    const { token, expiresAt } = await issueSession(employee.id)
    res.json(sessionBody(token, expiresAt, employee))
  } catch (err) {
    failVerify(res, err)
  }
})

authRouter.post('/auth/line/link', linkLimiter, async (req: Request, res: Response) => {
  const idToken = readString(req.body, 'idToken')
  if (idToken === null) return fail(res, 400, 'idToken is required')
  const code = readString(req.body, 'code')
  if (code === null) return fail(res, 400, 'code is required')

  try {
    const lineUserId = await verifyLineIdToken(idToken)

    const result = await withTransaction(async (client) => {
      // This LINE account may already speak for someone. The UNIQUE index would
      // catch it anyway, but a caught constraint violation cannot tell the
      // caller anything useful, and this can.
      const existing = await findEmployeeByLineUserId(lineUserId, client)
      if (existing) return { ok: false as const, reason: 'already-linked' as const }

      // Claiming the code and marking it used are the same statement: two
      // requests racing on one code both run this, and only the first matches
      // `used_at IS NULL`, because the row is locked until the transaction ends.
      const { rows } = await client.query<{ employee_id: string }>(
        `UPDATE employee_link_codes
         SET used_at = now()
         WHERE code_hash = $1 AND used_at IS NULL AND expires_at > now()
         RETURNING employee_id`,
        [hashLinkCode(code)]
      )
      const claimed = rows[0]
      if (!claimed) return { ok: false as const, reason: 'bad-code' as const }

      const employeeId = Number(claimed.employee_id)
      // `line_user_id IS NULL` is the guard against a second code, issued for an
      // employee who has since linked, being redeemed to overwrite them.
      const { rowCount } = await client.query(
        `UPDATE employees SET line_user_id = $2, updated_at = now()
         WHERE id = $1 AND line_user_id IS NULL`,
        [employeeId, lineUserId]
      )
      if (rowCount === 0) return { ok: false as const, reason: 'already-linked' as const }

      // The actor is the employee, not the HR user who issued the code: they
      // are the one who acted, and the issuing is already its own entry.
      // The LINE user id stays out of the detail — it identifies a person on a
      // platform we do not control, and the employees row already holds it.
      await recordAudit(client, {
        actor: { kind: 'employee', employeeId },
        action: 'employee.line_linked',
        entityId: employeeId,
      })

      return { ok: true as const, employeeId }
    })

    if (!result.ok) {
      if (result.reason === 'already-linked') {
        return fail(res, 409, 'this account is already linked')
      }
      // One answer for expired, already used, and never existed. Telling them
      // apart would let someone with a list of guesses learn which codes are
      // real, and none of the three changes what the employee should do: ask HR.
      return fail(res, 400, 'link code is not valid')
    }

    const employee = await findEmployeeById(result.employeeId)
    if (!employee) throw new Error(`linked employee ${result.employeeId} disappeared`)

    const { token, expiresAt } = await issueSession(employee.id)
    // Straight into a session: someone who just proved who they are should not
    // then be asked to prove it again.
    const body: LineLinkResponse = sessionBody(token, expiresAt, employee)
    res.status(201).json(body)
  } catch (err) {
    failVerify(res, err)
  }
})
