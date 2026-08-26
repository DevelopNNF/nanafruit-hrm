// Writes one row per notification attempt to notification_log. See the
// migration (068) for why this exists instead of a retry queue: fire-and-
// forget for the MVP, this table is purely for after-the-fact visibility.

import type pg from 'pg'

type Queryable = Pick<pg.Pool, 'query'>

export type NotificationLogStatus = 'sent' | 'failed' | 'skipped'
export type NotificationChannel = 'line' | 'email'

export async function logNotificationAttempt(
  db: Queryable,
  entry: {
    eventType: string
    channel: NotificationChannel
    recipient: string | null
    status: NotificationLogStatus
    errorMessage?: string | null
    detail?: Record<string, unknown>
  }
): Promise<void> {
  await db.query(
    `INSERT INTO notification_log (event_type, channel, recipient, status, error_message, detail)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      entry.eventType,
      entry.channel,
      entry.recipient,
      entry.status,
      entry.errorMessage ?? null,
      entry.detail ?? null,
    ]
  )
}
