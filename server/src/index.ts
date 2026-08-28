import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import { pool } from './db.js'
import { healthRouter } from './routes/health.js'
import { employeesRouter } from './routes/employees.js'
import { employeeImportRouter } from './routes/employeeImport.js'
import { employeeExportRouter } from './routes/employeeExport.js'
import { jobsRouter } from './routes/jobs.js'
import { departmentsRouter } from './routes/departments.js'
import { shiftsRouter } from './routes/shifts.js'
import { locationsRouter } from './routes/locations.js'
import { attendanceRouter } from './routes/attendance.js'
import { attendanceImportRouter } from './routes/attendanceImport.js'
import { timeCorrectionsRouter } from './routes/timeCorrections.js'
import { leaveTypesRouter } from './routes/leaveTypes.js'
import { holidayGroupsRouter } from './routes/holidayGroups.js'
import { holidaysRouter } from './routes/holidays.js'
import { overtimeGroupsRouter } from './routes/overtimeGroups.js'
import { financeItemsRouter } from './routes/financeItems.js'
import { payrollGroupsRouter } from './routes/payrollGroups.js'
import { payrollPeriodsRouter } from './routes/payrollPeriods.js'
import { payrollEntriesRouter } from './routes/payrollEntries.js'
import { employeeFinanceItemsRouter } from './routes/employeeFinanceItems.js'
import { leaveBalancesRouter } from './routes/leaveBalances.js'
import { leaveRequestsRouter } from './routes/leaveRequests.js'
import { offSiteRequestsRouter } from './routes/offSiteRequests.js'
import { approvalsRouter } from './routes/approvals.js'
import { shiftChangeRequestsRouter } from './routes/shiftChangeRequests.js'
import { dayOffSwapRequestsRouter } from './routes/dayOffSwapRequests.js'
import { overtimeRequestsRouter } from './routes/overtimeRequests.js'
import { overtimeReportRouter } from './routes/overtimeReport.js'
import { calendarRouter } from './routes/calendar.js'
import { scheduleRouter } from './routes/schedule.js'
import { meRouter } from './routes/me.js'
import { authRouter } from './routes/auth.js'
import { cronRouter } from './routes/cron.js'
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
// /api/cron is open to `authenticate` for a third reason: the caller is an
// external scheduler with no Entra account and no LINE session, so it proves
// itself with a shared secret the route checks itself. See routes/cron.ts.
app.use('/api', cronRouter)
// Before employeesRouter for the same reason attendanceImportRouter sits
// before attendanceRouter: its own express.raw body parser is scoped to just
// these two paths, so the global express.json above never sees an .xlsx
// upload.
app.use('/api', authenticate, employeeImportRouter)
app.use('/api', authenticate, employeeExportRouter)
app.use('/api', authenticate, employeesRouter)
app.use('/api', authenticate, jobsRouter)
app.use('/api', authenticate, departmentsRouter)
app.use('/api', authenticate, shiftsRouter)
app.use('/api', authenticate, locationsRouter)
// Before attendanceRouter: its GET /attendance/daily and this router's
// /attendance/import paths do not collide, but keeping the import's own body
// parser next to its routes means the global express.json above never sees an
// .xlsx upload.
app.use('/api', authenticate, attendanceImportRouter)
app.use('/api', authenticate, attendanceRouter)
app.use('/api', authenticate, timeCorrectionsRouter)
app.use('/api', authenticate, leaveTypesRouter)
app.use('/api', authenticate, holidayGroupsRouter)
app.use('/api', authenticate, holidaysRouter)
app.use('/api', authenticate, overtimeGroupsRouter)
app.use('/api', authenticate, payrollGroupsRouter)
app.use('/api', authenticate, payrollPeriodsRouter)
app.use('/api', authenticate, payrollEntriesRouter)
app.use('/api', authenticate, financeItemsRouter)
app.use('/api', authenticate, employeeFinanceItemsRouter)
app.use('/api', authenticate, leaveBalancesRouter)
app.use('/api', authenticate, leaveRequestsRouter)
app.use('/api', authenticate, offSiteRequestsRouter)
app.use('/api', authenticate, approvalsRouter)
app.use('/api', authenticate, shiftChangeRequestsRouter)
app.use('/api', authenticate, dayOffSwapRequestsRouter)
app.use('/api', authenticate, overtimeRequestsRouter)
app.use('/api', authenticate, overtimeReportRouter)
app.use('/api', authenticate, calendarRouter)
app.use('/api', authenticate, scheduleRouter)

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
