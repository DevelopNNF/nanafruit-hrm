// Pushing a single text message through the LINE Messaging API. Uses the
// runtime's built-in fetch (Node 24+) rather than a line-bot-sdk dependency —
// one POST doesn't need a client library.

import { notificationsConfig } from '../config.js'

const LINE_PUSH_URL = 'https://api.line.me/v2/bot/message/push'

export type ChannelSendResult = { ok: true } | { ok: false; error: string }

export async function sendLinePush(lineUserId: string, text: string): Promise<ChannelSendResult> {
  const token = notificationsConfig.lineChannelAccessToken
  if (!token) return { ok: false, error: 'LINE_CHANNEL_ACCESS_TOKEN not configured' }

  try {
    const res = await fetch(LINE_PUSH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ to: lineUserId, messages: [{ type: 'text', text }] }),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      return { ok: false, error: `LINE push failed: ${res.status} ${body.slice(0, 500)}` }
    }
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
