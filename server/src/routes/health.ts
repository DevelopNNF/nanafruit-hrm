import { Router } from 'express'
import { pingDatabase } from '../db.js'

export const healthRouter = Router()

healthRouter.get('/health', async (_req, res) => {
  try {
    const { database, serverTime } = await pingDatabase()
    res.json({
      status: 'ok',
      database,
      serverTime: serverTime.toISOString(),
    })
  } catch (err) {
    // A reachable API that cannot reach its database is not healthy: 503, not 500.
    res.status(503).json({
      status: 'error',
      message: err instanceof Error ? err.message : 'unknown database error',
    })
  }
})
