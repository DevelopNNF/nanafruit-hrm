// Recording who changed what.
//
// Always call this with the same client as the change itself, inside the same
// transaction. Writing the audit entry separately would mean a change could
// commit while its record rolls back — the one failure this table exists to
// prevent.

import type pg from 'pg'
import type { AuthUser } from '@hrm/shared'

type Queryable = Pick<pg.Pool, 'query'>

/**
 * Everything worth answering "who did this?" about. A union rather than a
 * string: an action this file has not heard of is a typo, and a typo is an
 * entry nobody will ever find again.
 */
export type AuditAction =
  | 'employee.create'
  | 'employee.update'
  | 'employee.delete'
  | 'employee.link_code_issued'
  | 'employee.line_linked'

type Entry = {
  actor: AuthUser
  action: AuditAction
  /** The employee the action happened to. */
  entityId: number
  /** Anything not worth a column. Must hold no secrets — see recordAudit. */
  detail?: Record<string, unknown>
}

export async function recordAudit(db: Queryable, entry: Entry): Promise<void> {
  const { actor, action, entityId, detail } = entry

  // The link code itself must never land here: the audit log would then hold a
  // live credential in plaintext, which is exactly what the hash in
  // employee_link_codes exists to avoid.
  const [actorId, actorLabel] =
    actor.kind === 'admin' ? [actor.oid, actor.upn] : [String(actor.employeeId), null]

  await db.query(
    `INSERT INTO audit_log (actor_kind, actor_id, actor_label, action, entity_id, detail)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [actor.kind, actorId, actorLabel, action, String(entityId), detail ?? null]
  )
}
