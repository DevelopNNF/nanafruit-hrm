import { Router } from 'express'
import type { HealthError, HealthOk } from '@hrm/shared'
import { pingDatabase } from '../db.js'

export const healthRouter = Router()

healthRouter.get('/health', async (_req, res) => {
  try {
    const { database, serverTime } = await pingDatabase()
    const body: HealthOk = {
      status: 'ok',
      database,
      serverTime: serverTime.toISOString(),
    }
    res.json(body)
  } catch (err) {
    // A reachable API that cannot reach its database is not healthy: 503, not 500.
    const body: HealthError = {
      status: 'error',
      message: err instanceof Error ? err.message : 'unknown database error',
    }
    res.status(503).json(body)
  }
})
