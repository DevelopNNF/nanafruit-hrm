// The one entry point route handlers (and attendanceDigest.ts) call:
// notify(event). Resolves who should hear about a NotificationEvent, sends
// it on the right channel, and logs the outcome — never throwing, per the
// fire-and-forget MVP decision.
//
// Call this AFTER the transaction that made the change has committed, with
// the default pool (not the transaction's client): an outbound HTTP call has
// no business holding a Postgres transaction, or its row locks, open.

import type pg from 'pg'
import { pool } from '../db.js'
import { notificationsConfig } from './config.js'
import { findEmployeeDisplayName, findLineUserIdForEmployee } from './recipients.js'
import { sendLinePush } from './channels/line.js'
import { sendEmailViaPowerAutomate } from './channels/email.js'
import { logNotificationAttempt } from './log.js'
import {
  attendanceDigestHrEmail,
  attendanceDigestLineText,
  cancelledLineText,
  decisionLineText,
  hrPendingApprovalEmail,
  pendingApprovalLineText,
} from './templates.js'
import type { NotificationEvent } from './types.js'

type Queryable = Pick<pg.Pool, 'query'>

export async function notify(event: NotificationEvent, db: Queryable = pool): Promise<void> {
  if (!notificationsConfig.enabled) return

  try {
    switch (event.kind) {
      case 'created': {
        const eventType = `${event.resource}.${event.kind}`
        if (event.supervisorEmployeeId !== null) {
          const requesterName = await resolveRequesterName(db, event.requesterEmployeeId)
          await dispatchLine(
            db,
            eventType,
            event.supervisorEmployeeId,
            pendingApprovalLineText(event.resource, requesterName)
          )
        } else {
          // No supervisor stage at all — the request is already waiting on
          // HR the moment it's created.
          const requesterName = await resolveRequesterName(db, event.requesterEmployeeId)
          await dispatchHrEmail(
            db,
            eventType,
            hrPendingApprovalEmail(event.resource, requesterName, event.requestId)
          )
        }
        return
      }
      case 'supervisor_approved': {
        const eventType = `${event.resource}.${event.kind}`
        const requesterName = await resolveRequesterName(db, event.requesterEmployeeId)
        await dispatchHrEmail(
          db,
          eventType,
          hrPendingApprovalEmail(event.resource, requesterName, event.requestId)
        )
        return
      }
      case 'approved': {
        const eventType = `${event.resource}.${event.kind}`
        await dispatchLine(
          db,
          eventType,
          event.requesterEmployeeId,
          decisionLineText(event.resource, 'approved', null)
        )
        return
      }
      case 'rejected': {
        const eventType = `${event.resource}.${event.kind}`
        await dispatchLine(
          db,
          eventType,
          event.requesterEmployeeId,
          decisionLineText(event.resource, 'rejected', event.reason)
        )
        return
      }
      case 'cancelled': {
        // Nothing was actually waiting on anyone — skip without logging a
        // notification that was never going to have a recipient.
        if (event.supervisorEmployeeId === null) return
        const eventType = `${event.resource}.${event.kind}`
        const requesterName = await resolveRequesterName(db, event.requesterEmployeeId)
        await dispatchLine(
          db,
          eventType,
          event.supervisorEmployeeId,
          cancelledLineText(event.resource, requesterName)
        )
        return
      }
      case 'attendance_digest_supervisor': {
        await dispatchLine(
          db,
          event.kind,
          event.supervisorEmployeeId,
          attendanceDigestLineText(event.workDate, event.issues)
        )
        return
      }
      case 'attendance_digest_hr': {
        await dispatchHrEmail(db, event.kind, attendanceDigestHrEmail(event.workDate, event.issues))
        return
      }
    }
  } catch (err) {
    // Should be unreachable — dispatchLine/dispatchHrEmail catch their own
    // failures — but notify() must never throw regardless of what changes
    // underneath it later.
    console.error('notification dispatch crashed unexpectedly', event.kind, err)
  }
}

/** Falls back rather than failing outright. employee_id is a NOT NULL FK on
 *  every request table, so a live request row without a matching employees
 *  row should be impossible — but a notification's wording is not the place
 *  to surface that if it somehow happens anyway. */
async function resolveRequesterName(db: Queryable, employeeId: number): Promise<string> {
  return (await findEmployeeDisplayName(employeeId, db)) ?? `พนักงาน #${employeeId}`
}

async function dispatchLine(db: Queryable, eventType: string, employeeId: number, text: string): Promise<void> {
  const lineUserId = await findLineUserIdForEmployee(employeeId, db)
  if (!lineUserId) {
    await logNotificationAttempt(db, {
      eventType,
      channel: 'line',
      recipient: null,
      status: 'skipped',
      errorMessage: `employee ${employeeId} has no linked LINE account`,
    })
    return
  }

  const result = await sendLinePush(lineUserId, text)
  await logNotificationAttempt(db, {
    eventType,
    channel: 'line',
    recipient: lineUserId,
    status: result.ok ? 'sent' : 'failed',
    errorMessage: result.ok ? null : result.error,
  })
}

// No recipient list to check here — Power Automate's own "Send an email"
// step owns who's on it, so unlike dispatchLine there's no "skipped, no one
// to send to" case: every call either reaches the flow or fails outright.
async function dispatchHrEmail(
  db: Queryable,
  eventType: string,
  content: { subject: string; bodyHtml: string }
): Promise<void> {
  const result = await sendEmailViaPowerAutomate(content)
  await logNotificationAttempt(db, {
    eventType,
    channel: 'email',
    // Not a real address — who actually receives this is configured inside
    // the Power Automate flow, invisible to us. Kept distinct from null so
    // this never reads like the "skipped, no recipient" case.
    recipient: 'power-automate-managed',
    status: result.ok ? 'sent' : 'failed',
    errorMessage: result.ok ? null : result.error,
  })
}
