import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import { pool } from './db.js'
import { healthRouter } from './routes/health.js'

const app = express()

// Two frontends now: admin (5173) and liff (5174). Comma-separated so deploys
// can name both real origins without a code change.
const allowedOrigins = (
  process.env.CORS_ORIGIN ?? 'http://localhost:5173,http://localhost:5174'
)
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean)

app.use(cors({ origin: allowedOrigins }))
app.use(express.json())
app.use('/api', healthRouter)

const port = Number(process.env.PORT) || 3000
const server = app.listen(port, () => {
  console.log(`API listening on http://localhost:${port}`)
})

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close(() => {
      void pool.end().finally(() => process.exit(0))
    })
  })
}
