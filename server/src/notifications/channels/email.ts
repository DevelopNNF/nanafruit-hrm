// Sending an email by handing it to a Power Automate flow, not an SMTP/Graph
// call of our own. The flow owns the "When a HTTP request is received"
// trigger and the Office 365 Outlook "Send an email" step; this file only
// has to agree with it on a JSON shape.
//
// Deliberately no recipient in that shape: the flow's "Send an email" step
// has its own To field (static, or pulled from a SharePoint/Excel list) —
// so HR can be added, removed, or corrected entirely inside Power Automate,
// with no server deploy. See notification-system-plan memory for why this
// replaced an earlier HR_NOTIFY_EMAILS env var.

import { notificationsConfig } from '../config.js'

export type ChannelSendResult = { ok: true } | { ok: false; error: string }

export async function sendEmailViaPowerAutomate(params: {
  subject: string
  bodyHtml: string
}): Promise<ChannelSendResult> {
  const url = notificationsConfig.powerAutomateWebhookUrl
  if (!url) return { ok: false, error: 'POWER_AUTOMATE_WEBHOOK_URL not configured' }

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subject: params.subject, bodyHtml: params.bodyHtml }),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      return { ok: false, error: `Power Automate webhook failed: ${res.status} ${body.slice(0, 500)}` }
    }
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
