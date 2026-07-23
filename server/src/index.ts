import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import { pool } from './db.js'
import { healthRouter } from './routes/health.js'
import { employeesRouter } from './routes/employees.js'
import { jobsRouter } from './routes/jobs.js'
import { shiftsRouter } from './routes/shifts.js'
import { locationsRouter } from './routes/locations.js'
import { attendanceRouter } from './routes/attendance.js'
import { timeCorrectionsRouter } from './routes/timeCorrections.js'
import { leaveTypesRouter } from './routes/leaveTypes.js'
import { holidayGroupsRouter } from './routes/holidayGroups.js'
import { holidaysRouter } from './routes/holidays.js'
import { meRouter } from './routes/me.js'
import { authRouter } from './routes/auth.js'
import { authenticate } from './auth/middleware.js'

const app = express()

/**
 * How many reverse proxies sit in front of us.
 *
 * The rate limiter keys on req.ip, and Express only believes X-Forwarded-For if
 * told to. Both ways of getting this wrong are bad: too low and every caller
 * behind the load balancer shares one bucket, so the first busy phone locks out
 * the company; too high and anyone can forge the header and mint a fresh bucket
 * per request, so the limit is decorative. Hence a number, not a boolean, and a
 * default of 0 — which is the truth in dev, where nothing is in front of us.
 */
const trustProxy = Number(process.env.TRUST_PROXY ?? 0)
if (!Number.isInteger(trustProxy) || trustProxy < 0) {
  throw new Error('TRUST_PROXY must be a non-negative integer — see server/.env.example')
}
if (trustProxy > 0) app.set('trust proxy', trustProxy)

// Sensible security headers. Mostly aimed at HTML, which this never serves, but
// nosniff and HSTS apply to a JSON API too and cost nothing.
app.use(helmet())

// Two frontends now: admin (5173) and liff (5174). Comma-separated so deploys
// can name both real origins without a code change.
//
// This is an allowlist, not `origin: true`: with Bearer tokens rather than
// cookies, a wide-open CORS policy would not leak a session by itself, but it
// would let any page on the internet use a stolen token from the victim's own
// browser, and there is no reason to permit that.
const allowedOrigins = (
  process.env.CORS_ORIGIN ?? 'http://localhost:5173,http://localhost:5174'
)
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean)

app.use(cors({ origin: allowedOrigins }))
app.use(express.json())
// health stays open: it is what a load balancer polls, and it reveals nothing
// but whether the database answers. /api/auth is open for a different reason —
// it is where liff/ goes to *get* a token, and it carries a LINE ID token of its
// own that it verifies before doing anything. Everything past those needs one.
app.use('/api', healthRouter)
app.use('/api', authRouter)
app.use('/api', meRouter)
app.use('/api', authenticate, employeesRouter)
app.use('/api', authenticate, jobsRouter)
app.use('/api', authenticate, shiftsRouter)
app.use('/api', authenticate, locationsRouter)
app.use('/api', authenticate, attendanceRouter)
app.use('/api', authenticate, timeCorrectionsRouter)
app.use('/api', authenticate, leaveTypesRouter)
app.use('/api', authenticate, holidayGroupsRouter)
app.use('/api', authenticate, holidaysRouter)

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
