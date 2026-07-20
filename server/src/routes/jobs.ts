import { Router } from 'express'
import type { Request, Response } from 'express'
import {
  ROLES,
  type AuthUser,
  type JobInput,
  type JobListResponse,
  type JobResponse,
} from '@hrm/shared'
import { pool, withTransaction } from '../db.js'
import { requireRole } from '../auth/middleware.js'
import { recordAudit } from '../audit.js'
import { fail, handleUnexpected } from '../http.js'
import { SELECT_JOB, findJobById, rowToJob, type JobRow } from '../jobQueries.js'

export const jobsRouter = Router()

// Same split as employees: any HRM role can read the job list, only HR and
// Admin can change it.
const canRead = requireRole(...ROLES)
const canWrite = requireRole('HRM.HR', 'HRM.Admin')

function actorOf(req: Request): AuthUser | null {
  return req.auth ?? null
}

type ParseResult<T> = { ok: true; value: T } | { ok: false; message: string }

function requiredString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key]
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

/** Absent, null and '' all mean "none" for the optional text fields. */
function optionalString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key]
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

function parseJobInput(body: unknown): ParseResult<JobInput> {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, message: 'body must be a JSON object' }
  }
  const raw = body as Record<string, unknown>

  const jobTitle = requiredString(raw, 'jobTitle')
  if (jobTitle === null) return { ok: false, message: 'jobTitle is required' }

  const isActiveRaw = raw['isActive']
  if (typeof isActiveRaw !== 'boolean') {
    return { ok: false, message: 'isActive must be a boolean' }
  }

  return {
    ok: true,
    value: {
      jobTitle,
      jobDescription: optionalString(raw, 'jobDescription'),
      workInstruction: optionalString(raw, 'workInstruction'),
      isActive: isActiveRaw,
    },
  }
}

function parseId(value: string | string[] | undefined): number | null {
  if (typeof value !== 'string') return null
  const id = Number(value)
  return Number.isInteger(id) && id > 0 ? id : null
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' && err !== null && (err as { code?: unknown }).code === '23505'
  )
}

jobsRouter.get('/jobs', canRead, async (_req: Request, res: Response) => {
  try {
    const { rows } = await pool.query<JobRow>(`${SELECT_JOB} ORDER BY job_title`)
    const body: JobListResponse = { jobs: rows.map(rowToJob) }
    res.json(body)
  } catch (err) {
    handleUnexpected(res, err)
  }
})

jobsRouter.get('/jobs/:id', canRead, async (req: Request, res: Response) => {
  const id = parseId(req.params['id'])
  if (id === null) return fail(res, 400, 'id must be a positive integer')

  try {
    const job = await findJobById(id)
    if (!job) return fail(res, 404, `no job with id ${id}`)

    const body: JobResponse = { job }
    res.json(body)
  } catch (err) {
    handleUnexpected(res, err)
  }
})

jobsRouter.post('/jobs', canWrite, async (req: Request, res: Response) => {
  const actor = actorOf(req)
  if (!actor) return fail(res, 500, 'server misconfigured')

  const parsed = parseJobInput(req.body)
  if (!parsed.ok) return fail(res, 400, parsed.message)
  const input = parsed.value

  try {
    const job = await withTransaction(async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO master_jobs (job_title, job_description, work_instruction, is_active)
         VALUES ($1, $2, $3, $4)
         RETURNING id`,
        [input.jobTitle, input.jobDescription, input.workInstruction, input.isActive]
      )
      const created = rows[0]
      if (!created) throw new Error('insert into master_jobs returned no id')

      await recordAudit(client, {
        actor,
        action: 'job.create',
        entityId: Number(created.id),
        detail: { jobTitle: input.jobTitle },
      })

      return { ...input, id: Number(created.id) } satisfies JobResponse['job']
    })

    const body: JobResponse = { job }
    res.status(201).json(body)
  } catch (err) {
    if (isUniqueViolation(err)) {
      return fail(res, 409, `job title "${input.jobTitle}" is already taken`)
    }
    handleUnexpected(res, err)
  }
})

// PUT, not PATCH: the body is a complete job, matching the employees route.
jobsRouter.put('/jobs/:id', canWrite, async (req: Request, res: Response) => {
  const actor = actorOf(req)
  if (!actor) return fail(res, 500, 'server misconfigured')

  const id = parseId(req.params['id'])
  if (id === null) return fail(res, 400, 'id must be a positive integer')

  const parsed = parseJobInput(req.body)
  if (!parsed.ok) return fail(res, 400, parsed.message)
  const input = parsed.value

  try {
    const updated = await withTransaction(async (client) => {
      const { rowCount } = await client.query(
        `UPDATE master_jobs SET
           job_title = $2, job_description = $3,
           work_instruction = $4, is_active = $5, updated_at = now()
         WHERE id = $1`,
        [id, input.jobTitle, input.jobDescription, input.workInstruction, input.isActive]
      )
      if (rowCount === 0) return false

      await recordAudit(client, {
        actor,
        action: 'job.update',
        entityId: id,
        detail: { jobTitle: input.jobTitle },
      })
      return true
    })

    if (!updated) return fail(res, 404, `no job with id ${id}`)

    const body: JobResponse = { job: { ...input, id } }
    res.json(body)
  } catch (err) {
    if (isUniqueViolation(err)) {
      return fail(res, 409, `job title "${input.jobTitle}" is already taken`)
    }
    handleUnexpected(res, err)
  }
})
