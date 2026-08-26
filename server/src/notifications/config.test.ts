import { strict as assert } from 'node:assert'
import { afterEach, describe, it } from 'node:test'
import { notificationsConfig } from './config.js'

const ENV_KEYS = ['NOTIFICATIONS_ENABLED', 'LINE_CHANNEL_ACCESS_TOKEN', 'POWER_AUTOMATE_WEBHOOK_URL'] as const

const originalValues = new Map(ENV_KEYS.map((key) => [key, process.env[key]]))

afterEach(() => {
  for (const key of ENV_KEYS) {
    const original = originalValues.get(key)
    if (original === undefined) delete process.env[key]
    else process.env[key] = original
  }
})

describe('notificationsConfig.enabled', () => {
  it('defaults to off when unset', () => {
    delete process.env['NOTIFICATIONS_ENABLED']
    assert.equal(notificationsConfig.enabled, false)
  })

  it('is on only for the literal string "true", case-insensitively', () => {
    process.env['NOTIFICATIONS_ENABLED'] = 'true'
    assert.equal(notificationsConfig.enabled, true)
    process.env['NOTIFICATIONS_ENABLED'] = 'TRUE'
    assert.equal(notificationsConfig.enabled, true)
    process.env['NOTIFICATIONS_ENABLED'] = '1'
    assert.equal(notificationsConfig.enabled, false)
  })
})

describe('notificationsConfig secrets', () => {
  it('is null when unset or blank', () => {
    delete process.env['LINE_CHANNEL_ACCESS_TOKEN']
    assert.equal(notificationsConfig.lineChannelAccessToken, null)
    process.env['POWER_AUTOMATE_WEBHOOK_URL'] = '   '
    assert.equal(notificationsConfig.powerAutomateWebhookUrl, null)
  })

  it('trims whitespace when set', () => {
    process.env['LINE_CHANNEL_ACCESS_TOKEN'] = '  abc123  '
    assert.equal(notificationsConfig.lineChannelAccessToken, 'abc123')
  })
})
