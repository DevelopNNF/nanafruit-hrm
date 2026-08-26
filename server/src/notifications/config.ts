// Notification settings — read fresh from process.env on every access,
// unlike auth/config.ts's authConfig, which reads once at module load and
// throws if anything required is missing.
//
// That fail-fast pattern is right for auth: a missing tenant or audience
// would mean silently accepting tokens it should reject. Nothing here is
// like that. The fire-and-forget MVP decision means a missing LINE token or
// Power Automate URL should make that one channel skip — and say why, in
// notification_log — not take the whole server down. Reading live also
// means a test can set/unset an env var per case without reimporting the
// module.

function optionalEnv(name: string): string | null {
  const value = process.env[name]?.trim()
  return value ? value : null
}

export const notificationsConfig = {
  /** Master kill switch. Off by default — see NOTIFICATIONS_ENABLED in
   *  .env.example for why. */
  get enabled(): boolean {
    return process.env['NOTIFICATIONS_ENABLED']?.trim().toLowerCase() === 'true'
  },
  get lineChannelAccessToken(): string | null {
    return optionalEnv('LINE_CHANNEL_ACCESS_TOKEN')
  },
  get powerAutomateWebhookUrl(): string | null {
    return optionalEnv('POWER_AUTOMATE_WEBHOOK_URL')
  },
} as const
