// Exercises notify()'s routing (which event goes to which recipient on
// which channel) and its fire-and-forget contract, without touching a real
// database or a real LINE/Power Automate endpoint: db is a small in-memory
// fake and fetch is stubbed per test.

import { strict as assert } from 'node:assert'
import { afterEach, beforeEach, describe, it } from 'node:test'
import type pg from 'pg'
import { notify } from './dispatch.js'
import type { RequestActionEvent } from './types.js'

type Queryable = Pick<pg.Pool, 'query'>

type LoggedRow = {
  event_type: string
  channel: string
  recipient: string | null
  status: string
  error_message: string | null
}

function fakeDb(employees: Record<number, { lineUserId?: string | null; name?: string | null }>) {
  const logged: LoggedRow[] = []
  const db = {
    query: async (...args: unknown[]) => {
      const text = args[0] as string
      const params = (args[1] ?? []) as unknown[]
      if (text.includes('SELECT line_user_id')) {
        const employeeId = params[0] as number
        return { rows: [{ line_user_id: employees[employeeId]?.lineUserId ?? null }] }
      }
      if (text.includes('AS name')) {
        const employeeId = params[0] as number
        return { rows: [{ name: employees[employeeId]?.name ?? null }] }
      }
      if (text.includes('INSERT INTO notification_log')) {
        const [event_type, channel, recipient, status, error_message] = params as [
          string,
          string,
          string | null,
          string,
          string | null,
        ]
        logged.push({ event_type, channel, recipient, status, error_message })
        return { rows: [] }
      }
      throw new Error(`fakeDb: unexpected query: ${text}`)
    },
  }
  return { db: db as unknown as Queryable, logged }
}

const originalEnv = {
  NOTIFICATIONS_ENABLED: process.env['NOTIFICATIONS_ENABLED'],
  LINE_CHANNEL_ACCESS_TOKEN: process.env['LINE_CHANNEL_ACCESS_TOKEN'],
  POWER_AUTOMATE_WEBHOOK_URL: process.env['POWER_AUTOMATE_WEBHOOK_URL'],
}
const originalFetch = globalThis.fetch

beforeEach(() => {
  process.env['NOTIFICATIONS_ENABLED'] = 'true'
  process.env['LINE_CHANNEL_ACCESS_TOKEN'] = 'test-line-token'
  process.env['POWER_AUTOMATE_WEBHOOK_URL'] = 'https://example.test/power-automate'
})

afterEach(() => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  globalThis.fetch = originalFetch
})

describe('notify — kill switch', () => {
  it('does nothing at all when NOTIFICATIONS_ENABLED is not "true"', async () => {
    process.env['NOTIFICATIONS_ENABLED'] = 'false'
    let fetchCalled = false
    globalThis.fetch = (async () => {
      fetchCalled = true
      return new Response(null, { status: 200 })
    }) as typeof fetch

    const { db, logged } = fakeDb({ 5: { lineUserId: 'U123' } })
    const event: RequestActionEvent = {
      kind: 'created',
      resource: 'leave_request',
      requestId: 1,
      requesterEmployeeId: 1,
      supervisorEmployeeId: 5,
    }
    await notify(event, db)

    assert.equal(fetchCalled, false)
    assert.deepEqual(logged, [])
  })
})

describe('notify — created', () => {
  it('pushes LINE to the supervisor when one is snapshotted and linked, naming the requester', async () => {
    let capturedBody: unknown
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      capturedBody = JSON.parse(init.body as string)
      return new Response(null, { status: 200 })
    }) as typeof fetch

    const { db, logged } = fakeDb({
      1: { name: 'นางสาวสมหญิง ใจดี' },
      5: { lineUserId: 'U123' },
    })
    const event: RequestActionEvent = {
      kind: 'created',
      resource: 'leave_request',
      requestId: 1,
      requesterEmployeeId: 1,
      supervisorEmployeeId: 5,
    }
    await notify(event, db)

    const text = (capturedBody as { to: string; messages: { text: string }[] }).messages[0]?.text ?? ''
    assert.equal((capturedBody as { to: string }).to, 'U123')
    assert.match(text, /นางสาวสมหญิง ใจดี/)
    assert.equal(logged.length, 1)
    assert.deepEqual(logged[0], {
      event_type: 'leave_request.created',
      channel: 'line',
      recipient: 'U123',
      status: 'sent',
      error_message: null,
    })
  })

  it('logs a skip, without calling fetch, when the supervisor has no linked LINE account', async () => {
    let fetchCalled = false
    globalThis.fetch = (async () => {
      fetchCalled = true
      return new Response(null, { status: 200 })
    }) as typeof fetch

    const { db, logged } = fakeDb({ 5: { lineUserId: null } })
    const event: RequestActionEvent = {
      kind: 'created',
      resource: 'overtime_request',
      requestId: 2,
      requesterEmployeeId: 2,
      supervisorEmployeeId: 5,
    }
    await notify(event, db)

    assert.equal(fetchCalled, false)
    assert.equal(logged[0]?.status, 'skipped')
    assert.equal(logged[0]?.channel, 'line')
  })

  it('emails via Power Automate instead of a supervisor when supervisorEmployeeId is null, with no recipient in the payload', async () => {
    let capturedBody: unknown
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      capturedBody = JSON.parse(init.body as string)
      return new Response(null, { status: 200 })
    }) as typeof fetch

    const { db, logged } = fakeDb({ 3: { name: 'นายสมชาย ใจดี' } })
    const event: RequestActionEvent = {
      kind: 'created',
      resource: 'shift_change_request',
      requestId: 3,
      requesterEmployeeId: 3,
      supervisorEmployeeId: null,
    }
    await notify(event, db)

    // No "to" field at all — recipients live inside the Power Automate flow,
    // not in what the server posts to it.
    assert.equal('to' in (capturedBody as object), false)
    assert.match((capturedBody as { subject: string }).subject, /นายสมชาย ใจดี/)
    assert.equal(logged[0]?.channel, 'email')
    assert.equal(logged[0]?.status, 'sent')
    assert.equal(logged[0]?.recipient, 'power-automate-managed')
  })

  it('falls back to a placeholder name rather than failing when the employee row is somehow missing', async () => {
    let capturedBody: unknown
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      capturedBody = JSON.parse(init.body as string)
      return new Response(null, { status: 200 })
    }) as typeof fetch

    const { db } = fakeDb({ 5: { lineUserId: 'U123' } })
    const event: RequestActionEvent = {
      kind: 'created',
      resource: 'leave_request',
      requestId: 1,
      requesterEmployeeId: 999,
      supervisorEmployeeId: 5,
    }
    await notify(event, db)

    const text = (capturedBody as { messages: { text: string }[] }).messages[0]?.text ?? ''
    assert.match(text, /พนักงาน #999/)
  })
})

describe('notify — rejected', () => {
  it('pushes LINE to the requester with the reason, without a name lookup', async () => {
    let capturedBody: unknown
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      capturedBody = JSON.parse(init.body as string)
      return new Response(null, { status: 200 })
    }) as typeof fetch

    const { db } = fakeDb({ 9: { lineUserId: 'U999' } })
    const event: RequestActionEvent = {
      kind: 'rejected',
      resource: 'time_correction_request',
      requestId: 4,
      requesterEmployeeId: 9,
      reason: 'เอกสารไม่ครบ',
    }
    await notify(event, db)

    const text = (capturedBody as { messages: { text: string }[] }).messages[0]?.text ?? ''
    assert.match(text, /เอกสารไม่ครบ/)
  })
})

describe('notify — cancelled', () => {
  it('is a no-op, with nothing logged, when no supervisor was ever waiting', async () => {
    let fetchCalled = false
    globalThis.fetch = (async () => {
      fetchCalled = true
      return new Response(null, { status: 200 })
    }) as typeof fetch

    const { db, logged } = fakeDb({})
    const event: RequestActionEvent = {
      kind: 'cancelled',
      resource: 'day_off_swap_request',
      requestId: 5,
      requesterEmployeeId: 1,
      supervisorEmployeeId: null,
    }
    await notify(event, db)

    assert.equal(fetchCalled, false)
    assert.deepEqual(logged, [])
  })
})

describe('notify — delivery failure', () => {
  it('logs status "failed" with the error, and does not throw', async () => {
    globalThis.fetch = (async () => new Response('token expired', { status: 401 })) as typeof fetch

    const { db, logged } = fakeDb({ 5: { lineUserId: 'U123' } })
    const event: RequestActionEvent = {
      kind: 'created',
      resource: 'leave_request',
      requestId: 1,
      requesterEmployeeId: 1,
      supervisorEmployeeId: 5,
    }
    await assert.doesNotReject(notify(event, db))

    assert.equal(logged[0]?.status, 'failed')
    assert.match(logged[0]?.error_message ?? '', /401/)
  })
})
