import { Router } from 'express'
import type { Request, Response } from 'express'
import type { MeResponse } from '@hrm/shared'
import { authenticate } from '../auth/middleware.js'
import { fail } from '../http.js'

export const meRouter = Router()

// What the frontends call on boot to find out who they are talking on behalf of
// and which parts of the UI to show. Deliberately role-free: any authenticated
// caller may ask about themselves, even one with no HRM role — that answer is
// exactly what tells admin/ to render "contact IT" instead of an empty table.
meRouter.get('/me', authenticate, (req: Request, res: Response) => {
  const auth = req.auth
  // authenticate either sets this or has already answered. Narrowing, not a check.
  if (!auth) return fail(res, 500, 'server misconfigured')

  const body: MeResponse = { user: auth }
  res.json(body)
})
